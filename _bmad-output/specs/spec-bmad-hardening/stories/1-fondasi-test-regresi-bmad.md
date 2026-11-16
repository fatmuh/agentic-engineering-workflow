---
title: 'Fondasi test regresi BMad'
type: 'feature'
created: '2026-11-06'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Seluruh jaminan scoping project pada board BMad — composite key `(project_id, id)`, cascade saat task dihapus, penolakan remote duplikat, resolusi identitas get-or-create, dan isolasi board antar-project — hari ini hanya dibuktikan lewat verifikasi manual yang tidak tersimpan. `npm run test:matrix` menyentuh auth, RBAC dan wiki, tetapi tidak satu pun tabel `bmad_*`, sehingga regresi di `ensureSchema` v7 atau di `/api/projects*` lolos tanpa suara.

**Approach:** Tambah satu spec matrix, `tests/matrix/bmad-scoping.spec.ts`, yang mengunci kelima perilaku itu di atas harness yang sudah ada — scratch DB milik `tests/matrix/global-setup.ts`, `api()` untuk HTTP nyata terhadap app yang di-boot, dan `getPool()` untuk pembacaan/bacaan-tulis database. Tidak ada framework test baru dan tidak ada perubahan kode produksi: bila suite ini merah, yang rusak adalah perilakunya, bukan testnya.

Perilaku yang dikunci, satu blok per perilaku:

- **Composite key per project** — id task yang sama (`TASK-101`) ditulis ke dua project lewat `tasks/batch` menghasilkan dua baris, dan penulisan untuk project B tidak mengubah judul task project A.
- **Cascade saat task dihapus** — menghapus task milik project A ikut menghapus node agent yang menunjuknya, dan node project B tetap ada.
- **Penolakan remote duplikat** — remote yang menormalkan sama dengan project yang sudah ada ditolak `409` oleh `POST /api/projects`, dan jumlah baris `bmad_projects` tidak bertambah.
- **Resolusi identitas get-or-create** — `POST /api/projects/resolve` pada workspace yang sama mengembalikan project yang sama (`created: false`), termasuk saat path dikirim dengan garis miring penutup yang berbeda, dan caller tanpa remote tidak boleh mengambil alih project yang dimiliki sebuah remote.
- **Isolasi board** — `GET /api/projects/{id}/tasks` dan `agent-tree` hanya mengembalikan baris milik project itu.

Uji balik wajib dijalankan sebelum laporan: hapus `ON DELETE CASCADE` pada FK `bmad_agent_nodes.task_id`, dan kembalikan `ON CONFLICT (id)` di `tasks/batch`; masing-masing harus membuat `npm run test:matrix` merah, lalu perubahan itu dipulihkan.

</frozen-after-approval>

## Implementation Notes

- Deliverable: `tests/matrix/bmad-scoping.spec.ts` — 9 test, dijalankan `npm run test:matrix` (dan `npm run verify`). Tidak ada perubahan kode produksi; `git status` bersih kecuali dua berkas baru (spec ini + berkas test).
- Fixture id memakai `MX-COMPOSITE-1`, bukan `TASK-101` seperti draf intent: `TASK-101` sudah disemai ke `prj_default` oleh `src/lib/bmad.ts`, dan memakainya membuat asersi jumlah baris bergantung pada seed demo. Perilaku yang dikunci sama persis.
- Fixture tidak bergantung pada `prj_default`; pembersihan `afterAll` menghapus berdasarkan prefiks nama fixture (`Matrix BMad Scoping %`), bukan `workspace_path`, agar fixture remote-only tidak bocor.
- Reverse test yang dipesan intent ("kembalikan `ON CONFLICT (id)`") dijalankan dan memang merah, tetapi lewat SQLSTATE 42P10 (`no unique or exclusion constraint matching the ON CONFLICT specification` → 500), bukan lewat penimpaan lintas project — kunci global memang sudah tidak ada, jadi bentuk lama bug itu tidak bisa diekspresikan lagi. Karena itu ditambahkan mutasi kedua yang meniru semantik penimpaan kunci global (`DELETE FROM bmad_tasks WHERE id = $1` sebelum insert di `tasks/batch`); test composite-key merah karenanya. Kedua bukti dicatat di bawah.
- Catatan untuk mutasi "aturan cocok path": menghapus pemangkas garis miring di `normalizeWorkspacePath` (TS) TIDAK memerahkan suite — `path.resolve` sudah memangkasnya, jadi mutasi itu no-op. Aturan yang benar-benar diuji adalah sisi SQL `findProject` rule 2; mutasinya menghapus syarat `git_remote_url IS NULL`, dan test resolusi identitas merah karenanya.

**Bukti reverse test** (masing-masing: build → `npm run test:matrix`, lalu dipulihkan; hasil hijau akhir 147/147):

