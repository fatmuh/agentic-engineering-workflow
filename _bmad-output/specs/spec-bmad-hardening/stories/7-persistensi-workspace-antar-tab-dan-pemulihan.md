---
title: 'Persistensi workspace antar-tab dan pemulihan'
type: 'feature'
created: '2026-11-07'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: '49de1374114e65f6320a123d0fd22b78d1d4c32d'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Dua lubang pada pemilihan workspace. (D-8a) Pilihan disimpan di `localStorage` tetapi tidak ada listener `storage`, sehingga tab kedua yang terbuka tetap menampilkan workspace lama sampai di-reload — dua tab bisa menampilkan dua workspace berbeda padahal pengguna menganggap keduanya sama. (D-8b) `reload()` diekspos context tetapi hanya dipakai tombol "Coba lagi" di menu switcher; ketika daftar project gagal dimuat, board dan sidebar tidak menawarkan pemulihan selain reload halaman penuh.

**Approach:** Dengarkan event `storage` untuk kunci pilihan aktif dan terapkan pilihan yang ditulis tab lain, dengan penanda asal-perubahan agar tab penerima tidak menulis balik (loop osilasi dua tab). Hubungkan `reload()` ke afordans yang terlihat: pesan gagal di sidebar dan tombol Refresh board, sehingga kegagalan daftar project dapat dipulihkan tanpa memuat ulang halaman.

</frozen-after-approval>

## Boundaries & Constraints

**Always:** Event `storage` hanya boleh diterapkan bila `key` cocok dan `newValue` menunjuk project yang ada di daftar yang sudah dimuat; nilai yang tidak dikenal diabaikan (bukan mengosongkan pilihan). Tab penerima tidak menulis balik ke `localStorage` untuk nilai yang baru saja diterimanya — satu penanda per penerapan, bukan per render. Penulisan pilihan oleh pengguna tetap terjadi seperti sekarang. `reload()` tetap men-set `status` ke `loading` dan menaikkan token; pemanggilan dari handler, bukan dari efek. Kedua afordans baru memakai `reload()` yang sama, bukan jalur kedua. `localStorage` yang diblokir (private mode) tetap tidak membuat aplikasi crash dan tidak mematikan sinkronisasi dalam satu tab. Test yang ada tetap hijau.

**Never:** Tidak memakai `BroadcastChannel`, WebSocket, atau SSE — SPEC menetapkan sinkronisasi lewat event `storage`. Tidak mengubah bentuk data yang disimpan atau kunci `localStorage`. Tidak menyentuh endpoint. Tidak menambah dependensi.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tab lain mengganti workspace | tab B menulis id project yang ada | Tab A berpindah ke project itu tanpa reload | tidak ada error |
| Tab A menerima, lalu menulis | penanda asal-perubahan aktif | Tab A tidak menulis balik; tidak ada osilasi | tidak ada error |
| Nilai tidak dikenal | tab lain menulis id yang tak ada di daftar | Tab A mengabaikan; pilihan tetap | tidak ada error |
| Kunci lain berubah | `storage` untuk kunci lain | Tidak ada efek | tidak ada error |
| Penghapusan nilai | `newValue === null` | Pilihan tidak dikosongkan; daftar tetap memilih yang ada | tidak ada error |
| Tab A sendiri menulis | pengguna memilih di tab A | `storage` tidak terpicu di tab A; perilaku normal | tidak ada error |
| Daftar project gagal | `/api/projects` gagal | Sidebar dan board menampilkan afordans pemulihan yang memanggil `reload()` | setelah berhasil, daftar tampil tanpa reload halaman |
| `localStorage` diblokir | akses melempar | Aplikasi tetap berjalan; sinkronisasi antar-tab mati, dalam-tab normal | tidak ada error |

## Code Map

