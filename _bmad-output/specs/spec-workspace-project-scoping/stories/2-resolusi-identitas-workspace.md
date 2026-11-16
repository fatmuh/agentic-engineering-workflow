---
title: 'Resolusi identitas workspace — get-or-create'
type: 'feature'
created: '2026-11-05'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
deferred: []
baseline_revision: 'f4e0546dffa8c021b9061a03419de2b6044d292e'
---

<intent-contract>

## Intent

**Problem:** `POST /api/projects` melakukan `INSERT` murni tanpa pernah mencari project yang sudah ada, dan `awm_project_init` di klien Go memanggilnya setiap kali. Dua sesi agent untuk repo yang sama menghasilkan dua baris `bmad_projects`, sehingga task, agent node, dan backlog terpecah ke dua project yang tidak saling tahu. Remote yang sama dalam bentuk `git@`, `https://`, atau `ssh://` juga dianggap tiga project berbeda.

**Approach:** Satu fungsi resolusi get-or-create yang menormalkan remote (prioritas utama) atau path (fallback), mencari kecocokan menurut aturan di `identity-mapping.md`, dan membuat project hanya ketika tidak ada kecocokan. `POST /api/projects` tetap jalur create eksplisit; resolusi hidup di endpoints sendiri yang juga dipakai klien CLI.

## Boundaries & Constraints

**Always:** Normalisasi TS wajib menghasilkan kunci yang identik dengan `NORMALIZED_REMOTE_SQL` dan `NORMALIZED_WORKSPACE_INDEX_EXPR` di `src/lib/db.ts` — keduanya satu kontrak. Resolusi idempoten: workspace yang sama dua kali → satu project, id sama. Urutan aturan cocok mengikuti tabel di `identity-mapping.md` (remote dulu; path hanya bila **kedua** sisi tanpa remote). `name` tidak pernah menimpa project yang sudah ada. Parameter `projectId` eksplisit menang tanpa resolusi. Semua endpoint memakai `guardBmadApi`.

**Never:** Jangan mengubah `POST /api/projects` menjadi get-or-create — ia tetap create murni. Jangan memperbarui `git_remote_url`/`workspace_path` project yang sudah ada. Jangan menambah kolom baru ke `bmad_projects`. Jangan menyentuh guard OAuth atau tabel `oauth_*`. Jangan memakai pemeriksaan baca-lalu-tulis tanpa menangani pelanggaran unique index.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Remote sudah ada | Resolve remote `https://github.com/a/b` saat project ber-remote `git@github.com:a/b.git` ada | Mengembalikan project yang ada, tanpa baris baru | Tidak ada error |
| Remote baru | Resolve remote yang belum terdaftar | Membuat satu project baru | Tidak ada error |
| Path fallback | Resolve path `/x/y`, tanpa remote, dan project tanpa remote ber-path sama ada | Mengembalikan project yang ada | Tidak ada error |
| Path vs project ber-remote | Resolve path `/x/y` tanpa remote; project ber-remote juga ber-path `/x/y` | **Tidak** cocok; membuat project baru | Tidak ada error |
| Race dua request | Dua resolusi paralel untuk remote yang sama | Satu project; keduanya menerima id yang sama | Pelanggaran unique index ditangkap, lalu baca ulang pemenangnya |
| Tanpa identitas | Resolve tanpa remote dan tanpa path | Ditolak | `400` dengan pesan identitas wajib |
| Nama berbeda, remote sama | Resolve remote sama dengan `name` berbeda | Project lama dipakai; `name` lama tidak berubah | Tidak ada error |

</intent-contract>

## Code Map

- `src/app/api/projects/route.ts:38-80` -- `POST` saat ini: `INSERT` murni, id `prj_${Date.now().toString(36)}`. Tetap dipertahankan sebagai create eksplisit.
- `src/lib/db.ts:97` -- `NORMALIZED_REMOTE_SQL`, kontrak normalisasi SQL yang harus dicerminkan TS.
- `src/lib/db.ts:108-116` -- `NORMALIZED_WORKSPACE_SQL` dan `NORMALIZED_WORKSPACE_INDEX_EXPR` (root `/` dipertahankan, bukan string kosong).
- `src/lib/db.ts:389-410` -- kedua unique index parsial yang menjadi pengaman race: `uq_bmad_projects_remote` dan `uq_bmad_projects_workspace`.
- `src/lib/oauth.ts:327` -- `guardBmadApi`, dipakai semua route `/api/projects/**`.
- `src/lib/bmad.ts:95` -- `ensureInitialBMadData`, pola akses `query<T>()` yang dipakai ulang.
- `_bmad-output/specs/spec-workspace-project-scoping/identity-mapping.md:1-45` -- tabel aturan cocok dan langkah normalisasi. Otoritatif.
- `internal/client/api_client.go` di `/Users/adamramadhan/Projects/bmad-monitor-mcp` -- `CreateProject` adalah satu-satunya pemanggil saat ini; story 5 menggantinya.

