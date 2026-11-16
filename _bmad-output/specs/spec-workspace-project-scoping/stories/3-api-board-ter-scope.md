---
title: 'API board ter-scope, tanpa prj_default hardcoded'
type: 'refactor'
created: '2026-11-05'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
deferred: []
baseline_revision: 'ea2018f196c0baa4dda995d3ed6429f6207351f0'
---

<intent-contract>

## Intent

**Problem:** Tiga fungsi lapisan data di `src/lib/bmad.ts` memakai `projectId: string = "prj_default"` sebagai nilai default. Pemanggil yang lupa mengisi `projectId` tidak gagal — ia diam-diam membaca dan menulis project default, jadi bug scoping muncul sebagai data yang salah, bukan sebagai error. Di sisi lain `GET /api/projects` memanggil `ensureInitialBMadData("prj_default")` setiap kali, sehingga membaca daftar project menjadi pemicu penulisan seed.

**Approach:** Hapus ketiga default tersebut sehingga `projectId` wajib, dan hentikan seed sebagai efek samping pembacaan. Seed tetap berjalan sekali secara idempoten untuk `prj_default`, tetapi dipicu oleh startup — bukan oleh `GET`.

## Boundaries & Constraints

**Always:** `projectId` wajib di ketiga fungsi; pemanggil yang tidak mengisinya harus gagal saat kompilasi, bukan jatuh ke default. Seed demo tetap ada dan tetap idempoten. `GET /api/projects` tidak boleh menulis apa pun. Semua route tetap memakai `guardBmadApi`.

**Never:** Jangan menghapus data seed yang sudah ada. Jangan mengubah bentuk respons API. Jangan menyentuh `src/app/api/projects/[projectId]/**` selain menyesuaikan pemanggilan yang kehilangan default. Jangan menyentuh komponen UI — itu story 4. Jangan menambah tabel atau kolom.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Daftar project | `GET /api/projects` | Mengembalikan daftar; tidak ada tulisan ke database | Tidak ada error |
| Seed saat startup | Database dengan `prj_default` kosong | Task dan node demo tersemai sekali | Tidak ada error |
| Seed diulang | Server start ulang | Tidak ada duplikasi baris | Tidak ada error |
| Project lain dibaca | `GET /api/projects/<id>/tasks` untuk project tanpa task | Daftar kosong; seed demo **tidak** tersemai ke project itu | Tidak ada error |
| Pemanggil tanpa projectId | Fungsi lapisan data dipanggil tanpa argumen | Gagal kompilasi TypeScript | Error kompilasi |
| Seed gagal saat boot | Database tidak terjangkau ketika server naik | Server tetap melayani; board kosong | Satu baris `console.warn`, boot tidak gagal |
| Seed terhenti di tengah | `prj_default` punya task tetapi tidak punya node | Boot berikutnya menambahkan node yang hilang | Tidak ada error |

</intent-contract>

## Code Map

- `src/lib/bmad.ts:95` -- `ensureInitialBMadData(projectId = "prj_default")`; seed ~100 baris, idempoten per project (cek `count(*)` dulu).
- `src/lib/bmad.ts:303` -- `getBMadTasks(projectId = "prj_default")`; memanggil `ensureInitialBMadData(projectId)` lalu `SELECT ... WHERE project_id = $1`.
- `src/lib/bmad.ts:352` -- `getBMadAgentTree(projectId = "prj_default")`; pola sama.
- `src/app/api/projects/route.ts:16` -- `await ensureInitialBMadData("prj_default")` di dalam `GET`, satu-satunya pemicu seed saat ini.
- `src/lib/db.ts:709-716` -- seed baris `prj_default` di blok v5, `ON CONFLICT (id) DO NOTHING`. Tidak diubah story ini.
- `src/app/api/projects/[projectId]/tasks/route.ts:13` dan `agent-tree/route.ts:13` -- satu-satunya pemanggil `getBMadTasks`/`getBMadAgentTree` yang sudah mengisi `projectId`; harus tetap kompilasi setelah default dihapus.
- `src/components/dashboard/agent-board-view.tsx:38,39,70,71,145,189` -- konsumen yang masih hardcode `prj_default`; **milik story 4**, jangan diubah di sini.

## Tasks & Acceptance

**Execution:**
- `src/lib/bmad.ts` -- Hapus default `"prj_default"` dari ketiga fungsi sehingga `projectId` wajib -- pemanggil yang lupa mengisi gagal saat kompilasi, bukan diam-diam membaca project default.
- `src/lib/bmad.ts` -- Pisahkan pemicu seed dari pembacaan: ekspor fungsi seed eksplisit yang dipanggil sekali saat startup, dan hapus panggilan `ensureInitialBMadData` dari `getBMadTasks`/`getBMadAgentTree` -- membaca board project baru tidak boleh menyemai demo ke project itu.
- `src/app/api/projects/route.ts` -- Hapus `ensureInitialBMadData("prj_default")` dari `GET` -- daftar project menjadi operasi baca murni.