- `src/components/dashboard/project-context.tsx:37-52` — `readStoredProjectId` / `storeProjectId` (kunci `STORAGE_KEY = "bmad-monitor.active-project-id"`); tempat listener dan penanda ditambahkan.
- `src/components/dashboard/project-context.tsx:117-165` — fetch daftar + `resolveActiveProjectId` + penulisan pilihan; sumber daftar yang memvalidasi id dari tab lain.
- `src/components/dashboard/project-context.tsx:167-181` — `setProjectId` / `reload()`; `reload` sudah ada dan menjadi satu-satunya jalur pemulihan.
- `src/components/dashboard/app-sidebar.tsx:60` — konsumsi context (`status: projectStatus`, `reload`) yang sudah diteruskan ke switcher.
- `src/components/dashboard/agent-board-view.tsx:357-378` — pesan gagal board (`projectMessage`) dan pesan task; tempat afordans pemulihan daftar project ditambahkan.
- `src/components/dashboard/agent-board-view.tsx:417-424` — tombol Refresh yang sudah ada (memuat ulang data board, bukan daftar project).
- `src/components/dashboard/workspace-switcher-state.ts` + `.test.ts` — pola modul murni + unit test node yang dipakai repo untuk logika UI.

## Tasks & Acceptance

**Execution:**
- [x] `src/components/dashboard/project-context.tsx` -- Tambah listener `storage` yang menerapkan pilihan dari tab lain hanya bila kuncinya cocok dan id-nya ada di daftar; tandai penerapan itu agar efek penulisan melewatkannya -- sinkronisasi antar-tab tanpa osilasi.
- [x] `src/components/dashboard/project-selection.ts` (baru) -- Logika murni di balik listener (cocokkan kunci, validasi id, keputusan menerapkan/melewatkan penulisan) agar bisa diuji di lingkungan node -- repo tidak punya jsdom.
- [x] `src/components/dashboard/project-selection.test.ts` (baru) -- Seluruh baris I/O Matrix yang bisa diuji murni: nilai valid, nilai tak dikenal, kunci lain, `newValue === null`, penanda penerapan, `localStorage` melempar.
- [x] `src/components/dashboard/agent-board-view.tsx` -- Saat status daftar project `"error"`, tampilkan afordans pemulihan yang memanggil `reload()` dan sebutkan bahwa daftar workspace gagal dimuat -- pemulihan tanpa reload halaman.
- [x] `e2e/workspace-switcher.spec.ts` -- Kasus pemulihan: paksa `/api/projects` gagal, klik afordans, biarkan request kedua berhasil, pastikan daftar workspace muncul tanpa navigasi halaman -- membuktikan `reload()` benar-benar terhubung.

**Acceptance Criteria:**
- Given dua tab terbuka, when satu tab mengganti workspace, then tab lain berpindah ke workspace itu tanpa reload dan tanpa menulis balik.
- Given tab lain menulis id yang tidak ada di daftar, when event `storage` diterima, then pilihan tab ini tidak berubah.
- Given `/api/projects` gagal, when pengguna memakai afordans pemulihan, then daftar dimuat tanpa reload halaman penuh.
- Given `localStorage` melempar saat diakses, when aplikasi dijalankan, then aplikasi tetap berfungsi dan pemilihan dalam-tab tetap berjalan.
- Given `npm run verify`, when dijalankan, then seluruh suite yang ada tetap hijau.

## Implementation Notes

- Sinkronisasi lintas-tab: listener `storage` di `project-context.tsx` memakai logika murni di `project-selection.ts` (diuji 23+ kasus di lingkungan node). Penanda asal-perubahan dipegang sampai pilihan berpindah; `persistSelection` tidak menulis ulang nilai yang sama, jadi tab yang sekadar boot tidak memancarkan event.
- `event.storageArea` diperiksa, sehingga tulisan `sessionStorage` dengan kunci sama tidak mengganti workspace. Adopsi lintas-tab diumumkan lewat live region shell.
- D-8b: `reload()` terhubung ke tiga afordans (board, sidebar, menu switcher). Cabang "basi tetapi berisi" di board dan sidebar DIHAPUS setelah terbukti tak terjangkau — tak ada jalur yang memanggil `reload()` saat baris masih termuat. `WORKSPACE_LIST_STALE` dipertahankan hanya untuk menu switcher, satu-satunya tempat keadaan itu benar-benar tercapai.
- Copy kegagalan daftar workspace kini satu konstanta per kalimat (`WORKSPACE_LIST_FAILED`, `WORKSPACE_LIST_STALE`, `projectListFailure`) yang dipakai switcher, board, sidebar dan kedua spec e2e — empat ejaan menjadi satu.
- Tombol Refresh board jatuh ke `reload()` saat `projectId` null, sehingga terhubung ke pemulihan seperti yang diminta Approach.
- Bulatan fokus: notice memisahkan teks live region dari tombol aksi (fokus ke tombol tidak mengumumkan ulang), dan kedua jalur retry memindahkan fokus ke kontainer stabil sebelum unmount.
- `login()` e2e kini menggagal dengan URL akhir + teks halaman terlihat. Ini yang mengubah "element not found" menjadi diagnosis yang benar selama penelusuran flakiness.
- Bukti: `npm run verify` exit 0 — unit 94, matrix 180, e2e 40. Stabilitas: `workspace-switcher.spec.ts` 112/112 pada `--repeat-each=8 --workers=4`.

