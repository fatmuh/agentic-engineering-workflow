---
title: 'Backlog berfungsi penuh — schema dan tiga route'
type: 'feature'
created: '2026-11-06'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: '3413d35466b5f2f385c919a7323db7b242af0a43'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Empat tool MCP backlog (`awm_backlog_create`, `awm_backlog_list`, `awm_backlog_report_impact`, `awm_backlog_promote`) 404 pada pemakaian pertama karena route-nya tidak pernah dibangun, dan `bmad_backlogs` tidak punya kolom promosi yang diharapkan klien Go — alur ide → analisis impact → promote ke Kanban putus di tengah.

**Approach:** Blok schema v8 menambahkan `promoted_to_task_id`, `promoted_by`, `promoted_at` pada `bmad_backlogs` (idempoten, FK composite ke `bmad_tasks`), lalu tiga route — `backlogs` (GET list + POST create), `[backlogId]/impact`, `[backlogId]/promote` — semuanya `guardBmadApi` dan ter-scope `projectId` mengikuti pola `tasks/`. Promote berjalan sebagai satu transaksi dan idempoten; responsnya berbentuk `KanbanTaskItem` sesuai kontrak klien Go.

## Boundaries & Constraints

**Always:** Setiap route memanggil `guardBmadApi` lebih dulu dan semua query memfilter `project_id`. Promote = satu transaksi pada satu client (`BEGIN…COMMIT`): INSERT task dan UPDATE backlog commit bersama, sehingga tidak pernah ada `status='promoted'` tanpa task. Promote kedua mengembalikan task yang sama (HTTP 200), bukan task kedua. Respons promote adalah `KanbanTaskItem` camelCase; respons backlog adalah `BacklogItem` camelCase memuat `promotedToTaskId`/`promotedBy`/`promotedAt` bila terisi. `impact_analysis` disimpan verbatim sebagai JSONB dan dikembalikan apa adanya. Blok v8 idempoten: `ADD COLUMN IF NOT EXISTS` + FK di-guard dari katalog memakai helper `hasCompositeForeignKey` yang ada. Test matrix baru pada scratch DB. Verifikasi akhir dengan binary Go asli (`HOME` terisolasi) terhadap server produksi di atas scratch DB — bukan hanya curl.

**Never:** Tidak mengubah kontrak OAuth atau format token. Tidak membuat UI backlog. Tidak menyunting blok v5/v7 yang ada. Tidak menambah framework test. Tidak menyentuh database dev selama verifikasi.

**Keputusan (2026-11-06):** promote hanya boleh dari status `analyzed` — tiket `draft`/`analyzing` ditolak `409` dengan pesan yang menyebut bahwa impact analysis harus dilaporkan lebih dulu. Alur MCP ditegakkan di sisi server.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create tanpa id | `POST /backlogs {title, rawDescription, source}` | 201; id `BKL-<n>` berurutan per project; `status: "draft"` | title kosong → 400 |
| Id eksplisit di dua project | `BKL-001` ke project A lalu B | 201 keduanya; dua baris berbeda `project_id` | N/A |
| List | `GET /backlogs` | Hanya baris project itu, urut `created_at` | project tak dikenal → `[]` |
| List + filter | `?status=analyzed` | Hanya status itu | N/A |
| Impact | `POST impact` body analysis lengkap | 200; `status: "analyzed"`; `impactAnalysis` verbatim | N/A |
| Impact backlog tak dikenal | id salah | 404 | tanpa mutasi |
| Impact `riskLevel` invalid | bukan low/medium/high/critical | 400 | tanpa mutasi |
| Impact pada promoted | sudah dipromosikan | 409 | tanpa mutasi |
| Promote pertama | `POST promote {targetStage?}` | 201 `KanbanTaskItem`; backlog `promoted` + `promoted_*` terisi | N/A |
| Promote kedua | ulangi panggilan sama | 200; `taskId` sama; jumlah baris `bmad_tasks` tidak bertambah | N/A |
| Promote backlog `draft`/`analyzing` | belum ada impact analysis | 409, pesan menyebut analisis harus lebih dulu | tanpa mutasi |
| Promote tak dikenal | id salah | 404 | N/A |
| `targetStage` invalid | di luar `backlog/analysis/ready_for_review` | 400 | tanpa mutasi |
| Tanpa sesi | semua route tanpa cookie/bearer | 401 | N/A |
| Hapus task yang dipromosikan | `DELETE` via SQL | ditolak FK — invariant promoted ⇒ task ada | error FK |

