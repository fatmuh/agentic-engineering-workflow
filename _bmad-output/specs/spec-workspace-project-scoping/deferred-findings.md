# deferred-findings.md — Temuan di luar scope, untuk diperbaiki setelah spec ini selesai

Berkas ini menampung temuan nyata yang **bukan** milik story mana pun di `stories.yaml`. Setiap entri punya bukti dan cara verifikasinya, supaya bisa dikerjakan di sesi terpisah tanpa menggali ulang.

## D-1 — `ensureSchema()` tidak punya lock bootstrap global (race multi-instance)

**Bukti:** diuji dengan 8 boot bersamaan terhadap satu database. HEAD tanpa perubahan story 1 gagal **5 dari 8** boot; dengan `pg_advisory_xact_lock` di v7 turun menjadi 1 dari 8.

**Akar masalah:** blok v2 menjalankan `ALTER TABLE refresh_tokens ... ADD COLUMN IF NOT EXISTS`, yang mengambil `AccessExclusiveLock` sebelum kode v7 mana pun berjalan. Blok DDL multi-statement lain juga berlomba di `pg_type`. Lock per-blok (seperti v7 punya) tidak cukup — yang dibutuhkan satu lock di seluruh `ensureSchema()`.

**Dampak:** deployment dengan lebih dari satu instance/replica dapat gagal boot secara acak. Untuk satu instance (kondisi sekarang) tidak berdampak.

**Cara menutup:** bungkus seluruh `ensureSchema()` dalam satu transaksi yang diawali `pg_advisory_xact_lock` dengan kunci tetap, atau pisahkan bootstrap ke proses migrasi terpisah yang dijalankan sekali sebelum instance naik.

## D-2 — Empat tool MCP memanggil route backlog yang tidak ada

**Bukti:** `internal/client/api_client.go` di repo `bmad-monitor-mcp` memanggil `/api/projects/{id}/backlogs`, `/backlogs/{id}/impact`, dan `/backlogs/{id}/promote`. Tidak ada satu pun route tersebut di `src/app/api/`. Tabel `bmad_backlogs` dibuat di `src/lib/db.ts` tetapi tidak pernah dibaca atau ditulis oleh kode TypeScript mana pun.

**Dampak:** `awm_backlog_create`, `awm_backlog_list`, `awm_backlog_report_impact`, dan `awm_backlog_promote` akan 404 pada pemakaian pertama.

**Cara menutup:** bangun tiga route backlog (list/create, impact, promote) dengan guard `guardBmadApi` dan scoping `projectId`, mengikuti pola route `tasks/`.

## D-3 — Tidak ada test otomatis yang menyentuh tabel BMad

**Bukti:** `vitest.config.mts` hanya menyertakan `src/**/*.test.{ts,tsx}` (dua berkas, keduanya tanpa `@/lib/db`). Grep `tests/` dan `e2e/` untuk `bmad_tasks`, `tasks/batch`, `prj_default`, `getBMadTasks` tidak menemukan apa pun.

**Dampak:** semua jaminan story 1 (composite key, cascade, idempoten, penolakan duplikat) hanya diverifikasi secara manual. Regresi tidak akan tertangkap `npm run verify`.

**Cara menutup:** tambahkan spec ke `tests/matrix/` (harness sudah menyediakan scratch DB dan `getPool()`): dua project dengan `TASK-101` masing-masing, delete task memverifikasi cascade, dua bentuk remote ditolak unique index, dan pembacaan `pg_constraint` untuk memastikan bentuk PK/FK.

## D-4 — Case-folding path tidak ditangani pada filesystem case-insensitive

**Bukti:** `normalizeWorkspacePath` sengaja tidak me-resolve symlink dan tidak menormalkan huruf. Di macOS (case-insensitive, dan repo ini sendiri berada di `/Volumes/...`), `/Users/X/proj` dan `/users/x/proj` menunjuk direktori yang sama tetapi menghasilkan dua kunci berbeda, sehingga workspace yang sama bisa menjadi dua project.

**Dampak:** hanya pada filesystem case-insensitive (macOS/Windows) dengan path berbeda kapitalisasi. Di Linux tidak terjadi.

**Cara menutup:** putuskan apakah path harus di-case-fold saat dinormalkan, atau diterima sebagai batasan yang didokumentasikan. Catat pilihannya di `identity-mapping.md` sebelum story 4 mulai memakai path sebagai identitas.

