---
title: 'Identitas workspace case-fold dan tolak kredensial'
type: 'feature'
created: '2026-11-06'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
context: []
baseline_commit: '883171e7b5f001a03050393df889969659e75327'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Dua lubang pada kunci identitas. (D-4) `normalizeWorkspacePath` tidak me-case-fold, jadi di filesystem case-insensitive `/Users/X/proj` dan `/users/x/proj` menunjuk direktori yang sama tetapi menghasilkan dua kunci dan dua project. (D-5) remote berbentuk `https://user:token@host/repo` dinormalkan sama dengan remote bersih karena userinfo dibuang, sehingga `resolveProject` menyimpan URL mentahnya — token tersimpan apa adanya di kolom yang ditampilkan dashboard dan dikembalikan API.

**Approach:** Ubah kunci workspace menjadi lowercase, lalu migrasikan data lama dalam satu rilis yang sama (kolom `bmad_projects.workspace_path` + index, dan peta `workspaceProjects` di CLI). Deteksi kredensial dilakukan pada nilai **mentah** sebelum normalisasi, dan input baru yang membawanya ditolak `400`; baris lama tetap terbaca tetapi userinfo-nya tidak pernah dikembalikan API. Resolver menerima kunci lama dan baru selama masa transisi.

</frozen-after-approval>

**Keputusan (2026-11-06):**
- **D-4 lowercasing tanpa syarat** — kunci = path lowercase selalu, seperti CAP-4. Konsekuensi diterima: di Linux, dua path yang berbeda hanya karena kapitalisasi akan menyatu menjadi satu project. Alternatif kondisional ditolak karena kunci identitas akan bergantung pada filesystem server, sedangkan klien berada di mesin lain.
- **D-5 klien Go juga menolak** — binary menolak remote ber-kredensial sebelum memanggil API dengan pesan yang menyuruh memakai credential helper, bukan hanya meneruskan 400 server.

## Boundaries & Constraints

**Always:** Deteksi kredensial pada nilai mentah sebelum normalisasi (normalisasi justru membuang userinfo). Penolakan `400` berlaku untuk input baru di `POST /api/projects` dan `POST /api/projects/resolve`; tidak ada baris baru di `bmad_projects`. Baris lama tetap dipakai untuk pencocokan, tidak pernah membuat aplikasi gagal baca, dan `GET /api/projects` maupun `POST /api/projects/resolve` tidak memuat userinfo untuk baris lama. Migrasi case-fold: menormalkan kolom, membangun ulang `uq_bmad_projects_workspace`, dan **berhenti dengan pesan yang menyebut kedua project** bila dua baris jatuh ke kunci yang sama — tidak menggabung otomatis. Resolver membaca kunci baru lebih dulu, lalu kunci lama sebagai fallback baca-saja. Migrasi CLI mempertahankan entri yang lebih baru bila dua kunci bertabrakan, dan mencatat konflik ke stderr sekali. Blok schema baru idempoten dan di-guard katalog seperti v7/v8. Test story 1 dan 2 harus tetap hijau.

**Never:** Tidak mengubah kontrak OAuth atau format token. Tidak menghapus atau menggabungkan project secara otomatis. Tidak ada redaksi sebagai alternatif — keputusannya menolak. Tidak ada penulisan otomatis ke baris lama ber-kredensial. Tidak menyentuh `bmad_tasks`/`bmad_agent_nodes`/`bmad_backlogs`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create path berkapitalisasi | `workspacePath: "/Users/X/Proj"` | 201; `workspacePath` tersimpan lowercase | N/A |
| Resolve beda kapitalisasi | resolve `/users/x/proj` setelah create `/Users/X/Proj` | 200, project yang sama, `created: false` | N/A |
| Remote ber-kredensial (create) | `https://user:token@host/repo` | Ditolak 400, pesan menyebut kredensial | jumlah baris tidak berubah |
| Remote ber-kredensial (resolve) | sama | Ditolak 400 | jumlah baris tidak berubah |
| Remote userinfo tanpa token | `ssh://git@host/repo` | Diterima — `git@` bukan rahasia | N/A |
| Baris lama ber-kredensial | baris sudah ada dengan token | `GET /api/projects` & resolve mengembalikan remote tanpa userinfo; baris tetap cocok | tidak error |
| Migrasi kunci bentrok | dua project hanya beda kapitalisasi | Migrasi berhenti, pesan menyebut kedua project; data tidak berubah | boot gagal dengan pesan jelas |
| Migrasi aman | tidak ada bentrok | Semua `workspace_path` lowercase; index dibangun ulang; jumlah baris sama | idempoten saat diulang |
| Kunci lama di peta CLI | peta masih berisi kunci berkapitalisasi | Resolve menemukan project lewat fallback kunci lama, lalu menulis kunci baru | N/A |
| Bentrok saat migrasi peta CLI | dua kunci lama jatuh ke satu kunci baru | Entri yang lebih baru dipertahankan; konflik dicatat ke stderr sekali | tidak menggagalkan CLI |