</frozen-after-approval>

## Code Map

- `src/lib/db.ts:137` — `PROJECT_SCOPED_TABLES` sudah memuat `bmad_backlogs`: PK `(project_id, id)` sudah terpasang oleh v7 dan dikunci test story 1. Story ini TIDAK mengulang migrasi kunci.
- `src/lib/db.ts:684-696` — DDL v5 `bmad_backlogs` (id, project_id, title, raw_description, source, created_by, status, impact_analysis, created_at, updated_at). Jangan disunting; kolom baru datang dari blok v8.
- `src/lib/db.ts:145-200` — `attnumOf` / `hasCompositeForeignKey` / `hasSingleColumnForeignKey`: guard katalog yang dipakai ulang untuk FK v8.
- `src/lib/db.ts` akhir `ensureSchema` — blok v8 baru ditempatkan setelah `migrateProjectScopedKeys()`.
- `src/lib/projects.ts:276-343` — pola transaksi `pool.connect()` + `BEGIN/COMMIT` + retry 23505 (`resolveProject`) yang ditiru untuk create (id berurutan) dan promote.
- `src/app/api/projects/[projectId]/tasks/batch/route.ts` — pola route: `guardBmadApi`, `await params`, mapping snake_case → camelCase `KanbanTaskItem`.
- `src/lib/bmad.ts` — tipe `BMadTaskItem` dan bentuk respons task; dipakai bersama oleh lib baru.
- `tests/matrix/bmad-scoping.spec.ts` — pola spec matrix: `expectStatus`, prefiks nama fixture, cleanup `afterAll` by name, `getPool()` untuk asersi katalog.
- Klien Go (baca-saja, jangan diubah di story ini): `/Users/adamramadhan/Projects/bmad-monitor-mcp/internal/client/api_client.go:245-306` (endpoint + payload), `internal/models/models.go:143-157` (`BacklogItem`), `:52-66` (`KanbanTaskItem`), `:130-141` (`CodeImpactAnalysis`); stdio newline-delimited JSON-RPC (`internal/mcp/server.go`); `HOME` dapat diisolasi karena config di `os.UserHomeDir()/.bmad-monitor/config.json`.
- `src/lib/jwt.ts:186-199` — klaim MCP access token (HS256, `aud: bmad-mcp`, `iss: onyx-auth`) untuk menempa token verifikasi Go dari `AUTH_SECRET`.
- `scripts/e2e-server.mjs` — boot `next start` produksi pada scratch DB; dipakai untuk verifikasi binary Go.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/db.ts` -- Blok schema v8 setelah v7: `ALTER TABLE bmad_backlogs ADD COLUMN IF NOT EXISTS` untuk ketiga kolom promosi, lalu FK composite `(project_id, promoted_to_task_id) → bmad_tasks(project_id, id)` di-guard `hasCompositeForeignKey` -- idempoten dan memaksa invariant promoted ⇒ task ada.
- [x] `src/lib/backlogs.ts` (baru) -- Tipe `BacklogItem` + `createBMadBacklog` (id `BKL-<n>` berurutan per project, retry 23505, status dipaksa `draft`), `getBMadBacklogs(projectId, status?)`, `reportBacklogImpact`, `promoteBacklogToTask` (satu transaksi, idempoten) -- logika DB terpusat agar route tipis.
- [x] `src/app/api/projects/[projectId]/backlogs/route.ts` (baru) -- GET (list + filter status) dan POST (create) -- dua tool MCP pertama.
- [x] `src/app/api/projects/[projectId]/backlogs/[backlogId]/impact/route.ts` (baru) -- POST impact: validasi `riskLevel`, tolak promoted -- menyimpan analisis verbatim.
- [x] `src/app/api/projects/[projectId]/backlogs/[backlogId]/promote/route.ts` (baru) -- POST promote: satu transaksi, respons `KanbanTaskItem` -- kontrak klien Go.
- [x] `tests/matrix/bmad-backlog.spec.ts` (baru) -- Setiap baris I/O Matrix di atas punya test pada scratch DB.

**Acceptance Criteria:**
- Given dua project, when `BKL-001` dibuat di keduanya lalu keduanya dipromosikan, then terdapat dua backlog `promoted` dan dua task, masing-masing milik projectnya sendiri.
- Given backlog yang sudah dipromosikan, when promote dipanggil lagi, then respons membawa task id yang sama dan `bmad_tasks` tidak bertambah satu baris pun.
- Given promote sedang berjalan, when INSERT task berhasil tapi UPDATE backlog gagal, then seluruh transaksi dibatalkan (tidak ada task yatim) — dibuktikan lewat struktur transaksi dan pin FK, bukan dengan mematikan DB.
- Given `npm run test:matrix`, when dijalankan, then seluruh test story 1 tetap hijau dan test baru hijau.
- Given binary Go asli berjalan dengan `HOME` terisolasi terhadap server di scratch DB, when keempat tool backlog dipanggil, then semuanya sukses tanpa 404 dan outputnya menampilkan id task hasil promote.

## Implementation Notes

- Dikerjakan subagent implementasi dari spec ini; diff diaudit baris-per-baris terhadap tasks dan I/O matrix oleh sesi induk (semua baris tercakup; `npm run test:matrix` 157/157 dan `npm run verify` exit 0 dijalankan induk sendiri).
- FK v8 memakai `ON DELETE NO ACTION` (default) dengan advisory lock sendiri (`730_200_002`), satu blok transaksi pada satu client setelah `migrateProjectScopedKeys()`.
- `reportBacklogImpact` menolak lewat `UPDATE ... WHERE status <> 'promoted'` (bukan check-then-write) — nol baris dibedakan 404 vs 409 lewat bacaan lanjutan.
- Promote memakai `SELECT ... FOR UPDATE` sehingga dua promote bersamaan pada satu backlog berserialisasi; yang kalah melihat commit pemenang dan mengembalikan task yang sama (200).
- Verifikasi binary Go (sesuai Verification): server produksi di scratch DB port 4319, MCP access token ditempa dari `AUTH_SECRET` (HS256, `aud: bmad-mcp`, `iss: onyx-auth`), `HOME` sementara, binary dibangun segar (`go build ./cmd/bmad-monitor`). Hasil: `initialize` OK; `awm_backlog_create` → `BKL-001`; `awm_backlog_list` OK; `awm_backlog_report_impact` OK; `awm_backlog_promote` → `TASK-001`; promote ulang → `TASK-001` yang sama; ground truth DB: `status=promoted`, `promoted_to_task_id=TASK-001`, task ada, tanpa yatim. Scratch DB dijatuhkan dan HOME temporer dihapus setelahnya.
- Dua jebakan verifikasi yang tercatat: (1) probe kesiapan hanya `GET /login` membuat permintaan balapan dengan `ensureSchema` — race D-1 yang memang jadi temuan story 4; probe harus sampai `query()` seperti harness matrix. (2) Server yatim dari run gagal tetap memegang port dan diam-diam dilayani — script verifikasi akhirnya memeriksa port lebih dulu dan membunuh proses group.

## Review Triage Log

### 2026-11-06 — Tiga lapisan (blind-hunter, edge-case-hunter, verification-gap), iterasi 1

- `[medium]` `[patch]` Body kosong/malformed ditolak 500 oleh parser (`req.json()` melempar; `?? {}` hanya menangkap null literal) di ketiga route baru — dilaporkan tiga lapisan; pola perbaikan `resolve/route.ts:29` sudah ada di repo.
- `[medium]` `[patch]` Create pada projectId tak dikenal → FK 23503 → 500 membawa pesan Postgres mentah; klien Go dapat menyimpan id project basi — 404 bersih lewat pemetaan error, bukan pre-check tambahan.
- `[medium]` `[patch]` `nextSequentialId` overflow `::int` bila ada id eksplisit ≥10 digit (BKL-9999999999) meracuni create/promote berikutnya di project itu — batasi regex ke `{1,9}` digit.
- `[low]` `[patch]` `?status=` tak dikenal diam-diam 200 `[]` padahal riskLevel/targetStage divalidasi ketat — 400 dengan kosakata yang dikenal.
- `[low]` `[patch]` `source` bawaan "web" bertentangan dengan kontrak tool awm_backlog_create ('t3_code') — bawaan diubah; `createdBy` tetap sesuai keputusan Design Notes.
- `[medium]` `[patch]` (pre-verified, verification-gap) Branch 409 id-eksplisit-duplikat tak punya test — tanpa test, branch dapat membusuk jadi 500 "race" menyesatkan.
- `[medium]` `[patch]` Trio `promoted_*` tak pernah diasersi lewat body HTTP — regresi mapping `toBacklogItem` lolos dari suite.
- `[medium]` `[patch]` Scoping lintas project impact/promote tak teruji (semua 404 memakai id fiktif) — kebingungan composite-key yang menjadi alasan story ini tak terkunci.
- `[high]` `[patch]` (pre-verified, verification-gap) `FOR UPDATE` + retry loop tak teruji: tanpa lock, dua promote bersamaan menghasilkan dua task dan menimpa `promoted_to_task_id`; demonstrasi reviewer membuktikan tak ada test yang gagal — invariant "satu promote satu task" regredisen diam-diam.
- `[high]` `[patch]` (pre-verified, verification-gap) Branch idempotensi-restart v8 (`hasCompositeForeignKey` skip) tak pernah dieksekusi verifikasi mana pun karena setiap boot memakai DB segar — guard rusak terkapar sebagai outage total saat restart; test re-entrancy (`vi.resetModules()` + override `DATABASE_URL` + `import("@/lib/db")` + `ensureSchema()`) ditambahkan.
- `[low]` `[patch]` Fixture `breakingChangeDetails: ""` tidak setia pada bentuk Go (omitempty) — field kosong dihilangkan.
- `[low]` `[reject]` Status `discarded` tak ada di kosakata server — tak ada jalur API yang menulis status itu hari ini; gagal keras pada kondisi tak terjangkau bukan defect.
- `[low]` `[reject]` Analisis ulang pada backlog `analyzed` menimpa analisis lama tanpa history — memperbarui analisis sebelum promote adalah penggunaan wajar tool; 409 justru mematikan alur revisi.
- `[false]` `[reject]` "Repeat promote dengan targetStage berbeda menelan permintaan tanpa sinyal" — spec Always menetapkan "promote kedua mengembalikan task yang sama (200)"; mengembalikan task yang tidak berubah adalah perilaku yang diminta, dan kini dipinkan test agar tidak berubah diam-diam.
- `[low]` `[reject]` Tanpa batas ukuran payload impact — permukaan hanya untuk pemanggil terautentikasi (guardBmadApi) dan cap adalah keputusan produk di luar intent.

**Patch diterapkan (iterasi 1):** ketiga route mem-parse `req.json().catch(() => null)`; `createBMadBacklog` memetakan 23503 → 404 tanpa retry; `nextSequentialId` dibatasi `{1,9}` digit; `?status=` divalidasi; bawaan `source` menjadi `t3_code`; fixture impact tidak lagi memuat field omitempty kosong; lima pin baru (409 id duplikat, trio promoted via body HTTP, scoping lintas project, promote/create paralel, repeat promote targetStage berbeda) plus test re-entrancy v8. Suite menjadi 14 test; `npm run verify` exit 0 (unit 45, matrix 161, e2e 23) dan verifikasi binary Go diulang pada kode terpatch — `ALL CHECKS PASSED`.

## Design Notes

Id `BKL-<n>` berurutan per project (bukan timestamp): id terlihat manusia di CLI dan dokumentasi memakai `BKL-001`. Pembacaan `MAX(n)+1` di dalam transaksi + retry 23505 meniru pola `resolveProject` yang sudah terbukti — dua create bersamaan konvergen, tidak pernah menimpa antar project karena PK composite.

`suggestedChecklists` dari analisis TIDAK disalin ke `checklists` task: spec tidak memintanya dan bentuknya berbeda (`estimatedEffort` vs `completed`). Menyalinnya diam-diam adalah keputusan produk, bukan implementasi.

`promoted_by` diisi dari field opsional body (default `"bmad-agent"`): klien Go tidak mengirimnya hari ini, dan mem-parsing ulang bearer di route menambah gandengan tanpa pemakai.

## Verification

**Commands:**
- `npm run build` -- expected: sukses tanpa error type.
- `npm run test:matrix` -- expected: seluruh file matrix hijau termasuk `bmad-backlog.spec.ts`.
- Skrip verifikasi Go (dibuat sesi ini, dibuang setelah dipakai): boot `scripts/e2e-server.mjs` pada scratch DB + port bebas, tempa MCP token dari `AUTH_SECRET`, tulis `HOME` sementara berisi `config.json`, kirim `initialize` + `tools/call` keempat tool backlog lewat stdio -- expected: keempatnya sukses, `awm_backlog_promote` mengembalikan `TASK-*`, dan panggilan promote ulang mengembalikan id yang sama.

**Manual checks (if no CLI):**
- `psql` pada scratch DB: `SELECT status, promoted_to_task_id FROM bmad_backlogs` menunjukkan setiap `promoted` memuat id task yang ada di `bmad_tasks` project yang sama.
