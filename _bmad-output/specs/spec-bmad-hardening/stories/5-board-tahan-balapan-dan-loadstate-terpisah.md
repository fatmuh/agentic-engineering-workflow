---
title: 'Board tahan balapan dan loadState terpisah'
type: 'bugfix'
created: '2026-11-06'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: 'f0fb55ec5bd64a86dd7454aef1ac12fb58fe22bd'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Dua cacat pada satu fungsi muat di `agent-board-view.tsx`. (1) Penjaga basi hanya membandingkan `projectId`, sehingga poll 5 detik yang START sebelum sebuah mutasi dapat SELESAI sesudah reload pasca-mutasi dan menimpa data yang lebih baru untuk project yang sama — pengguna melihat kartu kembali ke status lama sesaat setelah approve/reject. (2) `loadState` tunggal dipakai bersama oleh dua request terpisah (`tasks` dan `agent-tree`), sehingga kegagalan `agent-tree` saja menandai seluruh board gagal padahal daftar task berhasil dimuat — dan sebaliknya.

**Approach:** Beri setiap permintaan muat sebuah token monotonik per project (pola `latestLoadRef` di `permission-provider.tsx`): hanya muat yang paling baru dimulai boleh menulis state. Pisahkan `loadState` menjadi `tasksState` dan `treeState`; setiap tab dan setiap pesan kosong/gagal membaca state miliknya sendiri, bukan gabungan keduanya.

</frozen-after-approval>

## Boundaries & Constraints

**Always:** Token dinaikkan saat sebuah muat DIMULAI, bukan saat selesai; muat yang tokennya bukan yang terbaru membuang hasilnya tanpa menulis state apa pun (termasuk `lastSyncTime` dan `syncingFor`). Token terikat ke project: berpindah project memulai hitungan baru, sehingga muat lama dari project A tidak pernah dianggap mutakhir untuk project B. `tasksState` dan `treeState` bernilai `"loading"`/`"ready"`/`"error"` masing-masing; kegagalan salah satu tidak mengubah nilai yang lain. `lastSyncTime` hanya diperbarui oleh muat yang menyelesaikan kedua request. Muat ulang selalu memakai jalur yang sama, jadi fix ini tidak menambah API publik. Test matrix/e2e yang ada tetap hijau.

**Never:** Tidak mengubah endpoint, bentuk respons, atau aturan scoping. Tidak menambah library state. Tidak menyentuh `project-context.tsx` atau `app-sidebar.tsx` (itu story 7). Tidak menghapus penjaga `projectId` yang sudah ada — token melengkapinya, bukan menggantikannya.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Respons lama selesai terakhir | muat #1 ditunda, muat #2 selesai lebih dulu, #1 lalu selesai | State mencerminkan #2; #1 dibuang | tidak ada error |
| Muat tumpang tindih saat poll | poll 5 detik bertemu reload pasca-mutasi | Hasil reload (dimulai lebih baru) yang bertahan | tidak ada error |
| Ganti project saat muat berjalan | muat A dimulai, lalu pindah ke B | Hasil A dibuang; B memuat sendiri | tidak ada error |
| `agent-tree` gagal | tasks 200, tree 500 | `tasksState: "ready"`, `treeState: "error"`; daftar task tetap tampil; tab worktree menampilkan pesan gagal | tidak ada error |
| `tasks` gagal | tasks 500, tree 200 | `tasksState: "error"`, `treeState: "ready"`; tab worktree menampilkan pohon yang berhasil | tidak ada error |
| Keduanya gagal | tasks 500, tree 500 | Keduanya `"error"`, pesan masing-masing | tidak ada error |
| Keduanya kosong | 200 `[]` dan `null` | Keduanya `"ready"`; pesan "belum ada" | tidak ada error |
| Project berganti di tengah keduanya sukses | muat A sukses setelah pindah ke B | Tidak ada state A yang ditulis | tidak ada error |