## Code Map

- `src/lib/project-identity.ts:100-130` — `normalizeWorkspacePath`: casing harus turun sebelum langkah trailing-slash; jangan sentuh aturan symlink/relatif.
- `src/lib/project-identity.ts:50-90` — `normalizeGitRemote` membuang userinfo (`^[^/@]*@`); kelas error `ProjectIdentityError` dipakai ulang untuk penolakan kredensial.
- `src/lib/db.ts:105-112` — `NORMALIZED_WORKSPACE_SQL` + `NORMALIZED_WORKSPACE_INDEX_EXPR`; versi SQL harus ikut lowercase supaya index dan resolver sepakat.
- `src/lib/db.ts:137` — `PROJECT_SCOPED_TABLES`; `migrateProjectScopedKeys` (v7) sebagai contoh blok DDL ber-guard katalog + advisory lock; v9 baru memakai pola sama dengan kunci advisory berbeda.
- `src/lib/projects.ts:195-214` — `normalizeProjectIdentity` (tempat tepat pemeriksaan kredensial mentah); `:220-251` `findProject` (fallback kunci lama); `:276-343` `resolveProject`.
- `src/app/api/projects/route.ts:44-127` dan `src/app/api/projects/resolve/route.ts:25-105` — pemetaan `ProjectIdentityError` → 400 sudah ada; respons proyek di `toProjectResponse`/route perlu penyaringan userinfo.
- `tests/matrix/bmad-scoping.spec.ts` — perilaku kunci yang sudah dipinkan; harus tetap hijau.
- `/Users/adamramadhan/Projects/bmad-monitor-mcp/internal/workspace/identity.go:130-160` — `NormalizePath` (case-fold) dan `NormalizeRemote` (deteksi kredensial mentah).
- `/Users/adamramadhan/Projects/bmad-monitor-mcp/internal/config/config.go:115-200` — `LookupWorkspaceProject` (fallback kunci lama), `SetWorkspaceProject`, migrasi peta saat `LoadConfig`.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/project-identity.ts` -- lowercasing di `normalizeWorkspacePath`; fungsi baru yang menolak remote ber-kredensial (mendeteksi `user:…@` / `user@` pada nilai mentah) dengan `ProjectIdentityError` -- satu sumber aturan kunci.
- [x] `src/lib/db.ts` -- `NORMALIZED_WORKSPACE_SQL` ikut lowercase; blok schema v9 (advisory lock sendiri): lowercase `workspace_path` yang ada, berhenti dengan pesan menyebut kedua project bila ada bentrok, lalu bangun ulang `uq_bmad_projects_workspace` -- index dan resolver tidak boleh berbeda.
- [x] `src/lib/projects.ts` -- pemeriksaan kredensial sebelum normalisasi di `normalizeProjectIdentity`; `findProject` mencocokkan lewat ekspresi SQL ter-fold (fallback kunci legacy dihapus setelah review membuktikan query folded sudah mencakup semua baris lama); `toProjectResponse` menyaring userinfo untuk baris lama -- migrasi lunak tanpa downtime.
- [x] `src/app/api/projects/route.ts` + `resolve/route.ts` -- pastikan jalur 400 tercapai untuk kredensial dan respons tidak pernah membawa userinfo -- dua endpoint input.
- [x] `tests/matrix/bmad-identity.spec.ts` (baru) -- setiap baris I/O Matrix sisi server punya test pada scratch DB.
- [x] `/Users/adamramadhan/Projects/bmad-monitor-mcp/internal/workspace/identity.go` -- case-fold path dan tolak remote ber-kredensial (pesan menyuruh credential helper) -- klien menolak lebih awal.
- [x] `/Users/adamramadhan/Projects/bmad-monitor-mcp/internal/config/config.go` -- migrasi peta `workspaceProjects` ke kunci lowercase saat baca, dengan aturan entri-terbaru-menang dan satu peringatan stderr -- kunci lama tidak hilang.
- [x] `/Users/adamramadhan/Projects/bmad-monitor-mcp/internal/mcp/resolve.go` -- resolver mencoba kunci baru lalu kunci lama saat membaca peta -- CLI lama tetap menemukan projectnya.

**Acceptance Criteria:**
- Given project terdaftar dengan `/Users/X/Proj`, when resolve dipanggil dengan `/users/x/proj`, then responsnya project yang sama dan `bmad_projects` tidak bertambah.
- Given `bmad_projects` berisi baris ber-kredensial dari rilis lama, when `GET /api/projects` dan resolve dipanggil, then tidak ada userinfo di respons mana pun dan baris itu tetap cocok untuk resolusi.
- Given create/resolve dengan `https://user:token@host/repo`, when dipanggil, then keduanya 400 dan jumlah baris `bmad_projects` tidak berubah.
- Given dua project hanya berbeda kapitalisasi, when migrasi v9 berjalan, then boot gagal dengan pesan yang menyebut kedua project dan tidak ada baris yang diubah.
- Given binary Go asli dengan `HOME` terisolasi berisi peta kunci lama, when `awm_project_init` dijalankan, then CLI menemukan project lama (bukan membuat baru) dan peta ditulis ulang dengan kunci lowercase.
- Given `npm run test:matrix`, when dijalankan, then seluruh test story 1 dan 2 tetap hijau.