## Review Triage Log

### 2026-11-07 — Tiga lapisan, iterasi 1

- `[high]` `[patch]` (pre-verified, verification-gap) Dua test e2e pemulihan bergantung beban dan akan gagal di CI (retries 0): satu counter `attempts` dipakai bersama DUA navigasi — `login()` mendarat di `/` (mengeluarkan `/api/projects` = percobaan #1, yang diberi 500), lalu `goto("/agent-board")` me-mount ulang provider (percobaan #2, 200), sehingga board tak pernah melihat kegagalan. Terukur: `--workers=2` gagal 2–4 dari 12; `--workers=4` gagal 4 dari 12; `--workers=1` lolos 6/6.
- `[high]` `[patch]` (pre-verified, verification-gap) Penekanan notice ganda (`projectListBlocked`) tak terverifikasi: membaliknya, atau menyempitkan `projectListNotice` ke `!projectId`, meninggalkan 38/38 e2e dan 94/94 unit hijau.
- `[medium]` `[patch]` (pre-verified, verification-gap) Branch pemulihan sidebar **collapsed** dan render mobile-drawer tak terverifikasi: mengganti branch collapsed dengan `return null` meninggalkan 12/12 hijau — justru konfigurasi yang disebut D-8b.
- `[medium]` `[patch]` Copy notice salah pada kasus basi: berbunyi "Gagal memuat daftar workspace." padahal baris masih tampil dan hanya refresh yang gagal; `switcherCopy` sudah membedakannya.
- `[medium]` `[patch]` Tombol Refresh di board diam-diam mati tepat pada keadaan yang memunculkan notice (`projectId` null), padahal Approach spec menyebut tombol itu secara eksplisit.
- `[medium]` `[patch]` `persistSelection` mengembalikan id walau `stored === projectId`, jadi setiap mount menulis ulang — hanya aman karena browser mendedupe nilai identik, hal yang justru dilarang header modul. Jalur runtime tersering (tab sekadar boot) tak punya test.
- `[medium]` `[patch]` Model dua-tab di unit test memanggil `persist` tanpa syarat, sedangkan listener asli memakai updater yang mengembalikan nilai sama sehingga React melewati render dan efek persist tak pernah jalan — test mengasersi rule atas pass yang tak terjadi.
- `[medium]` `[patch]` Header modul menyatakan penanda "dikonsumsi sekali", sedangkan doc fungsi dan implementasi memegangnya sampai pilihan berpindah — header mendeskripsikan bug yang justru dihindari.
- `[medium]` `[patch]` Listener tak memeriksa `event.storageArea`, sehingga tulisan `sessionStorage` dengan kunci sama dari iframe same-origin akan mengganti workspace tab ini.
- `[medium]` `[patch]` Adopsi lintas-tab senyap bagi pembaca layar: jalur `storage` melewati toast dan live region. Pengumuman lewat `useAnnounce()` yang ada, dan e2e dua-tab mengasersi live region.
- `[medium]` `[patch]` Listener memvalidasi terhadap `projectsRef` yang ditulis efek setelah render, sehingga event yang tiba di antara `setProjects` dan efek itu memakai daftar lama dan membuang id yang sah.
- `[low]` `[patch]` Pemulihan sidebar berupa tombol polos tanpa live region, padahal berita yang sama di board diumumkan.
- `[low]` `[patch]` `BoardNotice` menaruh `Button` fokusable di dalam `<p role="status">`, sehingga fokus ke tombol mengumumkan ulang seluruh kalimat.
- `[low]` `[patch]` Tombol retry unmount saat `reload()` men-set `loading`, menjatuhkan fokus ke `<body>`, dan retry lambat tak bisa dibedakan dari yang mati.
- `[low]` `[patch]` Satu kalimat punya empat ejaan di tiga modul, dengan regex e2e terpaku pada dua di antaranya — satu konstanta per kalimat.
- `[low]` `[patch]` Modul "murni" mengimpor `ProjectStatus` dari modul `"use client"`, membalik aturan dependensinya sendiri.
- `[low]` `[patch]` `deliverOwnWrite` dan `totalWrites` didefinisikan tetapi tak dipanggil test mana pun; asersi kunci memakai string mentah alih-alih konstanta yang diekspor.
- `[low]` `[patch]` Asersi negatif `/muat ulang halaman/i` bersifat seluruh halaman — rapuh dan bisa lulus karena alasan salah.
- `[low]` `[patch]` Judul test kedua menjanjikan "daftar masih gagal" padahal route gagal sekali lalu sukses.
- `[low]` `[patch]` Dua test pemulihan menduplikasi ~15 baris setup route termasuk serialisasi payload yang sudah punya helper.
- `[low]` `[reject]` "Divergensi dari frozen Approach (tombol Refresh)" — ditangani sebagai patch di atas, bukan renegosiasi: tombol Refresh kini jatuh ke `reload()` ketika `projectId` null, sehingga Approach terpenuhi tanpa mengubah frozen block.

### 2026-11-07 — Lead, iterasi 2 (pengukuran mandiri)

- `[high]` `[patch]` **Terverifikasi ulang, dengan koreksi.** Klaim pertama implementer ("pre-existing") dan klaim kedua ("80/80 lolos") sama-sama tidak tereproduksi di tangan saya: sesudah perbaikan `afterAll`, run saya memberi 135 lolos / 5 gagal. Empat di antaranya memang test yang sudah ada (line 197), satu adalah test collapsed yang saya minta. Saya perbaiki sendiri test collapsed (poll global bisa menunggu angka yang tak pernah naik — kini `reset()` lalu poll dari nol) dan race hidrasi di test line 197 (klik sebelum handler terpasang; kini poll-klik-ulang). Akar masalah `afterAll` tetap seperti dilaporkan: `afterAll` berjalan per-file per-worker terhadap satu scratch DB, dan worker pertama menghapus user yang masih dipakai repeat lain — itu benar dan perbaikannya tepat. Setelah kedua perbaikan: **112/112 lolos** pada `--repeat-each=8 --workers=4`, dan test line 197 terbukti gagal 1/8 di baseline `49de137`, jadi memang pre-existing. Awalnya Pengukuran saya: test `sessionStorage` gagal 3/10 pada `--workers=4`, lolos 6/6 pada `--workers=1`, sementara `e2e/roles-sidebar.spec.ts` (yang juga login dengan akun sama) lolos 18/18 pada setelan paralel yang sama. Jadi bukan race teardown user bersama. Gejalanya: setelah StorageEvent di-dispatch, trigger switcher tidak ditemukan sama sekali ("element(s) not found") tanpa error React di log — artinya shell berhenti dirender. Diserahkan balik dengan instruksi menginstrumentasi `page.url()` + isi body SEBELUM dan SESUDAH dispatch, lalu memperbaiki penyebab yang terukur (bila itu bug produk di listener storage, itulah inti story ini).
- `[medium]` `[patch]` `login()` yang diam-diam mendarat di `/login` membuat semua asersi hilir berbunyi "element not found" — inilah yang membuat saya menelusuri beberapa ronde. Pesan gagal harus mencantumkan URL akhir dan teks galat yang terlihat.
- `[medium]` `[patch]` Implementer menghapus e2e kasus basi karena tak ada jalur UI yang mencapainya. Itu temuan produk, bukan problem test: branch notice "stale-but-populated" tak terjangkau karena tak ada yang memanggil `reload()` saat baris masih termuat. Pilih: hubungkan jalur yang terjangkau, atau hapus branch beserta copy-nya.

## Verification

**Commands:**
- `npm run build` -- expected: sukses.
- `npm test` -- expected: hijau, termasuk test modul baru.
- `npm run test:e2e` -- expected: hijau, termasuk kasus pemulihan dan (bila layak) dua tab.
- `npm run verify` -- expected: exit 0.