## Code Map

- `src/components/dashboard/permission-provider.tsx:51-93` — pola acuan `latestLoadRef` + `isStale()`; salin semangatnya, bukan kodenya.
- `src/components/dashboard/agent-board-view.tsx:28` — tipe `LoadState` (tunggal) yang dipecah menjadi dua.
- `src/components/dashboard/agent-board-view.tsx:32-42` — `ProjectSnapshot` memuat `loadState` tunggal; `tasks`, `worktreeRun`, `lastSyncTime`.
- `src/components/dashboard/agent-board-view.tsx:60-83` — turunan `loadState` + `projectIdRef` + `syncingFor`; tempat token per project ditambahkan.
- `src/components/dashboard/agent-board-view.tsx:85-147` — `loadProjectData`: `Promise.allSettled` atas dua request, penjaga `isStale()` berbasis project, dan satu `setSnapshot`.
- `src/components/dashboard/agent-board-view.tsx:283-302` — pesan kosong/gagal yang membaca `loadState` gabungan; dipecah per tab.
- `src/components/dashboard/agent-board-view.tsx:350-353, 394-404` — tempat pesan board dan pesan worktree dirender.
- `src/components/dashboard/agent-board-data.ts` — `bmadTaskToAgentTask`; tidak berubah.

## Tasks & Acceptance

**Execution:**
- [x] `src/components/dashboard/agent-board-view.tsx` -- Tambah `loadTokenRef` per project dan naikkan token di awal setiap `loadProjectData`; buang hasil bila token bukan yang terbaru untuk project itu -- menutup penimpaan respons lama.
- [x] `src/components/dashboard/agent-board-view.tsx` -- Pecah `loadState` menjadi `tasksState` dan `treeState` pada `ProjectSnapshot`, isi masing-masing menurut hasil request yang bersangkutan, dan perbarui `lastSyncTime` hanya pada muat terbaru -- menutup kegagalan silang.
- [x] `src/components/dashboard/agent-board-view.tsx` -- Ubah pesan kosong/gagal dan render tab agar membaca state miliknya sendiri (`tasksState` untuk board, `treeState` untuk worktree) -- melaporkan kegagalan yang benar-benar terjadi.
- [x] `src/components/dashboard/board-load.ts` (baru) -- Pindahkan orkestrasi muat (token per project, aturan token mana yang boleh menulis, pemetaan hasil `allSettled` → `tasksState`/`treeState`) ke modul murni tanpa React, agar bisa diuji di lingkungan node yang sudah dipakai `vitest.config.mts` -- repo tidak punya jsdom/testing-library dan spec ini dilarang menambah dependensi.
- [x] `src/components/dashboard/board-load.test.ts` (baru) -- Setiap baris I/O Matrix yang bisa diuji murni (respons lama kalah, kegagalan silang, project berganti, keduanya kosong/gagal) -- pin perilaku tanpa browser.
- [x] `e2e/board-states.spec.ts` -- Kegagalan `agent-tree` saja menampilkan daftar task dan pesan gagal hanya di tab worktree, dengan `page.route` menolak `/agent-tree` -- membuktikan pemisahan state sampai ke layar.

**Acceptance Criteria:**
- Given sebuah muat yang dimulai lebih dulu ditunda, when sebuah muat yang dimulai lebih baru selesai lebih dulu, then state akhirnya memuat data muat terbaru dan hasil yang tertunda dibuang.
- Given `agent-tree` gagal sementara `tasks` berhasil, when muat selesai, then daftar task tampil dan pesan gagal hanya muncul di tab worktree.
- Given `tasks` gagal sementara `agent-tree` berhasil, when muat selesai, then pohon agen tampil dan pesan gagal hanya muncul di board.
- Given pengguna berpindah project saat sebuah muat berjalan, when muat lama selesai, then tidak ada state project lama yang ditulis.
- Given `npm run verify`, when dijalankan, then seluruh suite yang ada tetap hijau.

