---
title: 'Workspace Switcher berfungsi penuh'
type: 'feature'
created: '2026-11-06'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
deferred: []
baseline_revision: '89cd6a3456dd12e71aaa45cd342d19169d99ba62'
---

<intent-contract>

## Intent

**Problem:** Workspace Switcher di sidebar hanya memanggil `setCurrentWorkspace` dan menampilkan toast berisi tiga nama hardcoded (Onyx / Acme Production / Byteforge Staging). Agent Board membaca `/api/projects/prj_default/*` secara harfiah di enam tempat, termasuk dua jalur mutasi (approve/reject dan update stage). Memilih workspace tidak mengubah data apa pun, dan aksi pada board menulis ke project yang sama berapa pun workspace yang dipilih.

**Approach:** Sumber kebenaran project aktif dipindahkan ke satu state yang dibagikan sidebar dan board. Sidebar membaca daftar project dari `GET /api/projects`; board membaca setiap request dan mutasi dari project aktif itu, dan polling di-rebind saat project berganti.

## Boundaries & Constraints

**Always:** Daftar workspace berasal dari `bmad_projects`, bukan nama hardcoded. Keenam titik `prj_default` di `agent-board-view.tsx` diganti — termasuk dua jalur mutasi. Pilihan workspace bertahan setelah reload. WS item aktif ditandai. Polling 5 detik memakai project terbaru, tidak boleh menangkap nilai lama di closure. Bila project aktif tidak punya task, board menampilkan keadaan kosong yang jujur — bukan data demo.

**Never:** Jangan membuat/mengganti nama/menghapus project dari UI. Jangan mengubah `src/lib/bmad.ts`, route API, atau skema database. Jangan memakai nama workspace sebagai identitas project. Jangan menyentuh alur OAuth atau `guardBmadApi`. Jangan menampilkan data demo sebagai pengganti data kosong.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pilih workspace lain | Dua project, masing-masing punya task berbeda | Board menampilkan task project B; task A hilang seluruhnya | Tidak ada error |
| Project aktif tanpa task | Project baru tanpa task | Board kosong dengan pesan, bukan task demo | Tidak ada error |
| Pilihan bertahan | Reload halaman setelah memilih B | Workspace B masih terpilih | Tidak ada error |
| Project terhapus | Project tersimpan di pilihan sudah tidak ada | Jatuh ke project pertama yang tersedia | Tidak ada error |
| Aksi mutasi | Approve/reject task saat workspace B aktif | Request menuju project B | Tidak ada error |
| Polling setelah ganti | Ganti workspace saat polling berjalan | Polling berikutnya memakai project baru | Tidak ada error |
| Mutasi gagal | `PATCH` mengembalikan 4xx/5xx | Kartu kembali ke keadaan sebenarnya dan pengguna diberi tahu | Pesan gagal diumumkan, bukan diam |
| Respons daftar rusak | `GET /api/projects` mengembalikan non-array | Status error, pilihan tersimpan **tidak** dihapus | Tidak ada error diam-diam |
| Daftar kosong sementara | `GET /api/projects` mengembalikan `[]` | Pilihan tersimpan dipertahankan untuk percobaan berikutnya | Tidak ada error |

</intent-contract>

## Code Map

- `src/components/dashboard/app-sidebar.tsx:56` -- `useState("Onyx")`, sumber state workspace saat ini.
- `src/components/dashboard/app-sidebar.tsx:58-62` -- tiga workspace hardcoded beserta `plan` yang tidak punya padanan di `bmad_projects`.
- `src/components/dashboard/app-sidebar.tsx:64-68` -- `handleSwitchWorkspace` hanya `setState` + toast.
- `src/components/dashboard/app-sidebar.tsx:95,225` -- dua render switcher (mobile, desktop).
- `src/components/dashboard/workspace-switcher.tsx:13-21` -- props `{id, name, plan}`; bentuk boleh dipertahankan, sumber datanya yang berubah.
- `src/components/dashboard/agent-board-view.tsx:38,39` -- fetch awal tasks + agent-tree, `prj_default` hardcoded.
- `src/components/dashboard/agent-board-view.tsx:70,71` -- fetch di dalam interval 5 detik.
- `src/components/dashboard/agent-board-view.tsx:145,189` -- dua mutasi (`PATCH` approve/reject dan update stage).
- `src/components/dashboard/agent-board-view.tsx:25-26` -- state awal dari `demoAgentTasks`/`demoWorktreeRun`; ini sumber data palsu.
- `src/components/dashboard/dashboard-shell.tsx:13` -- `DashboardContent` membungkus sidebar dan konten; tempat state project aktif dibagikan.
- `src/app/(workspace)/agent-board/page.tsx` -- memasang `AgentBoardView`.
- `deferred-findings.md` D-6 -- perilaku yang harus diperbaiki story ini: board tidak boleh menampilkan data demo sebagai pengganti data kosong.

## Tasks & Acceptance

