---
title: 'Bootstrap schema tahan multi-instance'
type: 'refactor'
created: '2026-11-06'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: '73b02035cb92d3f65fd289d81fd2c670bdfc1f6d'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `ensureSchema()` menjalankan blok v2–v6 sebagai `pool.query()` terpisah tanpa penguncian global. Dua proses yang boot bersamaan memperebutkan DDL yang sama: boot paralel 8× gagal 1 dari 8, dengan galat `duplicate key ... pg_type` saat `CREATE TABLE IF NOT EXISTS` berlomba. Lock per-blok (v7, v8, v9) tidak menolong karena blok-blok sebelumnya sudah berlomba sebelum lock mana pun diambil.

**Approach:** Seluruh `ensureSchema()` berjalan sebagai satu transaksi pada satu client yang diawali `pg_advisory_xact_lock` dengan kunci tetap. Blok v7, v8 dan v9 berhenti mengambil lock dan transaksi sendiri — mereka berjalan di dalam transaksi pemanggil. `lock_timeout` membatasi penantian: instance yang kalah karena instance pertama macet gagal dengan pesan yang jelas, dan `schemaReady` di-reset agar request berikutnya mencoba lagi.

</frozen-after-approval>

**Keputusan (2026-11-06):** lock memakai `lock_timeout` (60 detik) lalu gagal dengan pesan yang menyebut proses lain sedang memegang lock; `schemaReady` di-reset sehingga percobaan berikutnya mengulang. Alternatif tunggu-tanpa-batas ditolak karena instance yang macet akan menggantung semua instance lain tanpa batas.

## Boundaries & Constraints

**Always:** Satu `pool.connect()`, satu `BEGIN`, satu `COMMIT` untuk seluruh bootstrap. `pg_advisory_xact_lock` diambil **sebelum** DDL pertama, sehingga tidak ada dua instance yang menjalankan DDL bersamaan. `SET LOCAL lock_timeout` diberlakukan per transaksi. IDempoten: boot kedua pada database yang sudah termigrasi menjalankan DDL yang sama-sama no-op dan commit tanpa error. Sub-migrasi (v7, v8, v9) menerima client pemanggil, tidak lagi membuka transaksi sendiri, dan tetap memakai guard katalog masing-masing. Kegagalan apa pun me-ROLLBACK seluruh bootstrap dan me-reset `schemaReady`. `migrateLegacySchema` ikut di dalam transaksi. Test matrix tetap hijau.

**Never:** Tidak memisahkan migrasi ke proses/CLI terpisah. Tidak mengubah isi DDL, aturan normalisasi, atau bentuk index. Tidak menambah lock per-blok (lock global membuatnya mubazir). Tidak mengubah perilaku `query()` di luar bootstrap.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Boot tunggal, DB kosong | satu proses | Semua blok berjalan, commit; skema lengkap | tidak ada error |
| Boot tunggal, DB termigrasi | satu proses | Semua blok no-op, commit; tidak ada DDL efektif | tidak ada error |
| N proses bersamaan | 4+ proses boot serentak | Semua selesai tanpa error; skema identik dengan boot tunggal | tidak ada error |
| Lock macet | instance pertama mati saat memegang lock | Instance lain menunggu sampai `lock_timeout`, lalu gagal dengan pesan yang menyebut lock | `schemaReady` di-reset; request berikutnya mencoba lagi |
| Gagal di tengah DDL | error pada blok mana pun | Seluruh bootstrap di-ROLLBACK; tidak ada skema setengah jadi | error diteruskan; `schemaReady` di-reset |
| Request bersamaan dalam satu proses | dua request saat bootstrap berjalan | Keduanya menunggu promise `schemaReady` yang sama; hanya satu bootstrap | tidak ada error |
| Lock dilepas setelah timeout | instance pertama akhirnya commit | Percobaan berikutnya mengambil lock, menemukan skema lengkap, commit | tidak ada error |

## Code Map