**Acceptance Criteria:**
- Given server baru dijalankan pada database kosong, when `GET /api/projects` dipanggil, then daftar berisi `prj_default` dan **tidak ada** task atau node tambahan yang tersemai oleh request itu.
- Given `prj_default` sudah memiliki data seed, when server dijalankan ulang, then jumlah task dan node tidak bertambah.
- Given project baru tanpa task, when `GET /api/projects/<id>/tasks` dipanggil, then respons `[]` dan `bmad_tasks` untuk project itu tetap kosong.
- Given `getBMadTasks` dipanggil tanpa argumen, when TypeScript dikompilasi, then kompilasi gagal.
- Given `prj_default` yang sudah punya task seed, when board-nya dibaca, then task dan node yang sama seperti sebelumnya dikembalikan.

## Spec Change Log

## Review Triage Log

### 2026-11-06 — Review pass
- verdicts: 25 findings — high 2, medium 2, low 6, false 4, reject 11
- findings:
  - `[high]` `[patch]` A seed that died between the two inserts was permanently half-seeded: the task-count probe saw rows and skipped forever, so `getBMadAgentTree` returned null indefinitely. Reproduced (3 tasks, 0 nodes) and fixed: the startup hook now re-runs the node half unconditionally; verified the same state recovers to 3/4 on the next boot.
  - `[high]` `[patch]` The seed was awaited inside `register()`, and Next awaits `register()` before the server is ready — a cold database (10s connect timeout plus the v2–v7 bootstrap) would land on the readiness path for every request. Fixed: `register()` returns immediately and seeding continues in the background.
  - `[medium]` `[patch]` The AC claiming `GET /api/projects` seeds nothing was unobservable, since the boot seed always precedes any request. Replaced with the isolation AC that actually discriminates.
  - `[medium]` `[patch]` `ensureInitialBMadData` stayed exported, so a future caller could reintroduce write-on-read. Fixed: the startup hook is the documented single entry point and the docstring names it; the function stays exported only because the hook imports it lazily.
  - `[low]` `[patch]` The `NEXT_PHASE` guard was dead code (framework already skips it) and the edge-safety comment misattributed why `pg` stays out of the edge bundle. Comment corrected.
  - `[low]` `[patch]` Code Map cited `db.ts:709-716`; the seed is `711-714`. Corrected.
  - `[low]` `[patch]` "Pure read" docstrings overstated it — schema bootstrap still runs on the first query. Qualified.
  - `[low]` `[patch]` `scripts/e2e-server.mjs` comment still described the old seed-before-reads model. Updated.
  - `[low]` `[defer]` No documented re-seed path after removing the GET trigger; restart is the recovery path and is now stated.
  - `[low]` `[defer]` Cross-process seed racing assumes a single instance, matching D-1.
  - `[false]` `[reject]` "`getBMadTasks('')` still compiles" — the AC is about omitted arguments, which is what the removed default controlled.
  - `[false]` `[reject]` "GET still writes via `ensureSchema()`" — schema bootstrap is a pre-existing property of every DB route, outside this story's scope; recorded in D-1.
  - `[false]` `[reject]` "Unknown projectId returns [] instead of erroring" — returning empty is correct for a project-less workspace; a 404 would break story 4's empty-board state.
  - `[false]` `[reject]` "No tests" — repo constraint; D-3.
  - `[reject]` `[reject]` "UI falls back to demo tasks when seed fails" — real observation, but the UI is story 4's surface; recorded in `deferred-findings.md` and will be handled there.
  - `[reject]` `[reject]` "Seed could block on a hung connection" — now backgrounded, so it cannot block readiness.
- verified after patching: production boot on the live DB leaves 3 tasks / 5 nodes unchanged; deleting the nodes and rebooting restores them; `npx tsc --noEmit` clean, `npm test` 45/45, `npm run build` exit 0; two `GET /api/projects` change no row counts; a new project's board returns `[]` and `null` with zero rows seeded.

## Design Notes

Seed demo adalah data contoh untuk `prj_default` saja, bukan perilaku normal setiap project. Memisahkan pemicunya dari jalur baca membuat pembacaan board murni dan menghapus efek samping yang tidak terlihat dari nama fungsinya.

Default `"prj_default"` adalah alasan bug ini tidak bersuara: TypeScript tidak pernah menandai pemanggil yang lupa mengisi `projectId`. Menghapusnya mengubah kelas bug dari "data salah" menjadi "kompilasi gagal".

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: tanpa error.
- `npm test` -- expected: seluruh suite lulus.
- `npm run build` -- expected: kompilasi sukses.
- `curl -b <cookie> GET /api/projects` dua kali, lalu hitung `bmad_tasks` -- expected: jumlah tidak berubah antar panggilan.
- `curl -b <cookie> GET /api/projects/<project-baru>/tasks` -- expected: `[]`, dan `bmad_tasks` untuk project itu tetap 0.
