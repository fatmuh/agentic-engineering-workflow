---
id: SPEC-bmad-hardening
companions:
  - findings-map.md
  - migration-plan.md
sources:
  - ../spec-workspace-project-scoping/deferred-findings.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Hardening Integrasi BMad Monitor

## Why

Ini sebuah **pain to solve**, dan sebagian **mandate to meet**. Sembilan temuan nyata sudah tercatat selama pembangunan scoping project per workspace (`spec-workspace-project-scoping`) tetapi sengaja tidak dikerjakan agar spec itu tidak melebar. Semuanya terverifikasi ulang terhadap kode saat ini — bukan dugaan, bukan asumsi yang sudah usang.

Yang paling mendesak bukan yang paling mencolok. Empat tool MCP backlog akan 404 pada pemakaian pertama karena route-nya tidak pernah dibangun. Board dapat menampilkan task demo karangan sebagai data live bila seed gagal. Kredensial yang tertanam di URL remote tersimpan apa adanya di kolom yang ditampilkan dashboard. Dan tidak ada satu pun test otomatis yang menyentuh tabel BMad, sehingga seluruh jaminan scoping hanya berdiri di atas verifikasi manual yang tidak tersimpan.

Yang terkena dampak adalah operator dan tim yang memakai dashboard ini sebagai satu-satunya pandangan atas pekerjaan agent mereka. Ketika board menampilkan task yang tidak ada, atau tool 404, kepercayaan pada dashboard runtuh — dan dashboard yang tidak dipercaya lebih buruk daripada tidak ada dashboard.

## Capabilities

- **CAP-1 — Bootstrap schema tahan multi-instance**
  - **intent:** Sistem dapat menyalakan beberapa proses sekaligus terhadap satu database tanpa ada yang gagal karena memperebutkan DDL yang sama.
  - **success:** N proses (N ≥ 4) dijalankan bersamaan terhadap database yang sama; seluruhnya selesai boot tanpa error, skema identik dengan hasil boot tunggal, dan tidak ada DDL yang dijalankan dua kali.

- **CAP-2 — Backlog berfungsi penuh**
  - **intent:** Pengguna dan agent dapat membuat, membaca, melaporkan impact, dan mempromosikan backlog lewat API yang dipanggil tool MCP, termasuk mempromosikan tiket yang sudah pernah dipromosikan.
  - **success:** `awm_backlog_create`, `awm_backlog_list`, `awm_backlog_report_impact`, dan `awm_backlog_promote` masing-masing selesai tanpa 404; backlog ter-scope per `projectId`; `BKL-001` dapat hidup berdampingan di dua project; promote membuat task dan menandai backlog dalam satu operasi yang tidak bisa berhenti di tengah; mempromosikan tiket yang sudah `promoted` mengembalikan task yang sama, bukan task kedua.

- **CAP-3 — Test regresi BMad**
  - **intent:** Tim dapat menjalankan `npm run verify` dan mendapat peringatan otomatis bila perilaku scoping, cascade, atau resolusi identitas rusak.
  - **success:** Menghapus `ON DELETE CASCADE` pada FK, atau mengembalikan `ON CONFLICT (id)`, atau melonggarkan aturan cocok path, masing-masing membuat `npm run verify` gagal pada test yang menyebut perilaku itu.

- **CAP-4 — Identitas workspace case-insensitive**
  - **intent:** Sistem dapat mengenali bahwa path yang hanya berbeda kapitalisasi menunjuk workspace yang sama.
  - **success:** `/Users/X/proj` dan `/users/x/proj` menghasilkan kunci identitas yang sama dan resolve ke satu project; data lama yang sudah terdaftar dengan path berhuruf besar tetap dapat ditemukan setelah migrasi, tanpa membuat project duplikat.

- **CAP-5 — Kredensial tidak pernah tersimpan**
  - **intent:** Sistem dapat menolak remote yang membawa kredensial, sehingga rahasia tidak pernah masuk ke database lewat jalur input.
  - **success:** Remote berbentuk `https://user:token@host/repo` ditolak dengan `400` pada create maupun resolve, dan tidak ada baris baru di `bmad_projects`; respons API untuk baris lama yang telanjur menyimpan kredensial tidak memuat bagian userinfo.

- **CAP-6 — Board jujur soal data**
  - **intent:** Pengguna dapat membedakan data live dari data contoh, dan board tidak pernah menampilkan task karangan sebagai data nyata.
  - **success:** Dengan database yang tidak dapat dijangkau, board menampilkan keadaan gagal/kosong dan nol task; kontrol contoh, bila ada, berlabel eksplisit dan tidak pernah muncul sebagai keadaan bawaan tab mana pun.