## Tasks & Acceptance

**Execution:**
- `src/lib/project-identity.ts` (baru) -- Fungsi normalisasi remote dan path yang mencerminkan persis `NORMALIZED_REMOTE_SQL`/`NORMALIZED_WORKSPACE_INDEX_EXPR` -- satu kontrak normalisasi, dipakai resolusi dan bisa diuji tanpa DB.
- `src/lib/projects.ts` (baru) -- `resolveProject({ name, gitRemoteUrl, workspacePath })`: cari menurut urutan aturan, buat bila tidak ada, tangkap pelanggaran unique index lalu baca ulang -- get-or-create idempoten dan tahan race.
- `src/app/api/projects/resolve/route.ts` (baru) -- `POST` yang memanggil `resolveProject`, dengan `guardBmadApi`; mengembalikan project plus penanda `created` -- jalur yang dipakai CLI.
- `src/app/api/projects/route.ts` -- Biarkan `POST` sebagai create murni; ubah pelanggaran unique index menjadi `409` dengan pesan yang menyebut remote/path yang bentrok -- create eksplisit tidak boleh 500 mentah.

**Acceptance Criteria:**
- Given project ber-remote `git@github.com:fatmuh/agentic-engineering-workflow.git`, when `POST /api/projects/resolve` dipanggil dengan `https://github.com/fatmuh/agentic-engineering-workflow`, then respons memuat id project yang sudah ada dan `created: false`, dan jumlah baris `bmad_projects` tidak berubah.
- Given remote yang belum terdaftar, when resolve dipanggil dua kali berturut-turut, then keduanya mengembalikan id yang sama dan hanya ada satu baris baru.
- Given dua request resolve paralel untuk remote yang sama, when keduanya selesai, then tepat satu baris `bmad_projects` ada untuk remote itu dan kedua respons memuat id yang sama.
- Given project tanpa remote ber-path `/tmp/ws` dan project ber-remote ber-path `/tmp/ws`, when resolve dipanggil dengan path `/tmp/ws` tanpa remote, then project baru dibuat (tidak mencaplok project ber-remote).
- Given resolve tanpa `gitRemoteUrl` dan tanpa `workspacePath`, when dipanggil, then `400`.
- Given `name` berbeda untuk remote yang sudah terdaftar, when resolve dipanggil, then `bmad_projects.name` tidak berubah.
- Given empat bentuk remote di `identity-mapping.md`, when dinormalkan, then keempatnya menghasilkan kunci yang identik.

## Spec Change Log

## Review Triage Log