- `src/lib/db.ts:699-1048` — `ensureSchema()`: rangkaian `pool.query()` untuk v2–v6 + panggilan `migrateLegacySchema()` dan tiga sub-migrasi; ini yang diubah menjadi satu transaksi.
- `src/lib/db.ts:78-100` — `migrateLegacySchema()` memakai `pool.query()` sendiri (DROP TABLE); harus ikut transaksi pemanggil.
- `src/lib/db.ts:305-521` (`migrateProjectScopedKeys`), `:557-583` (`migrateBacklogPromotion`), `:621-696` (`migrateWorkspaceCaseFold`) — masing-masing `pool.connect()` + `BEGIN` + `pg_advisory_xact_lock` sendiri; lock dan transaksi lokalnya dihapus.
- `src/lib/db.ts:145-205` — `attnumOf` / `hasCompositeForeignKey` / `hasSingleColumnForeignKey` memakai tipe `{ query: typeof pool.query }`; tipe client yang dipakai `PoolClient` kompatibel, jadi sub-migrasi cukup menerima client.
- `src/lib/db.ts:140-150` — docstring kategori lock v7/v8/v9 (`SCHEMA_V7_ADVISORY_LOCK` dsb.) yang menyatakan alasan per-blok; harus diperbarui.
- `tests/matrix/global-setup.ts` — boot tunggal terhadap scratch DB; menambah boot paralel berarti beberapa proses terhadap SATU database, yang bukan yang dilakukan harness ini.
- `scripts/test-db.mjs` — `createScratchDb` / `scratchConnectionString` untuk menyiapkan database bersama bagi test multi-instance.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/db.ts` -- Ubah `ensureSchema()` menjadi satu transaksi pada satu client: `pool.connect()`, `SET LOCAL lock_timeout`, `pg_advisory_xact_lock(SCHEMA_BOOTSTRAP_ADVISORY_LOCK)`, lalu seluruh blok v2–v6, `migrateLegacySchema(client)`, dan ketiga sub-migrasi dengan client yang sama; `COMMIT` di akhir, `ROLLBACK` pada error -- satu lock global adalah inti D-1.
- [x] `src/lib/db.ts` -- Hapus `pool.connect()`/`BEGIN`/advisory lock lokal dari `migrateProjectScopedKeys`, `migrateBacklogPromotion`, dan `migrateWorkspaceCaseFold`; ketiganya menerima `PoolClient` dan mengandalkan guard katalog masing-masing -- lock berlapis di dalam transaksi yang sama hanya menambah kompleksitas.
- [x] `src/lib/db.ts` -- `migrateLegacySchema` menerima client pemanggil dan berhenti memakai `pool.query()` -- DDL-nya harus atomik bersama sisanya.
- [x] `tests/matrix/bmad-bootstrap.spec.ts` (baru) -- Boot ulang `ensureSchema()` pada database yang sudah termigrasi tidak melakukan DDL efektif dan tidak error; jalankan terhadap scratch DB lewat pola `vi.resetModules()` + `DATABASE_URL` yang sudah dipakai spec lain -- pin idempotensi yang selama ini hanya berjalan sekali per run.
- [x] `scripts/verify-multi-instance.mjs` (baru, dipertahankan) -- Skrip yang menyiapkan scratch DB kosong lalu menjalankan N≥4 proses boot serentak terhadapnya, mencetak hasil per proses dan keluar non-zero bila ada yang gagal -- membuktikan CAP-1 dengan cara yang benar-benar menjalankan kondisi yang ditemukan.

**Acceptance Criteria:**
- Given database kosong dan 4 proses boot serentak, when semuanya selesai, then tidak ada yang gagal dan skema identik dengan hasil boot tunggal.
- Given database yang sudah termigrasi, when `ensureSchema()` dijalankan lagi, then tidak ada DDL efektif dan tidak ada error.
- Given error di tengah salah satu blok, when bootstrap gagal, then tidak ada objek skema parsial yang tersisa dan `schemaReady` di-reset sehingga percobaan berikutnya berjalan.
- Given instance lain memegang lock lebih lama dari `lock_timeout`, when instance ini menyerah, then pesan galat menyebut lock bootstrap dan bukan galat DDL acak.
- Given `npm run test:matrix`, when dijalankan, then seluruh test story 1–3 tetap hijau.

## Implementation Notes

- `ensureSchema()` kini satu transaksi pada satu client: `BEGIN` → `SET LOCAL lock_timeout = 60s` → `pg_advisory_xact_lock(730200001)` → seluruh blok v2–v9 (dipindah apa adanya ke `bootstrapSchema(client)`) → `COMMIT`; `ROLLBACK` + reset `schemaReady` pada error.
- Ketiga sub-migrasi (v7/v8/v9) dan `migrateLegacySchema` menerima `PoolClient`; lock dan transaksi lokalnya dihapus.
- Dua bug yang muncul saat mengerjakan ini dan diperbaiki: (1) `CREATE EXTENSION IF NOT EXISTS` best-effort tadinya akan membatalkan SELURUH transaksi (`25P02`) karena `catch {}` tak bisa menyelamatkan statement yang gagal di dalam transaksi — diperbaiki dengan `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`; (2) e2e mulai gagal `relation "users" does not exist` karena sekarang tidak ada yang terlihat oleh koneksi lain sebelum COMMIT, sedangkan playwright memulai spec begitu `GET /login` menjawab — ditutup dengan `e2e/global-setup.ts` yang menunggu relasi wajib benar-benar terlihat (barrier visibilitas, bukan sleep).
- Konstanta lock timeout dan kunci advisory diekspor dari `src/lib/schema-bootstrap.mjs` (+ `.d.mts`) supaya test tidak menduplikasi literal; blok katalog dipindah ke `scripts/catalog-shape.mjs` dan dipakai bersama skrip dan spec.
- `npm run test:multi-instance` ditambahkan ke `package.json` dan ke job CI yang sudah punya Postgres (tidak dimasukkan ke `npm run verify` agar tidak mem-fork 8 server tiap verify lokal).
- Bukti: 8 boot serentak sukses, skema identik (381 baris katalog) dan baris seed identik (`bmad_projects` 1, `roles` 3). Uji mutasi: menghapus lock membuat 5 dari 8 boot gagal (`deadlock detected`).
- Batasan yang disadari: rollout campuran versi lama/baru tidak terserialisasi — build lama tidak mengambil lock sebelum v2–v6, jadi deploy yang menumpuk instance lama dan baru masih bisa memicu race `pg_type` asli. Boot diasumsikan bergulir, bukan bertumpuk.

## Review Triage Log

### 2026-11-06 — Tiga lapisan, iterasi 1

- `[high]` `[patch]` (pre-verified, verification-gap) Test "lock sebelum DDL pertama" tak bisa gagal untuk regresi yang dinamainya: DDL belum commit tak terlihat observer lewat MVCC, jadi bootstrap yang menjalankan v2–v6 lalu memblokir tampak identik. Diganti dengan asersi bahwa backend PENUNGGU memegang nol relation lock.
- `[high]` `[patch]` (pre-verified, verification-gap) Bukti N-proses — kriteria utama CAP-1 — berada di luar semua jalur verifikasi otomatis; `npm run verify` dan CI sama sekali tidak memanggil skripnya. Skrip ditambahkan ke CI dan `package.json`.
- `[high]` `[patch]` (pre-verified, verification-gap) Test rollback menggagalkan blok PERTAMA, yang sejak dulu sudah rollback sendiri (batch multi-statement adalah satu transaksi implisit), sehingga tak membedakan transaksi luar yang baru dari desain per-blok lama; ditambah kasus yang menggagalkan blok BELAKANGAN dan mengasersi tabel dari blok AWAL hilang.
- `[medium]` `[patch]` (pre-verified, verification-gap) `migrateLegacySchema` kini di dalam transaksi dan `DROP TABLE users CASCADE` destruktif, tetapi tak ada test yang menyentuh branch legacy — kasus seed `users(id TEXT)` + `sessions` ditambahkan.
- `[medium]` `[patch]` `fail()` memakai `process.exit` sehingga `finally` pembersih tak berjalan — setiap run gagal membocorkan dua scratch DB; SIGINT/SIGTERM handler juga ditambahkan.
- `[medium]` `[patch]` Worker tidak menutup pool di jalur error → proses menggantung ~30 detik dan menahan induk.
- `[medium]` `[patch]` `bootOnce` tanpa batas waktu per anak → worker macet menggantung pemeriksaan selamanya.
- `[medium]` `[patch]` Skrip bisa lulus hampa bila schema `public` kosong ("identik, 0 baris") — asersi jumlah relasi minimum ditambahkan.
- `[medium]` `[patch]` Perbandingan hanya skema; baris seed yang hilang/ganda di bawah konkurensi tak terlihat — jumlah baris `bmad_projects` dan `roles` ikut dibandingkan.
- `[medium]` `[patch]` Query katalog diduplikasi verbatim di skrip dan spec — dipindah ke satu modul bersama.
- `[medium]` `[patch]` `lock_timeout` berlaku untuk seluruh transaksi, jadi timeout di DDL belakangan muncul sebagai 55P03 telanjang tanpa konteks bootstrap — dibungkus agar menyebut fase.
- `[low]` `[patch]` Branch `40P01` di `describeBootstrapLockFailure` tak terjangkau (penunggu yang memegang apa pun tidak membentuk siklus) dan menyesatkan untuk kasus satu-proses — dihapus.
- `[low]` `[patch]` `BOOTSTRAP_LOCK_TIMEOUT_MS` dan kunci advisory diduplikasi ke spec dengan komentar "jaga tetap sinkron" — diekspor dari `db.ts`.
- `[low]` `[patch]` `ROLLBACK TO SAVEPOINT` di catch extension tanpa `.catch()` dapat menimpa galat asli pada koneksi rusak — dijaga, galat asli dipertahankan.
- `[low]` `[patch]` `--worker` tanpa URL menyimpan string "undefined" dan menyambung ke database bernama "undefined" — kini gagal dengan pesan penggunaan; `--processes` dibatasi 64.
- `[low]` `[patch]` Query penunggu di spec juga cocok dengan penunggu dari database lain — `pg_locks` bersifat cluster-wide, jadi filter `database = current_database()` ditambahkan; kunci advisory memang per-database, tetapi filter membuat loop tidak bisa keluar karena penunggu asing.
- `[low]` `[defer]` Timeout `lock_timeout` yang terjadi di dalam blok DDL belakangan tidak diuji (butuh 60 detik nyata + table lock); dampaknya pesan diagnostik, bukan data — dicatat ke `deferred-work.md`.
- `[low]` `[reject]` "Perbandingan skema tak bisa mendeteksi blok yang no-op untuk semua" — itu berlaku untuk semua perbandingan terhadap acuan boot-tunggal; asersi jumlah relasi minimum yang ditambahkan sudah menutup kasus hampa yang nyata.
- `[false]` `[reject]` "Bootstrap dua modul dalam satu proses salah dilabeli 'proses lain'" — branch 40P01 memang dihapus, dan kasusnya jatuh ke 55P03 dengan pesan generik; label "proses lain" tidak lagi diklaim untuk kasus itu.

## Design Notes

Lock diambil **sebelum** DDL pertama, bukan sesudah: masalahnya adalah `CREATE TABLE IF NOT EXISTS` yang berlomba pada `pg_type`, jadi lock harus mendahului statement pertama, bukan memisahkan blok-blok besar.

`pg_advisory_xact_lock` hidup selama transaksi, jadi bootstrap harus benar-benar satu transaksi. Konsekuensinya bootstrap memegang satu koneksi pool selama berjalan — bisa diterima karena ia berjalan sekali per proses dan dibatasi `lock_timeout`/statement timeout, bukan per request.

`lock_timeout` dipasang per transaksi (`SET LOCAL`), bukan pada pool, supaya request normal tidak terpengaruh.

## Implementation Notes

**Shape.** `ensureSchema()` is now `pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout` → `pg_advisory_xact_lock` → `bootstrapSchema(client)` → `COMMIT`, with `ROLLBACK` + `client.release()` in the failure path and `schemaReady = null` in the existing memo-catch. The v2–v9 blocks moved verbatim into `bootstrapSchema(client)` so the transaction's shape is readable on its own; only `pool.query(` → `client.query(` changed inside them. `migrateLegacySchema`, `migrateProjectScopedKeys`, `migrateBacklogPromotion` and `migrateWorkspaceCaseFold` all take a `PoolClient` and neither begin, commit nor lock.

**Lock key.** `SCHEMA_BOOTSTRAP_ADVISORY_LOCK = 730_200_001` — the value the old per-block v7 lock used. The v7/v8/v9 constants are deleted, so nothing else in the codebase takes that key. The mixed-version caveat is stated in the comment: an instance still running the old build takes that key only around v7 and does not lock v2–v6, so a rolling deploy of this change is `roll`, not `overlap`.

**Deadlock reasoning (the parent session asked for this explicitly).** The suspected failure is a bootstrap DDL waiting on a lock held by a pool connection that is itself blocked. It cannot happen in this design because the ordering is total: the bootstrap takes the only lock it will ever wait for FIRST, while holding zero database locks, and every subsequent statement runs on the client that already owns that lock. So bootstrap never holds a lock and then waits for another. In-process concurrency is bounded by `schemaReady` (one bootstrap per process); cross-process concurrency waits at the advisory lock. The pool (max 10) loses exactly one connection for the bootstrap's duration, and the only things that could queue behind that are normal request queries, which take no conflicting lock — the advisory key is taken nowhere else. The harness readiness probe is a normal request: it either awaits the memoized promise in-process or queues on `pool.connect()` in another process, and cannot be the holder the bootstrap waits for. The protected version of this claim is the spec row "the advisory lock is taken before the first DDL statement", which holds the lock from a foreign session and asserts no table exists while the bootstrap is provably blocked.

**Failure messages.** `describeBootstrapLockFailure` rewrites ONLY `55P03` on the lock statement itself, and only that statement: a `lock_timeout` hit inside a later block is wrapped separately, by `ensureSchema`'s `bootstrapSchema` call, with a message that names the bootstrap phase and re-attaches the original code. There is no `40P01` branch — the waiter holds no database lock, so it cannot be part of a cycle, and a same-process second holder surfaces as an ordinary `55P03`. A branch for a code that cannot arrive would mislabel the case that does.

**Shared definitions.** The advisory key and the timeout live in `src/lib/schema-bootstrap.mjs` (with a `.d.mts`), not in `db.ts`: `db.ts` binds `DATABASE_URL` at import time and opens a pool, so a test that only wants the lock key must not import it at module scope. `.mjs` is the form both tsc and plain Node's type stripping resolve for a relative import from `db.ts`. The catalog-dump query and the seed-row counts live in `scripts/catalog-shape.mjs` for the same one-definition reason, shared by the matrix spec and the verification script.

**CI.** `npm run test:multi-instance` is a package script and a CI step in `.github/workflows/ci.yml`, deliberately NOT part of `npm run verify` (which would fork 8 Node processes on every local run). Without it CAP-1 could regress with an entirely green build.

**Decision found while building the spec.** Making the whole bootstrap one transaction means DDL is applied atomically — a failure partway through leaves the database EXACTLY as before. This is the "no partial state" acceptance criterion, but it has a second edge: a `CREATE TABLE IF NOT EXISTS` sees a conflicting relation only after `BEGIN`, so it no longer applies what it could. Early experiments confirmed this: a pre-existing `refresh_tokens` table now fails the boot and rolls the whole bootstrap back (before, the v2 block would create what it could and the failing statement alone failed). That matches the story's "Gagal di tengah DDL" row, and the recovery is the documented one — fix the conflicting object and retry, no restart. It is recorded because it changes what an operator sees on a hand-damaged database.

**Regression found and fixed during verification (savepoint).** The `CREATE EXTENSION IF NOT EXISTS pgcrypto` block is deliberately best-effort — the surrounding `catch {}` predates D-1. Inside one transaction a failed statement aborts the WHOLE transaction (25P02), so the `catch` no longer merely ignored this one statement: every following block would have died. The fix is a `SAVEPOINT pgcrypto_extension` / `RELEASE` / `ROLLBACK TO SAVEPOINT`, which preserves the original intent. The regression is pinned by the `pgcrypto` matrix test, which forces the extension install to fail by pre-creating `digest(bytea, text)`; with the savepoint removed that test fails with exactly `25P02 current transaction is aborted`, and with it restored it passes.

## Verification

**Commands:**
- `npm run build` -- expected: sukses. (run: exit 0)
- `npm run test:matrix` -- expected: seluruh file matrix hijau termasuk `bmad-bootstrap.spec.ts` and the story 1–3 files. (final run after the review pass: 8 files, 180 tests passed — 173 before this story, 7 new in `bmad-bootstrap.spec.ts`)
- `node scripts/verify-multi-instance.mjs` -- expected: 4+ proses boot terhadap satu database, semuanya sukses, skema akhir sama dengan boot tunggal. (run: 8 processes, all ok, 381 catalog rows AND seed rows `{"bmad_projects":1,"roles":3}` identical to the single boot)
- `npm run verify` -- expected: hijau. (not run in this session — the invoking session's constraints forbade it; `npm test` and `npm run test:e2e` were likewise left to the parent)

**Manual checks:**
- `npx tsc --noEmit` and `npx eslint src/lib/db.ts tests/matrix/bmad-bootstrap.spec.ts scripts/verify-multi-instance.mjs` — both clean.
- `node scripts/verify-multi-instance.mjs --processes=4` — same result at the story's minimum N.