- Hapus `ON DELETE CASCADE` pada FK `bmad_agent_nodes.task_id` (`db.ts`): 1 test merah — cascade (asersi perilaku terlebih dulu, lalu pin katalog).
- Kembalikan `ON CONFLICT (id)` di `tasks/batch`: 4 test merah — 42P10/500 pada semua penulis task.
- Mutasi peniru penimpaan kunci global di `tasks/batch`: 1 test merah — composite key.
- Longgarkan rule 2 `findProject` (hapus `git_remote_url IS NULL`): 1 test merah — identity resolution.
- Mutasi no-op yang tercatat: pemangkas slash TS-side (lihat atas).

## Review Triage Log

### 2026-11-06 — Blind hunter pass

- `[medium]` `[patch]` Test remote-duplikat terikat seed `prj_default`, dan kebocoran barisnya tak terjangkau pembersih `workspace_path` — diganti fixture lokal `Matrix BMad Scoping Remote Original` + tiga variasi ejaan.
- `[medium]` `[patch]` Pembersihan berbasis `workspace_path` bocor untuk fixture remote-only — kini berdasarkan prefiks nama fixture.
- `[high]` `[patch]` `uq_bmad_projects_workspace` tak pernah diuji (klausul ketiga CAP-3) — test "duplicate workspace path" ditambah, termasuk variasi garis miring penutup.
- `[medium]` `[patch]` Tak ada kasus tanpa sesi — test 401 untuk lima jalur ditambah.
- `[medium]` `[patch]` Penolakan lintas project di `agent-tree/step` tak teruji — test 400 ditambah.
- `[low]` `[patch]` Body respons `agent-tree/step` tak pernah diasersi — kini dipin (`project_id`/`task_id` snake_case, tautan yang cascade butuhkan).
- `[medium]` `[patch]` Pin PK hanya pada `bmad_tasks` — kini ketiga tabel v7.
- `[medium]` `[patch]` Jalur identitas negatif absen — path relatif → 400 di create+resolve, `projectId` → 200/404.
- `[medium]` `[patch]` Asersi status hilang di beberapa panggilan — helper `expectStatus` yang mencantumkan body saat gagal.
- `[medium]` `[patch]` Isolasi board satu sisi — node di kedua project + saling memastikan tak ada kebocoran.
- `[low]` `[reject]` "`toEqual([\"MX-ISOLASI-B\"])` rentan urutan" — tepat satu baris, deterministik; keanggotaan sudah dipisah lewat `toContain` untuk project A.
- `[low]` `[patch]` Komentar overclaim "any supported spelling" — diganti tiga ejaan eksplisit yang benar-benar dijalankan.
- `[medium]` `[patch]` Non-clobber hanya diverifikasi lewat SQL — dua `GET .../tasks` ditambahkan.
- `[low]` `[patch]` Pin FK tanpa `confrelid` — ditambah `confrelid = 'bmad_tasks'::regclass`.
- `[false]` `[patch]` Komentar `RUN_ID` menjelaskan bahaya yang tak mungkin (scratch DB segar tiap run) — `RUN_ID` dihapus seluruhnya, path fixture statis.
- `[low]` `[patch]` `afterAll` bisa menelan kegagalan — dibungkus try/finally dengan `closeDbPool()`.
- `[high]` `[patch]` Preskripsi reverse test `ON CONFLICT (id)` membuktikan 42P10, bukan penimpaan — bukti ganda dicatat (lihat Implementation Notes); mutasi peniru semantik lama ditambahkan dan merah.
- `[medium]` `[patch]` Tak ada catatan bukti — Implementation Notes diisi dengan hasil lima reverse test.
- `[false]` `[reject]` "Frontmatter kurang `baseline_revision`/`warnings`/`deferred`" — field itu milik format story bmad-build lama; spec ini mengikuti template `spec-template.md` yang berlaku sekarang.
- `[false]` `[reject]` "Wrapper kontrak salah (`<intent-contract>`)" — alasan yang sama; template sekarang memakai `<frozen-after-approval>` dan untuk route oneshot hanya Intent + Implementation Notes.
- `[low]` `[patch]` Intent menyebut `TASK-101`, test memakai `MX-COMPOSITE-1` — alasan (seed `prj_default`) dicatat di test dan Implementation Notes.
- `[low]` `[reject]` "`type: 'feature'` seharusnya `refactor`" — CAP-3 adalah capability baru (peringatan regresi otomatis), bukan restrukturisasi; status di-finalize ke `done`.
- `[high]` `[patch]` Lima bullet intent tak memuat klausul "aturan cocok path" CAP-3 — tercakup lewat test indeks workspace + mutasi rule 2.