## Implementation Notes

- Perubahan menyentuh dua repo: dashboard (schema v9, identitas, redaksi, route) dan klien Go (NormalizePath fold, RejectCredentials, migrasi peta config, path tampilan).
- Case fold memakai `translate()` di SQL dan fold A–Z eksplisit di TS/Go, bukan `lower()`/`toLowerCase()`, agar ketiga sisi byte-identik untuk input non-ASCII (İ/sigma) — penyimpangan dari kata "lowercase" di frozen block, dengan alasan yang sama seperti komentar remote di story 2.
- v9 mengekspresikan fold lewat `NORMALIZED_WORKSPACE_SQL` (bukan salinan), sehingga arm `CASE` untuk root ikut terbawa; probe "masih belum fold?" memakai `IS DISTINCT FROM`.
- Kontrak "resolver menerima kunci lama dan baru" terpenuhi oleh perbandingan ter-fold pada nilai TERSIMPAN, bukan oleh query kedua; query kedua itu dihapus setelah review membuktikan himpunan hasilnya bagian dari query pertama. Klien Go tetap memakai fallback kunci lama karena kunci peta dibandingkan literal.
- Redaksi kredensial fail-closed: trim semua whitespace, buang sampai `@` terakhir di posisi authority, pertahankan skema+host.
- Verifikasi binary Go (HOME terisolasi, server produksi di scratch DB): `awm_project_init` mengembalikan project yang benar dan menampilkan path ASLI (bukan ter-fold); restart kedua mem-fold baris legacy dan MEMPERTAHANKAN baris root `/`; boot ketiga no-op; tidak ada token di respons mana pun termasuk baris ber-spasi; kedua endpoint menolak kredensial polos dan ber-tab dengan 400; peta config dimigrasikan ke lowercase dengan id dan entri tak terkait utuh; klien menolak kredensial lebih awal tanpa membuat project.
- `npm run verify` exit 0: unit 45, matrix 173 (7 file), e2e 23. `go build ./...` dan `go vet ./...` bersih.

## Review Triage Log

### 2026-11-06 — Tiga lapisan, iterasi 1