## D-5 — Token/kredensial tertanam di URL remote dapat bocor

**Bukti:** `NORMALIZED_REMOTE_SQL` membuang userinfo, sehingga `https://user:token@host/repo` dan `https://host/repo` menormalkan ke kunci yang sama. Pemilik baris pertama menyimpan URL mentahnya, dan siapa pun yang membaca baris `bmad_projects` melihat token itu.

**Dampak:** rahasia tersimpan di kolom `git_remote_url` yang ditampilkan di dashboard dan dikembalikan API.

**Cara menutup:** putuskan kebijakan — tolak remote yang mengandung kredensial, atau redaksi saat disimpan/dikembalikan. Ini keputusan produk, bukan sekadar perbaikan teknis.

## D-6 — Board menampilkan task demo palsu saat seed gagal

**Bukti:** `src/components/dashboard/agent-board-view.tsx:27-28,45` menginisialisasi state dari `demoAgentTasks`/`demoWorktreeRun` dan hanya menimpanya bila API mengembalikan array tidak kosong. Sejak story 3, seed tidak lagi berjalan di jalur baca, jadi bila seed saat boot gagal (DB tidak terjangkau, misalnya), board menampilkan data demo karangan sebagai seolah-olah data live, tanpa pembeda apa pun.

**Dampak:** pengguna melihat task yang tidak ada di database. Ini kelas kebingungan yang lebih buruk daripada board kosong.

**Cara menutup:** frontmatter/state board harus membedakan "kosong" dari "belum dimuat", dan menampilkan board kosong dengan pesan jelas alih-alih data demo. Dikerjakan bersama story 4.

## D-7 — Staleness per-project, bukan per-request, dan loadState digabung

**Bukti:** `agent-board-view.tsx` memakai penjaga `projectIdRef` yang hanya membandingkan id project. Poll 5 detik yang mulai sebelum reload pasca-mutasi dapat selesai setelahnya dan menimpa data yang lebih baru. Selain itu `loadState` tunggal dipakai untuk dua request terpisah (`tasks` dan `agent-tree`), sehingga kegagalan `agent-tree` saja menandai seluruh board gagal.

**Dampak:** data bisa mundur sesaat setelah approve/reject, dan board yang sehat bisa dilaporkan rusak hanya karena pohon agen gagal dimuat.

**Cara menutup:** tambahkan token monotonik per request (pola `latestLoadRef` di `permission-provider.tsx`) dan pisahkan `loadState` menjadi dua: board dan tree.

## D-8 — Persistensi workspace tidak sinkron antar-tab dan tidak bisa dipulihkan tanpa reload

**Bukti:** `project-context.tsx` mengekspos `reload()` yang tidak pernah dipanggil, dan tidak ada listener event `storage`. Dua tab terbuka akan saling menimpa pilihan; bila pemuatan daftar project gagal, dashboard tidak punya jalan pulih selain reload halaman penuh.

**Dampak:** pengguna yang membuka dua tab melihat workspace berbeda, dan kegagalan sesaat memaksa reload manual.

**Cara menutup:** dengarkan event `storage` untuk menyinkronkan pilihan, dan hubungkan `reload()` ke tombol Refresh di board atau ke keadaan error sidebar.

## D-9 — Sisa data demo dan detail UI pada Workspace Switcher

**Bukti:** `demoAgentTasks` di `agent-board-data.ts:123-198` tidak lagi direferensikan siapa pun (dead code, tidak tertangkap lint karena berupa export). Skenario "Pricing page · 3 branches" di tab Worktree masih merender `demoWorktreeRun` yang di-hardcode untuk setiap project. Switcher tidak punya keadaan memuat/kosong, tidak mengumumkan pergantian, dan `workspaceSubtitle` menaruh host git di slot yang CSS-nya masih digayakan sebagai tier plan. Toast pergantian berbahasa Inggris sementara string lain berbahasa Indonesia.

**Dampak:** sumber data palsu yang siap dipakai ulang oleh penulis berikutnya, dan ketidakkonsistenan bahasa/desain pada elemen yang terlihat.

**Cara menutup:** hapus `demoAgentTasks`; pindahkan `demoWorktreeRun` ke fixtures yang jelas tidak bisa diimpor kode aplikasi; tambahkan keadaan memuat/kosong pada switcher dan pengumuman pergantian; samakan bahasa toast.
