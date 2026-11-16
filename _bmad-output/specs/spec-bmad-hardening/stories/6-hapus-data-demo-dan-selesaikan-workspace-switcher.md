---
title: 'Hapus data demo dan selesaikan Workspace Switcher'
type: 'bugfix'
created: '2026-11-07'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: 'b2b5c833f21061d878eab1b2a4eb9637bbd345e5'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Dua sisa demo di permukaan yang dipakai operator. (D-9) `demoAgentTasks` masih diekspor dari kode aplikasi walau tak dipakai, toast pergantian workspace berbunyi Inggris ("Switched workspace to …") sementara seluruh teks lain Indonesia, dan Workspace Switcher tidak punya keadaan memuat maupun gagal — saat `/api/projects` belum selesai atau gagal, trigger hanya menampilkan tombol kosong tanpa penjelasan. (D-6) Tab Worktree merender `demoWorktreeRun` (pohon "Pricing page · 3 branches" karangan) sebagai keadaan bawaan tab, tanpa label yang membuatnya terbaca sebagai contoh di sekitar tempat ia tampil.

**Approach:** Hapus `demoAgentTasks` dari kode. Beri `WorkspaceSwitcher` prop keadaan (`loading`/`error`/`ready`) yang dirender sebagai isi trigger dan sebagai baris pertama menu, dan pindahkan string-nya ke Indonesia. Pertahankan `demoWorktreeRun` sebagai kontrol contoh yang eksplisit: bukan keadaan bawaan tab (bawaan `live`), dan setiap kali ia tampil, ada label yang menyatakan itu data contoh, bukan data database.

</frozen-after-approval>

## Boundaries & Constraints

**Always:** `demoAgentTasks` dan ekspornya hilang dari `src/`; tipe `AgentTask` tetap. Toast dan seluruh teks baru berbahasa Indonesia, konsisten dengan pesan tetangganya. Switcher tetap dapat dipakai saat `loading`/`error` — keadaan tidak boleh menyembunyikan atau menonaktifkan kontrol tanpa alasan. Pergantian workspace diumumkan ke pembaca layar lewat live region yang sudah ada di board (`role="status"` `sr-only`), bukan hanya toast. Kontrol contoh tab Worktree, bila ada, wajib berlabel eksplisit dan tidak pernah menjadi nilai bawaan.

**Never:** Tidak mengubah endpoint, kontrak API, atau aturan scoping. Tidak membuat workspace baru (tombol "buat" tetap nonaktif dan berlabel). Tidak menyentuh persistensi antar-tab atau `reload()` (itu story 7). Tidak menambah dependensi.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Daftar dimuat | `/api/projects` belum selesai | Trigger menampilkan teks memuat berbahasa Indonesia; menu tetap bisa dibuka | tidak ada error |
| Daftar gagal | `/api/projects` gagal | Trigger menampilkan teks gagal; menu menyatakan daftar tak bisa dimuat | tidak ada error |
| Daftar kosong | 200 `[]` | Trigger menyatakan belum ada workspace | tidak ada error |
| Daftar siap | 200 berisi workspace | Perilaku lama: nama aktif + radio list | tidak ada error |
| Ganti workspace | pilih workspace lain | Board berpindah; toast Indonesia; live region mengumumkan nama workspace | tidak ada error |
| Pilih workspace yang sedang aktif | klik baris aktif | Tidak ada toast, tidak ada pengumuman, tidak ada request | tidak ada error |
| Tab Worktree bawaan | buka tab | `live` terpilih; bila pohon ada, pohon database yang tampil | tidak ada error |
| Contoh dipilih | pilih skenario contoh | Pohon contoh tampil DENGAN label teks yang menyatakan itu data contoh | tidak ada error |
| Ekspor mati | pencarian `demoAgentTasks` | Nol hasil di `src/`, `e2e/`, `tests/` | N/A |

## Code Map