- `[high]` `[patch]` v9 mem-fold `/` menjadi `''` (arm `CASE root` hilang dari UPDATE dan probe) — project di root kehilangan `workspace_path` selamanya dan memicu rebuild index tiap boot; ekspresi diganti `NORMALIZED_WORKSPACE_SQL`.
- `[high]` `[patch]` `redactRemoteCredentials` menguji nilai ter-trim tetapi menerapkan replace ber-anchor `^` pada nilai mentah → remote legacy berawalan spasi membocorkan token; redaksi sekarang fail-closed pada nilai ter-trim (juga menutup password ber-`@`).
- `[high]` `[patch]` `hasRemoteCredentials` memakai `btrimSpaces` (spasi saja) → remote ber-tab/newline lolos, tersimpan mentah, dan dikembalikan; Go menolaknya sehingga dua sisi berbeda pendapat.
- `[high]` `[patch]` Comparator migrasi peta Go terbalik di kedua branch dibanding komentarnya (entri lebih tua menang), dan premis "urutan file = kronologis" salah karena `encoding/json` mengurutkan kunci map secara alfabetis.
- `[medium]` `[patch]` Fallback kunci legacy di `findProject` terbukti dead code (query folded sudah mencakup semua barisnya) dan test-nya tidak pernah mencapai branch — dihapus beserta plumbing `legacyWorkspaceKey`; test tetap ada dan kini meminkan mekanisme sebenarnya.
- `[medium]` `[patch]` `workspaceIndexDef` mengunci `schemaname='public'` → di schema lain v7/v9 saling menimpa index tiap boot.
- `[medium]` `[patch]` Route POST punya salinan inline redaksi kredensial alih-alih `toProjectResponse` — kedua jalur disatukan.
- `[medium]` `[patch]` Test bentrok index memulihkan index hanya di akhir badan test → kegagalan di tengah meninggalkan scratch DB pada index pra-D-4 untuk spec berikutnya; dipindah ke `try/finally`. Restore `process.env` juga menulis string `"undefined"` bila variabel belum ada.
- `[low]` `[patch]` `LoadConfig` menulis ke disk saat baca dan membuang error — kegagalan migrasi kini dicatat ke stderr sekali.
- `[low]` `[patch]` `FromDir` melakukan absolutisasi dua kali dan menampilkan path ter-fold sebagai "Workspace:" — `NormalizePath` dipanggil sekali dan path asli dipertahankan untuk tampilan.
- `[low]` `[patch]` Docstring `NORMALIZED_WORKSPACE_LEGACY_SQL` bertentangan dengan pemakaiannya (dipakai v7 untuk index) — dikoreksi saat fallback dihapus.
- `[medium]` `[defer]` Repo Go tidak punya satu pun unit test untuk ~150 baris logika urutan/migrasi — di luar scope story ini (spec hanya meminta `go build`/`go vet` + verifikasi binary), dicatat ke `deferred-work.md`.
- `[low]` `[reject]` Remote dengan PAT di posisi username (`https://ghp_x@host/r`) diterima — perluasan aturan adalah keputusan produk (GitHub memakai bentuk yang sama untuk username biasa); dicatat sebagai batasan yang disengaja di komentar.
- `[low]` `[reject]` Peringatan konflik peta hanya sekali per proses — sesuai keputusan spec ("stderr sekali"); CLI one-shot, dan MCP server menerima konsekuensi itu.
- `[false]` `[reject]` "`identity-mapping.md` basi dan menyebut dirinya otoritatif" — dokumen itu milik spec sebelumnya dan tidak boleh disunting oleh build ini (aturan reviewer: temuan yang perbaikannya menyunting spec/dokumen lain ditolak).
- `[false]` `[reject]` "Story ditandai done padahal ada bug" — status di-finalisasi SETELAH patch ini dan verifikasi ulang, bukan sebelum.

## Design Notes

Kunci lama tetap terbaca tanpa query kedua: `NORMALIZED_WORKSPACE_SQL` mem-fold **nilai tersimpan**, sehingga baris lama ber-path `/Users/X/Proj` menghasilkan kunci yang sama dengan permintaan casing apa pun. `findProject` cukup memakai ekspresi folded itu; tidak ada fallback unfolded terpisah, karena query seperti itu hanya bisa mencocokkan baris yang sudah dicocokkan query utama. Yang tetap berlaku adalah sifat baca-saja: resolve tidak pernah menulis ulang baris lama dan tidak membuat project kedua.

**Koreksi (2026-11-06):** implementasi awal sempat menambahkan query fallback kunci lama (`NORMALIZED_WORKSPACE_LEGACY_SQL`) beserta plumbing `legacyWorkspaceKey`. Review membuktikannya dead code dengan alasan di atas; query dan plumbing-nya dihapus, dan test "legacy row with an unfolded path" tetap ada sebagai pin untuk mekanisme yang sebenarnya (fold atas nilai tersimpan). `NORMALIZED_WORKSPACE_LEGACY_SQL` kini hanya dipakai blok v7 agar index yang dipasangnya tetap berbentuk seperti saat dirilis.

Penyaringan userinfo dilakukan di bentuk respons, bukan di kolom: baris lama tidak pernah ditulis ulang (spec melarang efek samping boot), tetapi API tidak boleh membocorkannya. Fungsi penyaring harus aman untuk remote tanpa userinfo dan untuk nilai non-URL.

## Verification

**Commands:**
- `npm run build` -- expected: sukses.
- `npm run test:matrix` -- expected: seluruh file matrix hijau termasuk `bmad-identity.spec.ts`.
- `cd /Users/adamramadhan/Projects/bmad-monitor-mcp && go build ./... && go vet ./...` -- expected: bersih.
- Binary Go asli (`HOME` terisolasi, config berisi peta kunci lama) terhadap server produksi di atas scratch DB -- expected: `awm_project_init` mengembalikan project lama, peta berubah ke kunci lowercase tanpa entri hilang.
