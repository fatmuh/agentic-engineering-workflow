---
id: SPEC-oauth-pkce-bmad-mcp
companions:
  - oauth-endpoints.md
  - brownfield.md
  - architecture-diagrams.md
sources:
  - ../../../tools/bmad-monitor-mcp/WEB_SPECIFICATION.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# OAuth 2.0 + PKCE Endpoint untuk BMad Monitor MCP

## Why

Klien MCP BMad Monitor (binary Go, selesai dan teruji) tidak bisa login: `GET /oauth/authorize` dan `POST /api/oauth/token` belum ada di dashboard (404), sehingga flow PKCE selalu timeout setelah 3 menit — tim tidak dapat menghubungkan T3 Code/BMad ke dashboard untuk monitoring agent, Kanban approval, dan vault provider LLM. Pain kedua yang menyertainya: endpoint REST BMad yang sudah ada (`/api/projects/**`, `/api/llm-providers`) sama sekali tidak memeriksa `Authorization` header, sehingga begitu token MCP beredar tidak ada jalur verifikasi yang menanganinya. Fitur ini menutup keduanya dengan satu kontrak autentikasi machine-to-web.

## Capabilities

- **CAP-1 — Halaman persetujuan otorisasi**
  - **intent:** Pengguna CLI dapat menyetujui atau menolak permintaan otorisasi MCP dari browser yang sudah login ke dashboard, melalui halaman `GET /oauth/authorize` bergaya auth-shell.
  - **success:** Dengan sesi web aktif dan status `Active`, request ber-parameter PKCE valid me-render halaman persetujuan; tombol "Authorize" menghasilkan redirect ke `http://127.0.0.1:<port>/callback?code=<AUTH_CODE>&state=<STATE>` dengan `state` identik input; tombol "Tolak" menghasilkan redirect callback dengan `error=access_denied`; tanpa sesi → redirect `/login` membawa URL kembali; status ≠ `Active` → pesan "belum memiliki izin/allowance" tanpa code.

- **CAP-2 — Token exchange (grant `authorization_code`)**
  - **intent:** Klien MCP dapat menukar authorization code sekali-pakai dengan pasangan access + refresh token dan profil user melalui `POST /api/oauth/token`.
  - **success:** Exchange valid (`code_verifier` S256 cocok `code_challenge`, code belum pernah dikonsumsi, umur ≤ 60 detik, `client_id` dan `redirect_uri` cocok) → `200` JSON berisi `access_token`, `refresh_token`, `expires_in`, `token_type: "Bearer"`, dan `user { id, email, name, role, isAllowed, teamId }`; code dipakai ulang, PKCE salah, atau parameter tidak cocok → error OAuth `invalid_grant`/`invalid_request` dan code tidak dapat dipakai lagi.

- **CAP-3 — Pembaruan sesi (grant `refresh_token`)**
  - **intent:** Klien MCP dapat memperbarui sesi kedaluwarsa tanpa login ulang browser melalui `POST /api/oauth/token` dengan `grant_type=refresh_token`.
  - **success:** Refresh valid → `200` pasangan token baru (refresh lama hangus — rotasi) dengan profil user terkini; refresh token yang sudah dirotasi dipakai lagi → ditolak dan keluarga token user di-revoke; user non-`Active` → `403` dan seluruh token MCP-nya dicabut.

- **CAP-4 — Proteksi Bearer di REST BMad**
  - **intent:** Endpoint REST BMad (`/api/projects/**`, `/api/llm-providers`) hanya melayani permintaan terautentikasi — sesi web via cookie atau klien MCP via `Authorization: Bearer` audience `bmad-mcp`.
  - **success:** Request dengan Bearer MCP valid → `200`; tanpa kredensial → `401`; token web (tanpa klaim `aud: "bmad-mcp"`) dipakai sebagai Bearer → `401`; request cookie dari Agent Board (agent-board-view.tsx) tetap bekerja tanpa perubahan.

## Constraints