- `src/components/dashboard/agent-board-data.ts:123-…` — `demoAgentTasks` (ekspor mati) dihapus; `AgentTask` dan `bmadTaskToAgentTask` tetap.
- `src/components/dashboard/worktree-tree-data.ts:101` — `demoWorktreeRun`; tetap, tetapi hanya boleh dirender dengan label contoh.
- `src/components/dashboard/agent-board-view.tsx:459-472` — pemilihan skenario Worktree (`worktreeSample`, `live`/`pricing`) dan render `demoWorktreeRun`; tempat label contoh ditambahkan. Bawaan `live` sudah benar (`:56`).
- `src/components/dashboard/agent-board-view.tsx:477-481` — live region `role="status"` `sr-only` yang memuat `announcement`; `setAnnouncement` menjadi sasaran pengumuman pergantian workspace.
- `src/components/dashboard/app-sidebar.tsx:59-77` — `useActiveProject()`, `handleSwitchWorkspace`, toast Inggris di `:75`; kedua pemakaian `WorkspaceSwitcher` di `:104` dan `:234` harus menerima keadaan.
- `src/components/dashboard/workspace-switcher.tsx:13-50` — props + trigger + menu; tempat prop keadaan dan string Indonesia ditambahkan.
- `src/components/dashboard/project-context.tsx:27` — `status: "loading" | "ready" | "error"`; sumber keadaan yang diteruskan ke switcher (tidak diubah).
- `src/components/dashboard/project-context.tsx:127-160` — `workspaceSubtitle`; teks "Workspace lokal"/"Workspace" sudah Indonesia.

## Tasks & Acceptance

**Execution:**
- [x] `src/components/dashboard/agent-board-data.ts` -- Hapus `demoAgentTasks` beserta komentarnya -- ekspor mati yang memancing pemakaian baru.
- [x] `src/components/dashboard/workspace-switcher.tsx` -- Tambah prop keadaan (`loading`/`ready`/`error`/kosong), render teks Indonesia pada trigger dan baris menu, dan beri `aria-label` yang menyatakan keadaan yang sama -- switcher yang menyatakan keadaannya sendiri.
- [x] `src/components/dashboard/app-sidebar.tsx` -- Teruskan `status` dan jumlah workspace ke kedua pemakaian switcher, ganti toast menjadi Indonesia, dan sampaikan nama workspace yang dipilih ke live region board -- teks seragam + pengumuman pembaca layar.
- [x] `src/components/dashboard/agent-board-view.tsx` -- Pastikan `demoWorktreeRun` hanya dirender bersama label contoh yang eksplisit (teks terlihat, bukan hanya atribut) -- pengguna bisa membedakan data contoh dari data database.
- [x] `src/components/dashboard/workspace-switcher.test.ts` **tidak** dibuat: komponen ini butuh DOM. Bukti datang dari e2e yang sudah ada polanya (`e2e/`), bukan dependensi baru.

**Acceptance Criteria:**
- Given `/api/projects` gagal, when sidebar dirender, then switcher menampilkan teks gagal berbahasa Indonesia dan menu menyatakan daftar tidak dapat dimuat.
- Given `/api/projects` belum selesai, when sidebar dirender, then switcher menampilkan teks memuat, bukan tombol kosong.
- Given pengguna memilih workspace lain, when pergantian selesai, then toast berbahasa Indonesia dan live region board memuat nama workspace yang baru.
- Given pengguna membuka tab Worktree tanpa mengubah apa pun, when tab dirender, then yang tampil adalah pohon database (atau pesan kosongnya), bukan pohon contoh.
- Given pengguna memilih skenario contoh, when pohon contoh tampil, then ada teks terlihat yang menyatakan itu data contoh.
- Given pencarian `demoAgentTasks` di `src/`, when dijalankan, then nol hasil.

## Implementation Notes