## Implementation Notes

- Orkestrasi muat dipindah ke `src/components/dashboard/board-load.ts` (murni, tanpa React) agar bisa diuji di `environment: "node"` yang sudah dipakai repo — tidak ada jsdom/testing-library dan spec melarang menambah dependensi.
- Token monotonik per project diambil saat muat DIMULAI; `setActiveProject` juga menaikkan serial saat MASUK ke project, sehingga kembali ke A tidak memvalidasi ulang token dari kunjungan sebelumnya. Muat yang superseded tidak menulis snapshot, `lastSyncTime`, maupun `syncingFor`.
- `BoardSnapshot.tasksState`/`treeState` bertipe `SettledState` (`"ready" | "error"`); `"loading"` hanya disintesis komponen dari status daftar project.
- Data lama yang dipertahankan saat salah satu request gagal kini diberi copy yang jujur ("Menampilkan data dari sync terakhir yang berhasil") alih-alih terbaca seolah daftarnya gagal dimuat.
- `readLoaded` memvalidasi bentuk respons (`parseTasks`/`parseTree`), sehingga 200 `{"error": ...}` tidak lagi menjadi "tidak ada task" — konvensi yang sama dengan `project-context.tsx`.
- Indikator sinkronisasi mendapat `data-sync-state` (dot-nya `aria-hidden`, jadi warna tak teramati test) — inilah yang membuat balapan bisa diasersi di level layar.
- Tiga test e2e: kegagalan agent-tree saja, kegagalan tasks dengan pohon KOSONG (kasus yang berbalik di bawah state gabungan lama), dan balapan fetch dengan respons pertama ditahan. Masing-masing diverifikasi lewat uji mutasi: melepas wiring token atau menyatukan state kembali membuatnya merah.
- Temuan harness yang diperbaiki: cascade delete `bmad_projects` di fixture e2e mengalami inversi urutan lock (deadlock 3/6 run) — kini menghapus anak lebih dulu dengan urutan yang sama seperti app.
- `npm run verify` exit 0: unit 58, matrix 180, e2e 26.

## Review Triage Log

### 2026-11-06 — Tiga lapisan, iterasi 1

