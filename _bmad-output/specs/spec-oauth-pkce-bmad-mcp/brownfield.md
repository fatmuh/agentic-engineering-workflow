# brownfield.md — Inventaris infra eksisting dan titik integrasi

Semua referensi file:line diverifikasi pada 2026-11-04, branch `feat/bmad-monitor-integration`. Downstream (bmad-build dkk.) membaca ini sebagai peta medan; jangan mengubah perilaku bagian yang bukan milik fitur ini.

## src/lib/jwt.ts — primitif JWT

- HS256 via `jose`, kunci `AUTH_SECRET` (env, wajib ada — modul fail-fast). Issuer `onyx-auth`.
- Pola klaim: `type: "access" | "refresh"`, `sub` = user id. `verifyAccessToken` (jwt.ts:75) TIDAK memeriksa `aud` — verifikator MCP baru harus `aud: "bmad-mcp"` agar token web tertolak; sebaliknya `verifyAccessToken` yang lama tidak akan menerima token MCP selama token web diverifikasi dari cookie (jalur berbeda, tidak tumpang tindih).
- `verifyRefreshToken` (jwt.ts:86) memeriksa `jti` — pattern siap reuse untuk refresh MCP.
- Konvensi penamaan baru yang disarankan: `signMcpAccessToken` / `signMcpRefreshToken` / `verifyMcpAccessToken` (klaim `aud` + `type`) — edge-safe, hanya `jose`.

## src/lib/auth.ts — siklus token web (pola yang dimirror)

- `issueTokenPair` (auth.ts:131): sign pair + persist `sha256(jti)` ke `refresh_tokens` + set cookie. MCP: versi tanpa cookie, return string.
- `rotateRefreshToken` (auth.ts:222): klaim atomik `UPDATE ... WHERE revoked_at IS NULL RETURNING`, grace window 30 detik untuk race dua tab (untuk MCP: single-flight mutex sudah di klien Go, grace window tetap aman dipertahankan), klasifikasi revoked_reason, reuse detection → `revokeAllUserTokens`.
- `revokeAllUserTokens` (auth.ts:176): pola revoke keluarga.
- Web access TTL 15 menit (jwt.ts:25) — JANGAN dipakai untuk MCP; MCP 2592000 detik sesuai kontrak.

## src/lib/db.ts — schema bootstrap idempotent

- `ensureSchema()` (db.ts:64) menjalankan blok v2 → v3 (RBAC) → v4 (wiki) → v5 (BMad Monitor: bmad_projects, bmad_context_files, bmad_tasks, bmad_agent_nodes, bmad_backlogs, bmad_llm_providers). **v5 sudah terpakai** — blok baru = **v6**, ditambahkan setelah blok v5 dalam `ensureSchema`, seluruhnya `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, komentar header blok menjelaskan versi.
- Tabel v6 yang dibutuhkan (rincian kolom minimum):

```sql
-- Schema v6: OAuth 2.0 PKCE untuk BMad Monitor MCP
CREATE TABLE IF NOT EXISTS oauth_codes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT NOT NULL UNIQUE,
  code_challenge      TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  redirect_uri        TEXT NOT NULL,
  client_id           TEXT NOT NULL DEFAULT 'bmad-mcp-cli',
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_code ON oauth_codes(code);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,      -- sha256(jti)
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_user_id ON oauth_refresh_tokens(user_id);
```

- Tabel refresh MCP terpisah dari `refresh_tokens` web: alasan revoke dan populasi berbeda; campur kolom client di tabel web mengubah kode jalur web yang bukan milik fitur ini.

## src/proxy.ts — routing (tidak berubah)

- Matcher (proxy.ts:72) men-skip seluruh `/api/**` → `POST /api/oauth/token` publik secara struktural; jangan menambah `/api/oauth` ke aturan mana pun.
- `/oauth/authorize` bukan API → kena matcher, tapi tidak ada di `PROTECTED_PREFIXES` → lolos proxy; halaman server component sendiri yang memanggil `getSessionUser()` dan redirect `/login?next=...` bila null.

## src/components/auth/ — kerangka halaman persetujuan

- `auth-shell.tsx` + `auth-field.tsx` + `password-input.tsx`: shell kartu terpusat yang dipakai /login, /register, /forgot-password. Halaman `/oauth/authorize` me-render auth-shell dengan konten persetujuan (bukan form password) + dua tombol (Authorize / Tolak).
- Pola halaman login untuk redirect `next`: simpan URL kembali, redirect pasca-login.

## Konsumen REST BMad (yang tak boleh rusak)

- `src/components/dashboard/agent-board-view.tsx:38-71,145,189` — fetch `/api/projects/prj_default/tasks` & `agent-tree` via cookie (tanpa Bearer). Dual-auth wajib.
- Endpoint yang dikunci CAP-4: `src/app/api/projects/route.ts`, `src/app/api/projects/[projectId]/**` (tasks, tasks/[taskId], tasks/batch, agent-tree, agent-tree/step, context-files), `src/app/api/llm-providers/route.ts`.
- Endpoint auth web (`/api/auth/*`), roles, users, storage, wiki — **tidak** disentuh (jalur cookie masing-masing sudah ada).

## RBAC (src/lib/permissions.ts)

- Katalog permission halaman web; tidak diperluas untuk MCP — otorisasi REST BMad berbasis identitas + isAllowed gate saja (lihat Open Questions SPEC). `SessionUser.permissions` tidak dibutuhkan klien MCP.

## Klien Go (baca-saja, beku)

- `internal/auth/oauth.go` — flow lengkap: listener loopback dinamis, state check (oauth.go:98), parse `error`/`error_description` callback (oauth.go:104), exchange authorization_code (oauth.go:164), grant refresh_token (oauth.go:250), cek `user.isAllowed` di kedua respons (oauth.go:197, 281), simpan `~/.bmad-monitor`, buffer refresh 30 detik sebelum `ExpiresAt`.
- `cmd/bmad-monitor/main.go`, `internal/client/api_client.go` — pemanggilan REST dengan Bearer; alasan seluruh fitur ini ada.