- `demoAgentTasks` dan `resumeAgentTask` dihapus (keduanya ekspor mati; yang kedua juga memancarkan copy demo Inggris). `grep -rn` di `src e2e tests scripts` → nol hasil.
- Pengumuman pergantian workspace dipindah ke satu live region di `DashboardShell` (`announcement-context.tsx`), sehingga berlaku di semua route, bukan hanya `/agent-board`. Region merender `<span key={version}>` agar kalimat identik yang diulang tetap diumumkan, dan punya masa hidup 10 detik + dibersihkan saat route berubah agar tidak diwarisi halaman berikutnya.
- `switcherCopy` diekstrak ke `workspace-switcher-state.ts` dengan 13 unit test node — termasuk kasus "gagal dengan daftar tidak kosong" (trigger tetap menyebut workspace aktif) dan "siap tetapi `value` tak ada di daftar" (tidak lagi merender trigger kosong).
- Nama aksesibel switcher kini diawali teks yang terlihat (`Memuat workspace… — ganti workspace; …`), memenuhi WCAG 2.5.3; satu unit test memin invarian ini.
- Saat daftar gagal, menu menawarkan "Coba lagi" yang memanggil `reload()` dari context — tidak lagi memaksa reload halaman penuh.
- Tab Worktree: kontrol diberi nama menurut apa yang dipilih ("Sumber pohon Worktree"), bukan "skenario contoh" untuk kedua opsi; pohon contoh dibungkus `<section aria-label="Pohon contoh" aria-describedby="worktree-sample-note">` sehingga peringatannya ikut terbaca; fallback tanpa project memakai kalimat tersendiri.
- Tiga notice abu-abu di panel disatukan menjadi satu `BoardNotice` dengan `tone`, agar role dan padding tidak menyimpang.
- `ProjectStatus` diekspor dari `project-context.tsx` dan dikonsumsi switcher, sehingga keadaan keempat di masa depan akan gagal typecheck alih-alih diam-diam jatuh ke `ready`.
- Verifikasi: `npm run verify` exit 0 — unit 71, matrix 180, e2e 34 (dua run berturut-turut). `npx tsc --noEmit` dan `eslint` bersih.

## Review Triage Log

### 2026-11-07 — Tiga lapisan, iterasi 1

