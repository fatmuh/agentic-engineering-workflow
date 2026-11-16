# brownfield.md — Titik integrasi eksisting

Semua referensi file:line diverifikasi pada 2026-11-05, branch `feat/bmad-monitor-integration`. Downstream membaca ini sebagai peta medan; jangan mengubah perilaku bagian yang bukan milik fitur ini.

## src/components/dashboard/agent-board-view.tsx — konsumen board

`prj_default` ditanam di lima tempat, tiga di antaranya jalur data dan dua jalur mutasi:

- `:38-39` — fetch awal `tasks` + `agent-tree`
- `:70-71` — fetch di dalam polling 5 detik
- `:145` — `PUT`/approve task: `/api/projects/prj_default/tasks/{id}`
- `:189` — mutasi status task: jalur yang sama

Keduanya harus diganti sumber project aktif, bukan hanya dua yang pertama. Mengganti fetch tapi membiarkan mutasi tetap hardcoded akan menghasilkan board yang benar dengan aksi yang menulis ke project salah — kegagalan yang lebih buruk daripada bug sekarang karena terlihat benar.

Polling berjalan tiap 5 detik dan tidak dibatalkan saat project berganti; setelah scoping, project yang dipakai harus dibaca dari referensi mutable agar satu interval tidak terus mem-poll project lama.

## src/components/dashboard/app-sidebar.tsx — Workspace Switcher

- `:56` — `const [currentWorkspace, setCurrentWorkspace] = useState("Onyx")`
- `:58-62` — tiga workspace harfiah (`onyx`, `acme`, `byteforge`) dengan `plan` statis
- `:64-67` — `handleSwitchWorkspace` hanya `setCurrentWorkspace` + `toast.success`
- `:95`, `:225` — dua render switcher (mobile dan desktop) menerima props yang sama

Tidak ada fetcher, tidak ada konteks, tidak ada persistensi. `WorkspaceSwitcher` (`workspace-switcher.tsx:13-21`) menerima `workspaces: {id, name, plan}[]` — bentuk ini bisa dipertahankan; yang berubah adalah sumber datanya. Prop `plan` tidak punya padanan di `bmad_projects`; perlu nilai turunan atau dihapus dari tampilan.

## src/lib/bmad.ts — lapisan data

- `:95` `ensureInitialBMadData(projectId = "prj_default")` — seed sekitar 100 baris task demo + node. Idempoten per project (cek `count(*)` dulu), tetapi default parameter inilah yang membuat pemanggil lama tak perlu berpikir.
- `:286` `getBMadTasks(projectId = "prj_default")`
- `:335` `getBMadAgentTree(projectId = "prj_default")`

Ketiganya sudah menerima `projectId`; masalahnya bukan ketiadaan parameter melainkan default yang menutupi pemanggil yang lupa mengisinya. Hapus default agar kegagalan bersuara, bukan diam.

## src/app/api/projects/route.ts — daftar project

- `:10` — `GET` memanggil `ensureInitialBMadData("prj_default")` setiap kali. Ini menjadikan pembacaan daftar project sebagai pemicu penulisan seed.
- `:44-60` — `POST` melakukan `INSERT` murni tanpa pemeriksaan duplikat. Setelah scoping, ini satu-satunya jalur `create` eksplisit; `get-or-create` hidup di jalur resolusi.

## src/app/api/projects/[projectId]/** — endpoint ter-scope

Semua route di bawah `[projectId]` (`tasks`, `tasks/[taskId]`, `tasks/batch`, `agent-tree`, `agent-tree/step`, `context-files`) sudah menerima `projectId` dari path dan meneruskannya ke `bmad.ts`. Struktur ini tidak perlu diubah — hanya perilaku default yang perlu dikoreksi.

`tasks/batch/route.ts:57` melakukan `ON CONFLICT (id) DO UPDATE` pada `bmad_tasks` yang primary key-nya hanya `id`. Inilah mekanisme yang membuat task antar-project dapat saling menimpa.