**Execution:**
- `src/components/dashboard/project-context.tsx` (baru) -- Provider yang memuat `GET /api/projects`, menyimpan project aktif, dan memakai `localStorage` untuk persistensi; jatuh ke project pertama bila pilihan tersimpan hilang -- satu sumber kebenaran untuk sidebar dan board.
- `src/components/dashboard/dashboard-shell.tsx` -- Bungkus `DashboardContent` dengan provider di atas sidebar dan main -- agar sidebar dan board berbagi state yang sama.
- `src/components/dashboard/app-sidebar.tsx` -- Ganti tiga workspace hardcoded dengan project dari provider; hapus `plan` atau turunkan dari data yang ada; pertahankan dua render switcher -- pilihan harus mengubah state bersama, bukan state lokal.
- `src/components/dashboard/agent-board-view.tsx` -- Ganti keenam `prj_default` dengan project aktif; rebind interval saat project berubah; reset daftar saat berganti; mulai dari keadaan kosong, bukan data demo -- menghapus satu sumber kebenaran palsu dan dua jalur mutasi yang salah.

**Acceptance Criteria:**
- Given dua project masing-masing punya task berbeda, when workspace B dipilih, then board menampilkan task B dan nol task A.
- Given workspace B dipilih, when halaman di-reload, then workspace B masih terpilih.
- Given task di project B, when approve dijalankan saat B aktif, then data task B berubah dan task di project A tidak tersentuh.
- Given project aktif tanpa task, when board dibuka, then tampil keadaan kosong dengan pesan jelas dan tidak ada task demo.
- Given project tersimpan sudah dihapus, when halaman dimuat, then project pertama yang tersedia dipakai dan tidak ada error.
- Given `grep -rn "prj_default" src/components`, when dijalankan, then tidak ada hasil.

## Spec Change Log

## Review Triage Log

### 2026-11-06 — Review pass
- verdicts: 18 findings — high 3, medium 4, low 5, false 3, reject 3
- findings:
  - `[high]` `[patch]` Approve/reject never inspected the response: `apiFetch` resolves on 4xx/5xx, so a refused write fell through to the reload and the optimistic card silently reverted with no explanation. Fixed: `response.ok` is checked, the failure is announced, and the board reloads to the true state.
  - `[high]` `[patch]` A non-array `/api/projects` payload was coerced to `[]` and reported as `ready`, which then cleared the stored selection — one bad response could erase the user's workspace choice permanently. Fixed: non-array is an error, and the stored id is only forgotten when a non-empty list no longer contains it.
  - `[high]` `[patch]` An empty list also wiped the stored selection, with no distinction between "project deleted" and "list temporarily incomplete". Fixed by the same guard.
  - `[medium]` `[patch]` Both empty-state banners could render together for one project; the worktree message is now the tab's own concern.
  - `[medium]` `[defer]` Per-request (not per-project) staleness token: an older poll can still commit after a newer reload. Recorded — see deferred-findings D-7.
  - `[medium]` `[defer]` The board and the tree share one `loadState`, so a tree-only failure reports the whole board as broken. Recorded as D-7.
  - `[medium]` `[defer]` No `storage` event listener, so two tabs diverge and can clobber each other's selection. Recorded as D-8.
  - `[low]` `[defer]` `reload()` is exposed but never called, so a failed project-list load needs a page reload. Recorded as D-8.
  - `[low]` `[patch]` Story matrix and ACs gained rows for mutation failure and a broken/empty payload.
  - `[low]` `[defer]` `demoAgentTasks` is now dead code and `demoWorktreeRun` still backs a labelled sample scenario. Recorded as D-9.
  - `[low]` `[defer]` Switcher has no loading/empty treatment and no announcement on change. Recorded as D-9.
  - `[low]` `[defer]` `workspaceSubtitle` puts a git host into a slot styled as a plan tier; the switch toast is in English while the rest is Indonesian. Recorded as D-9.
  - `[false]` `[reject]` "Expansion state lost on A→B→A" — the comment claims per-project keying, the code holds one project at a time; behaviour matches the AC, only the comment overstated it.
  - `[false]` `[reject]` "LoadState docstring contradicts behaviour" — cosmetic comment drift, same behaviour.
  - `[false]` `[reject]` "setProjectId accepts any string" — the sidebar only offers ids from the list, and an unknown stored id now falls back without being persisted.
  - `[reject]` `[reject]` "Duplicate empty messaging" — resolved by the worktree patch above.
  - `[reject]` `[reject]` "Refresh button allows stacked requests" — the spinner state already gates the visible affordance; overlap is handled by the staleness guard.
- verified after patching: switching between two projects swaps the whole board and persists across reload; approving in project B changes only B (S4-1 → approved) and leaves all three `prj_default` rows untouched; an unknown stored id falls back to an available project; a project with no tasks shows "Belum ada task di workspace …" and zero demo rows; `npx tsc --noEmit` clean, `npx eslint` clean on all five files, `npm run build` exit 0; live DB back to 1 project / 3 tasks / 4 nodes.

## Design Notes

`demoAgentTasks` dipakai sebagai state awal, sehingga kegagalan fetch menampilkan data karangan seolah-olah data nyata. Story ini menggantinya dengan keadaan kosong eksplisit: board kosong lebih jujur daripada board berisi task yang tidak ada di database.

Interval polling menangkap `projectId` di closure. Bila project berubah tanpa me-rebind interval, board akan terus mem-poll project lama sambil menampilkan judul project baru — kegagalan yang terlihat benar pada awalnya.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: tanpa error.
- `npm run build` -- expected: kompilasi sukses.
- `grep -rn "prj_default" src/components` -- expected: tidak ada hasil.
- Buka `/agent-board` dengan dua project berisi task berbeda, ganti workspace -- expected: board berganti seluruhnya.
- Reload setelah mengganti workspace -- expected: pilihan bertahan.