- `[high]` `[patch]` Live region hanya ada di halaman Agent Board, jadi pergantian workspace dari route lain (`/`, `/wiki`, `/users`) tak diumumkan ke siapa pun — sebagian besar aplikasi. Region dipindah ke `DashboardShell`.
- `[high]` `[patch]` Dua skrip pemeriksaan repo menunjuk label Inggris lama — diperbarui ke copy Indonesia, dibuat seed-agnostik, dan diberi dukungan `STATE_PATH`/`CHECK_EMAIL`. **Catatan verifikasi jujur:** saat dijalankan sendiri terhadap scratch DB, keduanya tetap gagal — tetapi saya membuktikannya gagal dengan cara yang SAMA pada HEAD tanpa perubahan story ini (`Switch workspace, current` tak ditemukan; `waitForURL(base + "/")` padahal app mendarat di `/agent-board`; item menu diukur sebagai `menuitem` bukan `menuitemradio`). Ketiganya cacat skrip yang sudah ada sebelumnya, bukan regresi story 6, dan saya tidak menyentuh produk untuk menyesuaikannya.
- `[high]` `[patch]` (pre-verified, verification-gap) Penekanan snapshot-mount di `useAnnouncement` tak teruji: menghapusnya membuat pengumuman lama diputar ulang setiap kembali ke board, dengan suite tetap hijau.
- `[medium]` `[patch]` `version` didokumentasikan sebagai mekanisme mengumumkan kalimat identik dua kali, tetapi tak pernah mencapai DOM — A→B→A senyap di A kedua, begitu pula approve gagal yang diulang. Region di-key agar setiap tulisan mengubah DOM.
- `[medium]` `[patch]` Alasan di komentar (toast tak terlihat pembaca layar) salah: Sonner sudah merender `aria-live` sendiri. Rasional dikoreksi menjadi "persisten, tidak bergantung timer toast".
- `[medium]` `[patch]` `aria-label` menimpa label terlihat dengan kata berbeda (WCAG 2.5.3) — nama aksesibel kini diawali teks yang terlihat lalu klausa keadaan. Berlaku juga pada trigger skenario Worktree.
- `[medium]` `[patch]` `status === "error"` mengalahkan `workspaceCount`: setelah refresh gagal, menu bilang daftar tak bisa dimuat padahal semua workspace masih terdaftar dan bisa dipilih, dan trigger berhenti menyebut workspace aktif.
- `[medium]` `[patch]` Kasus "siap, daftar tidak kosong, tapi `value` tak ada di dalamnya" masih merender trigger kosong — persis kegagalan yang prop ini dimaksudkan menutup.
- `[medium]` `[patch]` Catatan keadaan berupa `<p>` di dalam `role="group"` di dalam `role="menu"` (konten tak valid) — dipindah ke teks label grup.
- `[medium]` `[patch]` Saat daftar gagal tak ada jalan pulih padahal `reload()` ada di context — item menu "Coba lagi" ditambahkan.
- `[medium]` `[patch]` (pre-verified, verification-gap) Klausa `aria-label` per keadaan dan varian sidebar **collapsed** tak dipin sama sekali; menghapus klausanya membuat semua test tetap hijau padahal itulah satu-satunya pembawa keadaan saat collapsed.
- `[medium]` `[patch]` (pre-verified, verification-gap) Label skenario LIVE tak pernah diasersi — separuh D-6 ("kedua label menyatakan mana yang mana") bisa regresi kembali ke Inggris tanpa tertangkap.
- `[medium]` `[patch]` (pre-verified, verification-gap) AC "tanpa request saat klik baris aktif" tak dibuktikan; collector request ditambahkan. Board benar-benar berpindah ke project kedua juga belum diasersi.
- `[low]` `[patch]` Catatan contoh berupa `<p role="note">` saudara dari pohon — pembaca layar yang menelusuri pohon tak pernah bertemu peringatannya; dihubungkan lewat `aria-describedby`.
- `[low]` `[patch]` Fallback catatan berbunyi "tidak berasal dari workspace ini" saat tak ada project aktif — varian tanpa-project ditambahkan.
- `[low]` `[patch]` Kontrol menyebut KEDUA opsi "contoh" padahal salah satunya pohon database hidup — dinamai menurut apa yang dipilih ("Sumber pohon Worktree").
- `[low]` `[patch]` Tiga notice abu-abu di satu panel memakai tiga role dan tiga padding berbeda — disatukan lewat satu helper dengan prop tone.
- `[low]` `[patch]` Kalimat toast dan kalimat pengumuman dibangun terpisah (satu dengan titik) — dibangun sekali lalu diteruskan ke kedua tujuan.
- `[low]` `[patch]` Kedua call site menginline closure `onCreate` identik untuk item yang dirender `disabled` — callback mati dihapus, satu salinan kalimat disimpan di komponen.
- `[low]` `[patch]` `resumeAgentTask` adalah ekspor mati lain yang memancarkan copy demo berbahasa Inggris pada permukaan yang justru sedang di-de-demo-kan — dihapus.
- `[low]` `[patch]` `announce: setAnnouncement` terbaca seperti setter React padahal menulis string yang sama tetap menaikkan versi — diganti nama di call site.
- `[low]` `[patch]` Union status diduplikasi tangan dari `project-context` — satu tipe `ProjectStatus` diekspor dan dipakai.
- `[low]` `[patch]` `stateCopy` murni tetapi tak bisa diuji karena tak diekspor — dipindah ke modul sendiri dengan unit test node (pola `board-load.test.ts`, tanpa DOM).
- `[low]` `[reject]` "Teks Inggris di sekitar sidebar (`Search...`, `Watching`, `Board`, `Refresh`) seharusnya ikut di-Indonesia-kan" — di luar scope story ini (spec membatasi pada switcher dan copy baru); dicatat untuk penyisiran berikutnya.
- `[low]` `[reject]` "`demoWorktreeRun` masih berisi teks Inggris" — fixture itu adalah isi contoh yang kini berlabel eksplisit; menerjemahkannya mengubah demo "Halaman harga" yang dirujuk labelnya.
- `[low]` `[reject]` "Tidak ada sinyal visual keadaan saat sidebar collapsed" — kolom collapsed memang hanya menampilkan markah; menambah indikator adalah perubahan desain di luar intent, dan keadaan tetap terbaca lewat `aria-label`.

## Verification

**Commands:**
- `npm run build` -- expected: sukses.
- `npm test` / `npm run test:matrix` / `npm run test:e2e` -- expected: seluruh suite hijau, termasuk tambahan e2e untuk keadaan switcher dan label contoh.
- `grep -rn "demoAgentTasks" src e2e tests` -- expected: nol hasil (exit 1).
- `npx tsc --noEmit` dan `npx eslint <berkas yang berubah>` -- expected: bersih.