- `[high]` `[patch]` Pesan gagal worktree TAK TERJANGKAU setelah pohon pernah termuat: `mergeLoad` mempertahankan `worktreeRun` lama, sedangkan pesan hanya dirender ketika `worktreeRun` falsy — jadi kegagalan `agent-tree` setelah load sukses pertama menampilkan pohon basi tanpa pesan apa pun. Persis kasus realistis (sempat berhasil, lalu gagal) yang jadi tujuan story ini.
- `[high]` `[patch]` (pre-verified, verification-gap) Test e2e kedua tak bisa gagal untuk regresi yang dinamainya: ia menyeed pohon NON-KOSONG, sehingga tab Worktree merender `WorktreeTree` baik pada kode lama (state gabungan) maupun baru — keempat asersinya lolos di versi yang bug. Kasus "tasks gagal, tree kosong" ditambahkan.
- `[medium]` `[patch]` `readLoaded` menerima body 2xx apa pun sebagai data: `{"error": ...}` dengan status 200 menjadi "tidak ada task" berstatus `ready`, dan body truthy non-node menjadi `WorktreeNode` karangan — fabrikasi diam-diam yang dilarang oleh header modul. Validasi bentuk ditambahkan, mengikuti konvensi `project-context.tsx`.
- `[medium]` `[patch]` (pre-verified, verification-gap) Bagian `syncingFor` dari aturan token tak terverifikasi di level mana pun: menghapus penjaga `isCurrent(token)` di `finally` membuat indikator hijau di tengah sinkronisasi, dengan seluruh suite tetap hijau.
- `[medium]` `[patch]` Pesan worktree tak punya branch belum-dimuat/tanpa-project seperti pesan board → "Memuat pohon agen…" selamanya ketika daftar workspace gagal atau kosong.
- `[medium]` `[patch]` Copy bawaan menyesatkan saat data lama dipertahankan: pesan "Gagal memuat…" tampil di atas daftar yang justru berhasil dimuat sebelumnya — kini menyebut datanya dari sinkronisasi terakhir.
- `[medium]` `[patch]` (pre-verified, verification-gap) Test e2e tak membuktikan BALAPAN sama sekali (hanya penolakan endpoint), padahal dev note story meminta fetch yang ditunda secara buatan — test dengan route handler yang menunda respons pertama dan Refresh di tengah ditambahkan; itulah satu-satunya test yang merah bila wiring token dihapus.
- `[low]` `[patch]` `console.warn` per request gagal → dua peringatan tiap 5 detik selamanya saat DB mati, plus satu lagi dari catch luar; kini dicatat sekali per transisi ke gagal.
- `[low]` `[patch]` Catch terakhir mengarang outcome "keduanya gagal" dan menduplikasi bentuk `LoadOutcome` — diselaraskan dengan dua jalur nyata.
- `[low]` `[patch]` `BoardSnapshot` menyatakan `tasksState`/`treeState` sebagai `LoadState` penuh termasuk `"loading"`, padahal `mergeLoad` hanya menulis `"ready"`/`"error"` — tipe dipersempit.
- `[low]` `[patch]` `deferred()` mengekspos `reject` yang tak dipakai test — row 6 dirutekan lewatnya sehingga urutan "penolakan tiba setelah separuh lain selesai" ikut diasersi.
- `[low]` `[patch]` Retry fixture-delete pada `40P01` saya nyatakan beban mati karena `e2e/global-setup.ts` sudah menunggu bootstrap commit. **Koreksi dari implementer (benar):** deadlock tereproduksi 3 dari 6 run setelah retry dilepas — penyebabnya inversi urutan lock yang nyata (cascade delete mengambil lock induk lebih dulu sementara app menyisipkan anak). Retry diganti perbaikan sebenarnya: hapus `bmad_agent_nodes` → `bmad_tasks` → `bmad_projects` sesuai urutan app menyentuhnya; 8/8 run bersih tanpa retry.
- `[low]` `[patch]` Komentar `STAMP` mengklaim retry Playwright mendapat id segar padahal itu state level-modul — digenerate per percobaan.
- `[low]` `[patch]` Test 1 mengasersi hal yang sama dua kali dengan DOM identik di antaranya — diganti asersi yang benar-benar berarti "hanya di tab yang datanya gagal".
- `[low]` `[reject]` "Tak ada `AbortController`; request lama tetap berjalan" — token menutup cacat yang dilaporkan (penimpaan state); pembatalan jaringan adalah peningkatan terpisah dan tidak mengubah apa yang dilihat pengguna.
- `[low]` `[reject]` "Tak ada timeout fetch di jalur board" — perilaku `apiFetch` berlaku untuk seluruh aplikasi, bukan cacat yang diperkenalkan story ini; mengubahnya di sini memperluas permukaan tanpa permintaan.
- `[low]` `[reject]` "`lastSyncTime` bergantung locale dan tanpa tanggal" — di luar intent; format waktu adalah keputusan produk yang sudah ada sebelum story ini.
- `[false]` `[reject]` "Unit test tak menyentuh wiring komponen sama sekali" — wiring komponen kini dipinkan di level layar oleh dua e2e (state terpisah + balapan + indikator), yang lebih tepat daripada menambah jsdom yang dilarang spec.

## Verification

**Commands:**
- `npm run build` -- expected: sukses.
- `npx tsc --noEmit` dan `npx eslint src/components/dashboard/agent-board-view.tsx` -- expected: bersih.
- `npm run verify` -- expected: hijau (unit, matrix, e2e).
