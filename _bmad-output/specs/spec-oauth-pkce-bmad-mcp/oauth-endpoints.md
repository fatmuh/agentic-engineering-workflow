# oauth-endpoints.md — Kontrak detail kedua endpoint token

Kontrak lengkap `GET /oauth/authorize` dan `POST /api/oauth/token` termasuk semantik error. Bagian grant `authorization_code` berasal dari WEB_SPECIFICATION.md §1; grant `refresh_token` di-reverse-engineer dari klien Go (`tools/bmad-monitor-mcp/internal/auth/oauth.go`) dan **tidak ada** di WEB_SPEC — delta tercatat di bawah.

## GET /oauth/authorize

Query parameters (semua wajib; kurang satu → error `invalid_request`):

| Param | Nilai | Validasi |
|---|---|---|
| `response_type` | `code` | literal |
| `client_id` | `bmad-mcp-cli` | literal (satu-satunya client) |
| `redirect_uri` | `http://127.0.0.1:<port>/callback` | regex loopback: host wajib `127.0.0.1` (bukan `localhost`), port 1–65535 dinamis, path `/callback` |
| `state` | string acak | diteruskan verbatim di callback; tidak ditafsirkan server |
| `code_challenge` | base64url(SHA256(verifier)) | disimpan di `oauth_codes`, diverifikasi saat token exchange |
| `code_challenge_method` | `S256` | literal; `plain` ditolak |

Perilaku per keadaan sesi:

1. Tidak ada sesi web → redirect `/login?next=<url-authorize-yang-lengkap>`; setelah login kembali ke halaman ini.
2. Sesi ada, `users.status != 'Active'` → halaman pesan statis: "Akun Anda belum memiliki izin / allowance untuk mengakses BMad Workspace ini. Hubungi admin tim." — **tanpa** redirect callback, tanpa code.
3. Sesi ada & Active → halaman persetujuan (auth-shell) menampilkan identitas client (`bmad-mcp-cli`) dan user login; dua tombol:
   - **Authorize** → simpan `oauth_codes` (code acak cryptographic ≥128-bit, `code_challenge`, `redirect_uri`, `user_id`, `client_id`, `expires_at = now() + 60s`, `consumed_at = NULL`) lalu redirect `302` ke `<redirect_uri>?code=<code>&state=<state>`.
   - **Tolak** → redirect `302` ke `<redirect_uri>?error=access_denied&error_description=<pesan>` tanpa menyimpan code. (Callback handler klien menampilkan pesan gagal.)

## POST /api/oauth/token

Public (tanpa sesi). Content-Type `application/x-www-form-urlencoded`. Content-Type respons `application/json`.

### Grant `authorization_code` (dari WEB_SPEC §1B)

Body: `grant_type=authorization_code`, `client_id=bmad-mcp-cli`, `code`, `code_verifier`, `redirect_uri`.

Urutan validasi — kegagalan pertama menentukan error:

1. `grant_type`/`client_id` tak dikenal → `400 invalid_client` / `unsupported_grant_type`.
2. Ambil baris `oauth_codes WHERE code = $1` atomik: `UPDATE oauth_codes SET consumed_at = now() WHERE code = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING *` — rowCount 0 → `400 invalid_grant` (code kadaluarsa/sudah terpakai/tak dikenal). Konsumsi mendahului verifikasi PKCE: code yang gagal PKCE tetap hangus (anti brute-force verifier).
3. `redirect_uri` request ≠ `redirect_uri` tersimpan → `400 invalid_grant`.
4. `BASE64URL(SHA256(code_verifier))` ≠ `code_challenge` → `400 invalid_grant`.
5. Muat user; `status != 'Active'` → `403` `{ error: "access_denied" }` (tanpa token).

Respons `200`:

```json
{
  "access_token": "<JWT aud=bmad-mcp>",
  "refresh_token": "<JWT ber-jti>",
  "expires_in": 2592000,
  "token_type": "Bearer",
  "user": { "id": "...", "email": "...", "name": "...", "role": "...", "isAllowed": true, "teamId": "..." }
}
```

`user.id` = UUID string; `teamId` = kolom `users.team`; `isAllowed` = `(status = 'Active')`; `role` = `users.role`.

### Grant `refresh_token` (tercatat di WEB_SPEC §1C mulai 2026-11-04; semula delta hasil reverse-engineering klien Go)

Body: `grant_type=refresh_token`, `client_id=bmad-mcp-cli`, `refresh_token`. (Klien tidak mengirim `code_verifier`/`redirect_uri` di grant ini.)

1. Verifikasi JWT refresh (signature, issuer, expiry, type refresh) → gagal `400 invalid_grant`.
2. Klaim atomik `UPDATE <tabel-refresh-mcp> SET revoked_at = now(), revoked_reason='rotated' WHERE token_hash = sha256(jti) AND revoked_at IS NULL AND expires_at > now() RETURNING user_id` — rowCount 1 → teruskan; 0 → klasifikasi baris: rotasi dalam grace window → issue baru; rotasi lewat grace / alasan lain → `400 invalid_grant` + revoke keluarga (mirror `rotateRefreshToken` di src/lib/auth.ts). TTL refresh = 30 hari.
3. User tidak ada / `status != 'Active'` → `403` + revoke semua token MCP user.

Respons `200` — bentuk identik grant authorization_code (klien mem-parse `access_token`, `refresh_token`, `expires_in`, `user`; refresh kosong di respons diterima klien tapi token lama tetap hangus — selalu kirim refresh baru).

### Format error (kedua grant)

```json
{ "error": "invalid_grant", "error_description": "..." }
```

`error` ∈ `invalid_request | invalid_client | invalid_grant | unsupported_grant_type | access_denied`; HTTP 400, kecuali `access_denied` = 403. Klien Go menampilkan `error_description` (atau `error`) ke pengguna.

## Verifikasi Bearer (dipakai REST BMad)

Header `Authorization: Bearer <JWT>`: verifikasi signature HS256, issuer `onyx-auth`, `aud` **wajib** `bmad-mcp`, `type: "access"`, belum `exp` → identitas user dipetakan dari `sub`. Gagal salah satu → `401` tanpa body khusus. Token akses web tidak membawa `aud` → selalu ditolak di jalur ini. Jalur cookie (Agent Board) tetap memakai `getSessionUser()` apa adanya.