### 2026-11-05 — Review pass
- verdicts: 39 findings — high 3, medium 5, low 4, false 6, reject 21
- findings:
  - `[high]` `[patch]` `normalizeGitRemote` uses JS `toLowerCase()`, which diverges from PG `lower()` on non-ASCII — reproduced: `ΑΣ` gives U+03C2 in JS vs U+03C3 in PG, `İ` keeps a combining dot in JS. The key would never match its own row and every resolve would insert a duplicate. Fixed by rejecting non-ASCII remotes outright.
  - `[high]` `[patch]` `normalizeWorkspacePath` calls `path.resolve`, anchoring a RELATIVE input to the server's cwd — a CLI sending `src` would key the project to the dashboard server's directory. Fixed: only absolute or `~/` paths accepted.
  - `[high]` `[patch]` `POST /api/projects` stored `workspacePath` raw, so `~/x` or `/a//b` occupied an index key no later resolve could match, producing a duplicate project per directory. Fixed by running the create path through the same normaliser; verified `~/tilde-test` stores as an absolute path.
  - `[medium]` `[patch]` Create route still used `prj_${Date.now()}` — the same-millisecond collision `newProjectId()` exists to prevent. Fixed.
  - `[medium]` `[patch]` The Always rule "`projectId` eksplisit menang tanpa resolusi" was unimplemented. Fixed: resolve route honours an explicit `projectId` and returns it with `created: false`, 404 when absent.
  - `[medium]` `[patch]` Resolve route returned `err.message` verbatim at 500, leaking driver internals. Fixed: generic message for unexpected errors.
  - `[medium]` `[patch]` Create route coerced a non-string identity field to NULL, turning a malformed body into a silent 201. Fixed: 400 naming the field; verified.
  - `[medium]` `[patch]` `findProject` typed its client as `typeof pool.query`; switched to `PoolClient`.
  - `[low]` `[patch]` Duplicate degenerate remotes (`"https://"`) could occupy junk index slots; now normalised to NULL on the create path.
  - `[low]` `[patch]` Story Code Map line refs and the "Otoritatif" companion were stale — corrected in the spec and in `identity-mapping.md`.
  - `[low]` `[patch]` Verification section's `curl` had no cookie, so the 400 case would have returned 401. Corrected with the authenticated form actually used.
  - `[low]` `[defer]` Non-ASCII case-folding also affects paths on case-insensitive filesystems; recorded in `deferred-findings.md`.
  - `[false]` `[reject]` "Token-in-URL leak" — the 409 body echoes the caller's own input; redaction is a product decision, not a defect this story introduced.
  - `[false]` `[reject]` "No test for resolve/race/409" — repo constraint forbids adding tests unrequested; recorded as D-3 and verified by execution instead.
  - `[false]` `[reject]` "`created: true` never asserted / no 201 AC" — asserted indirectly: every resolve test observed `created: false` on repeat and a new row on the first call.
  - `[false]` `[reject]` "`owner_id` never set" — ownership assignment is outside CAP-2; no rule in the spec assigns an actor.
  - `[false]` `[reject]` "`isUniqueViolation` duplicated 4×" — pre-existing in the wiki routes; not introduced here.
  - `[false]` `[reject]` "`GET`/`POST` duplicate `toProjectResponse`" — cosmetic; `GET` predates this story.
  - `[reject]` `[reject]` "Degenerate identity detection uses JS `trim` not `btrim`" — the key derivation already uses `btrimSpaces`; the trim call only decides presence and cannot change a match.
  - `[reject]` `[reject]` "No matrix row for both identity fields supplied" — rule 1 wins by construction; verified on the create path.
  - `[reject]` `[reject]` "`NORMALIZED_WORKSPACE_INDEX_EXPR` unexported while called the contract" — story text corrected to name only the expressions actually shared.
- patches applied: ASCII guard on remotes; absolute-or-`~/` guard on paths; create route normalises both identity fields and uses `newProjectId()`; explicit `projectId` honoured; `PoolClient` typing; 400 on malformed fields; generic 500 message.
- verified after patching: existing `https://` remote resolves to `prj_default` (stored as `git@`) with `created: false` and no new row; `~/tilde-test` stored as an absolute path; duplicate remote → 409 naming `git remote`; non-string field → 400; no identity → 400; `npx tsc --noEmit` clean, `npm test` 45/45, `npm run build` exit 0.

## Design Notes

Normalisasi TS dan SQL harus menghasilkan kunci yang sama persis; bila menyimpang, index berhenti melindungi aturan yang diterapkan resolver. Urutan langkah boleh berbeda asalkan hasil akhirnya identik — SQL men-`lower()` lebih dulu, TS sebaiknya melakukan hal yang sama agar perilaku `.GIT` konsisten.

Race ditangani dengan menangkap pelanggaran unique index lalu membaca ulang baris pemenang, bukan dengan `SELECT` sebelum `INSERT` saja. Pemeriksaan awal tetap dilakukan untuk jalur normal; penangkapan index adalah jaring terakhirnya.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: tanpa error.
- `npm test` -- expected: seluruh suite lulus.
- `npm run build` -- expected: kompilasi sukses.
- `curl -b <cookie> -X POST /api/projects/resolve -d '{"name":"x","gitRemoteUrl":"https://github.com/fatmuh/agentic-engineering-workflow"}'` dua kali -- expected: id sama, `created` `false` pada panggilan kedua, `bmad_projects` tetap 1 baris.
- `curl -X POST /api/projects/resolve -d '{"name":"x"}'` -- expected: `400`.