- Kontrak klien Go immutable (klien tidak diubah): body `application/x-www-form-urlencoded`, `client_id` literal `"bmad-mcp-cli"`, `redirect_uri` wajib loopback `http://127.0.0.1:<port>/callback` (port dinamis, `127.0.0.1` — bukan `localhost`), respons wajib memuat `user.isAllowed`, penolakan callback berbentuk `error=access_denied` (+ `error_description`); klien tidak mengirim `scope` — jangan mensyaratkannya.
- Access token MCP = JWT HS256 ditandatangani `AUTH_SECRET`, issuer `onyx-auth`, klaim `aud: "bmad-mcp"`; verifikator Bearer wajib menolak token tanpa klaim tersebut — termasuk token akses web — agar dua populasi token tidak saling dipertukarkan.
- Dual-auth di REST BMad wajib: jalur verifikasi cookie (web) dan Bearer (MCP) terpisah; Bearer-only akan merusak Agent Board.
- Penyimpanan OAuth masuk blok **schema v6** `src/lib/db.ts` (v5 sudah terpakai tabel BMad): `oauth_codes` sekali-pakai + tabel refresh MCP, append-only idempotent (`CREATE TABLE IF NOT EXISTS`) mengikuti pola v3/v4/v5; konsumsi code atomik satu statement (`UPDATE ... WHERE consumed_at IS NULL ... RETURNING`).
- Gerbang isAllowed dipetakan ke `users.status = 'Active'` — tanpa migrasi kolom baru; pesan penolakan mengarahkan menghubungi admin tim.
- `POST /api/oauth/token` tetap dapat diakses publik tanpa sesi web (proxy matcher sudah men-skip `/api/**` — jangan tambahkan aturan yang memblokirnya); halaman `/oauth/authorize` mengelola sendiri redirect ke `/login` berikut parameter kembali.
- Halaman persetujuan reuse komponen gaya `src/components/auth/` (auth-shell).
- `expires_in` respons = `2592000` detik (30 hari) sesuai contoh kontrak WEB_SPEC; TTL `refresh_token` MCP = 30 hari dengan rotasi tiap pemakaian.
- Batasan proses implementasi: tanpa unit/integration test kecuali diminta eksplisit; tanpa git worktree; tanpa commit otomatis — tampilkan diff untuk review terlebih dahulu.

## Non-goals

- Tidak mengubah klien Go maupun WEB_SPECIFICATION.md di repo `tools/bmad-monitor-mcp` (klien dianggap beku).
- Tidak mengimplementasikan endpoint WEB_SPEC lain yang belum ada (WebSocket agent-bridge §7, context-files §3, backlog impact/promote §8, task batch §5, agent-tree step §4) — scope hanya autentikasi + proteksi Bearer pada endpoint yang sudah ada.
- Tidak menambah kolom `users.is_allowed` maupun UI admin allowance baru.
- Tidak mengubah mekanisme sesi web existing (cookie pair, rotasi refresh, RBAC permissions.ts).
- Tidak mendukung parameter `scope`, dynamic client registration, atau client selain `bmad-mcp-cli`.
- Tidak memfilter data REST BMad per team/role (otorisasi = identitas user + gerbang isAllowed saja).
- Tidak membuat test otomatis (unit/integration) kecuali diminta eksplisit.

## Success signal

Binary `bmad-monitor` menjalankan `login` end-to-end terhadap dev server lokal tanpa timeout: browser menampilkan halaman persetujuan, callback loopback menerima `code`, token exchange `200` tersimpan di `~/.bmad-monitor`, dan panggilan MCP pertama (mis. daftar project) diterima `/api/projects` dengan Bearer; pengguna yang dinon-aktifkan (status ≠ Active) gagal di gerbang allowance tanpa pernah menerima code.

## Assumptions

- `expires_in` 2592000 detik diikuti meski access JWT tidak dapat dicabut sebelum `exp`; klien membaca `expires_in` dinamis sehingga TTL dapat diperingkas kapan pun tanpa merusak klien.
- `AUTH_SECRET` dan issuer `onyx-auth` yang sama dipakai untuk menandatangani token MCP; klaim `aud` satu-satunya pembeda dari token web.