- **CAP-7 — Sinkronisasi board tahan balapan**
  - **intent:** Board dapat menampilkan data terbaru walau beberapa permintaan berjalan bersamaan, dan melaporkan kegagalan yang benar-benar terjadi.
  - **success:** Respons yang dimulai lebih dulu tidak pernah menimpa respons yang dimulai lebih baru untuk project yang sama; kegagalan `agent-tree` saja tidak menandai daftar task sebagai gagal, dan sebaliknya.

- **CAP-8 — Persistensi workspace konsisten**
  - **intent:** Pengguna dapat membuka beberapa tab dan memulihkan keadaan setelah kegagalan tanpa reload halaman penuh.
  - **success:** Mengganti workspace di satu tab mengubah tab lain tanpa reload; bila pemuatan daftar project gagal, ada afordans di UI yang memicunya ulang dan berhasil tanpa memuat ulang halaman.

- **CAP-9 — Workspace Switcher selesai**
  - **intent:** Pengguna dapat memakai switcher yang menyatakan keadaannya sendiri dan tidak menyisakan sumber data palsu di kode.
  - **success:** Switcher menampilkan keadaan memuat dan gagal, mengumumkan pergantian ke pembaca layar, dan seluruh teksnya berbahasa Indonesia; `demoAgentTasks` tidak lagi ada di kode aplikasi.

## Constraints

- D-4 mengubah **kunci identitas** yang sudah tersimpan di `bmad_projects` dan di `~/.bmad-monitor/config.json`. Migrasi wajib memetakan kunci lama ke bentuk baru; tanpa itu workspace terdaftar menjadi kunci berbeda dan menghasilkan project duplikat.
- Penolakan D-5 hanya berlaku pada input baru. Baris lama yang sudah menyimpan URL ber-kredensial tidak boleh membuat aplikasi gagal baca dan tidak boleh ditampilkan apa adanya.
- D-1 menyentuh jalur boot seluruh aplikasi. Perubahan wajib idempoten dan tidak boleh membuat satu instance gagal hanya karena instance lain memegang lock; lock harus punya batas waktu tunggu yang jelas.
- D-1 memakai satu lock di dalam `ensureSchema`, bukan proses migrasi terpisah. Itu menuntut seluruh `ensureSchema` berjalan sebagai satu transaksi pada satu client — `pg_advisory_xact_lock` hanya hidup selama transaksi, sedangkan blok v2–v6 saat ini berjalan sebagai `pool.query()` terpisah.
- D-2 mengubah skema sebelum route dibuat: `bmad_backlogs` mendapat `promoted_to_task_id`, `promoted_by`, `promoted_at`, dan berpindah ke `PRIMARY KEY (project_id, id)`. Promote adalah satu transaksi; status backlog tidak boleh pernah menyatakan `promoted` tanpa task yang benar-benar ada.
- Semua endpoint baru memakai `guardBmadApi` dan ter-scope `projectId`, mengikuti pola route `tasks/`.
- Perubahan di repo `bmad-monitor-mcp` (D-2 verifikasi, D-5 sisi klien) tidak boleh mengubah kontrak OAuth atau format token.
- Test D-3 memakai harness `tests/matrix/` yang ada (scratch DB + `getPool()`); tidak menambah framework test baru.

## Non-goals

- Multi-tenancy, isolasi per-team, atau kontrol akses per-project.
- UI untuk membuat, mengganti nama, atau menghapus project atau backlog.
- Redaksi kredensial sebagai alternatif: D-5 memilih penolakan, bukan penyamaran.
- Sinkronisasi real-time multi-klien (WebSocket/SSE); polling 5 detik tetap.
- Migrasi data ke skema baru selain yang dibutuhkan D-4.
- Memperbaiki temuan yang belum tercatat di `deferred-findings.md`.

## Success signal

`npm run verify` hijau pada branch yang, ketika `ON DELETE CASCADE` pada `bmad_agent_nodes.task_id` dihapus, menjadi merah. Empat tool MCP backlog selesai tanpa 404 terhadap project yang sama. Dua proses aplikasi dinyalakan bersamaan terhadap satu database dan keduanya siap melayani.

## Assumptions

- Deployment saat ini satu instance; D-1 dikerjakan agar jalur multi-instance aman sebelum dibutuhkan, bukan karena sudah dibutuhkan sekarang.
- Repo `bmad-monitor-mcp` tetap di `/Users/adamramadhan/Projects/bmad-monitor-mcp` dan dikerjakan pada sesi terpisah dari dashboard.

## Open Questions

_Tidak ada._ Kedua pertanyaan sebelumnya dijawab: D-2 promote dalam satu transaksi dan idempoten, dan D-1 memakai lock global di dalam `ensureSchema`.