`agent-tree/step/route.ts` memakai pola `ON CONFLICT (id) DO UPDATE` yang sama pada `bmad_agent_nodes`.

## Celah yang ditemukan (di luar scope, jangan diperbaiki di sini)

Empat tool MCP memanggil endpoint backlog yang **tidak ada** di aplikasi web:

| Tool MCP | Endpoint yang dipanggil | Route di `src/app/api` |
|---|---|---|
| `awm_backlog_create` | `POST /api/projects/{id}/backlogs` | tidak ada |
| `awm_backlog_list` | `GET /api/projects/{id}/backlogs` | tidak ada |
| `awm_backlog_report_impact` | `POST /api/projects/{id}/backlogs/{bid}/impact` | tidak ada |
| `awm_backlog_promote` | `POST /api/projects/{id}/backlogs/{bid}/promote` | tidak ada |

`bmad_backlogs` dibuat di `db.ts:321-334` dan tidak pernah dibaca atau ditulis oleh kode TypeScript mana pun. Keempat tool akan 404 pada pemakaian pertama. Ini bukan bagian dari spec scoping — dicatat agar tidak tertukar dengan bug scoping saat implementasi menemukannya.

## src/lib/db.ts — schema

- `:255-264` `bmad_projects` — `id TEXT PRIMARY KEY`, `git_remote_url`, `workspace_path`, tanpa unique constraint pada remote maupun path.
- `:278-296` `bmad_tasks` — `id TEXT PRIMARY KEY` (global), `project_id` FK `ON DELETE CASCADE`, index `(project_id, stage)`.
- `:300-319` `bmad_agent_nodes` — `id TEXT PRIMARY KEY` global, `project_id` FK, `task_id` FK `ON DELETE SET NULL`.
- `:321-334` `bmad_backlogs` — `id TEXT PRIMARY KEY` global.
- `:349-351` — seed `prj_default` dengan `ON CONFLICT (id) DO NOTHING`, memuat `git_remote_url` dan `workspace_path` yang sudah terisi. Data inilah yang menjadi acuan aturan cocok pertama di `identity-mapping.md`.

Schema memakai pola blok berversi (`v2`…`v6`) yang seluruhnya idempoten. Perubahan scoping menjadi blok berikutnya, bukan suntingan di dalam blok v5, agar database eksisting naik versi di tempat.

Tidak ada unique index pada `bmad_projects(git_remote_url)`. Constraint itu dibutuhkan untuk membuat get-or-create tahan race dua sesi CLI yang berjalan bersamaan; tanpa itu dua request paralel dapat membuat dua project untuk repo yang sama.

## bmad-monitor-mcp — sisi CLI (repo terpisah)

Lokasi: `/Users/adamramadhan/Projects/bmad-monitor-mcp`. Perubahan di repo ini **di luar** working tree dashboard, tetapi merupakan bagian dari kontrak yang sama.

- `internal/config/config.go:12-17` — struct `Config` dengan `ActiveProjectID` tunggal (`json:"activeProjectId"`).
- `internal/config/config.go:63-76` — `Save()` menulis seluruh struct sekaligus lewat `os.WriteFile`. Dua proses yang menulis bersamaan akan saling menimpa file.
- `internal/mcp/tools.go:124` — `awm_auth_status` melaporkan `activeProject`.
- `internal/mcp/tools.go:198` — `awm_project_init` memanggil `CreateProject` lalu menyetel `ActiveProjectID`; tidak ada lookup.
- `internal/mcp/tools.go:243,315,367,415,473,597,659,722,788` — sembilan titik fallback `projID = r.cfg.ActiveProjectID` dengan pesan galat seragam `"project ID belum ditentukan"`.
- `internal/mcp/tools.go:522` — `awm_task_create_batch` menerima `workspacePath`.

Sembilan titik fallback itu adalah alasan perubahan config harus terpusat: mengganti satu per satu mudah terlewat. Arahkan semuanya ke satu fungsi resolve.
