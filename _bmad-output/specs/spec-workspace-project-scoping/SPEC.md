---
id: SPEC-workspace-project-scoping
companions:
  - identity-mapping.md
  - task-identity.md
  - brownfield.md
  - architecture-diagrams.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Scoping Project per Workspace pada BMad Monitor

## Why

Ini sebuah **pain to solve**. Dashboard BMad Monitor memperlakukan seluruh instalasi sebagai satu project: Agent Board, task Kanban, dan Agent Tree selalu diambil dari `/api/projects/prj_default/*` yang ditulis harfiah di komponen, sementara Workspace Switcher di sidebar hanya mengganti `useState` dan menampilkan toast — memilih "Acme Production" tidak mengubah satu byte data pun yang ditampilkan. Akibatnya board menampilkan pekerjaan project lain, dan tombol approve/reject berisiko menyetujui task yang bukan milik konteks yang sedang dilihat.

Sisi CLI menutup masalah yang sama dari arah berlawanan: `~/.bmad-monitor/config.json` menyimpan satu `activeProjectId` global untuk semua direktori, dan `awm_project_init` selalu membuat project baru tanpa pernah mencari yang sudah ada. Dua sesi agent di dua repo berbeda akan saling menimpa project aktif — last writer wins — sehingga laporan progres satu repo muncul di board repo lain.

Yang terkena dampak adalah operator tim yang menjalankan beberapa repo dengan satu dashboard dan satu binary MCP. Ini mendesak karena integrasi BMad Monitor baru saja aktif dan data demo `prj_default` sudah mulai bercampur dengan data kerja nyata; setiap hari tanpa scoping menambah baris yang salah tempat.

## Capabilities

- **CAP-1 — Workspace Switcher berfungsi**
  - **intent:** Pengguna dapat memilih workspace di sidebar dan melihat Agent Board, task Kanban, serta Agent Tree berganti ke data project workspace tersebut.
  - **success:** Dengan dua project terdaftar yang masing-masing punya task berbeda, memilih workspace B dari workspace A menampilkan himpunan task B dan menyembunyikan seluruh task A; pilihan bertahan setelah reload halaman; workspace aktif ditandai di sidebar.

- **CAP-2 — Resolusi identitas workspace (get-or-create)**
  - **intent:** Sistem dapat memetakan sebuah workspace ke tepat satu project berdasarkan remote URL atau path-nya, membuat project hanya ketika belum ada yang cocok.
  - **success:** Memanggil inisialisasi dua kali untuk workspace yang sama menghasilkan satu baris `bmad_projects` dengan id yang sama pada kedua panggilan; dua workspace berbeda dengan remote berbeda menghasilkan dua project berbeda; workspace tanpa remote memakai path yang dinormalisasi dan tetap idempoten.

- **CAP-3 — API board ter-scope, tanpa project hardcoded**
  - **intent:** Konsumen board (web maupun MCP) dapat membaca daftar project yang benar-benar terdaftar dan mengambil task/agent-tree untuk project mana pun yang dipilih, tanpa nilai `prj_default` yang ditanam di kode konsumen.
  - **success:** `grep -rn "prj_default" src/components src/app` tidak menemukan hasil pada jalur board; `GET /api/projects` pada database kosong mengembalikan daftar yang konsisten dengan isi tabel setelah satu kali seed idempoten; `GET /api/projects/<id>/tasks` untuk dua project berbeda mengembalikan dua himpunan task yang tidak beririsan.

- **CAP-4 — State project per-workspace di CLI**
  - **intent:** Pengguna CLI/MCP dapat menjalankan sesi agent di beberapa direktori berbeda tanpa saling menimpa project aktif.
  - **success:** Menjalankan pelaporan progres dari dua direktori kerja berbeda secara bergantian menulis ke dua project yang berbeda sesuai direktorinya; tidak ada laporan dari repo A yang muncul di board repo B; state tidak hilang saat proses CLI dijalankan ulang.

- **CAP-5 — Isolasi data antar-project**
  - **intent:** Sistem menjamin setiap task, agent node, context file, dan backlog hanya terlihat dan hanya dapat diubah di bawah project pemiliknya.
  - **success:** Task yang dibuat di project A tidak muncul pada `GET /api/projects/<B>/tasks`; memperbarui task milik A melalui jalur project B ditolak (bukan diam-diam mengubah task A); task dengan ID sama (`TASK-101`) dapat hidup berdampingan di project A dan B sebagai dua baris terpisah, dan menghapus salah satunya tidak menyentuh yang lain.

## Constraints

- Satu kunci identitas workspace memetakan ke tepat satu project. Resolusi wajib deterministik dan idempoten — `get-or-create`, bukan `create` setiap kali. Ini yang membedakan perbaikan dari bug `awm_project_init` saat ini.
- Prioritas kunci: `git_remote_url` lebih dulu; `workspace_path` ternormalisasi hanya sebagai fallback ketika remote tidak ada. Nilai remote wajib dinormalisasi (case, suffix `.git`, skema ssh vs https) agar satu repo tidak menjadi dua project.
- `prj_default` beserta task seed dan agent node-nya dipertahankan. Bila workspace saat ini cocok dengan `prj_default`, project itu yang dipakai ulang. Tidak ada operasi destruktif terhadap data yang sudah ada.
- Seed data demo hanya boleh berjalan untuk `prj_default` dan hanya sekali secara idempoten. GET pada daftar project tidak boleh lagi menjadi pemicu seed.
- `bmad_tasks`, `bmad_agent_nodes`, dan `bmad_backlogs` memakai `PRIMARY KEY (project_id, id)`. Detail bentuk target, alasan, dan urutan migrasi ada di `task-identity.md`. FK `bmad_agent_nodes.task_id` berubah dari `ON DELETE SET NULL` menjadi `ON DELETE CASCADE` — satu-satunya bentuk yang valid untuk FK composite; menghapus task menghapus node progresnya.
- `bmad_projects` mendapat unique index pada remote ternormalisasi dan pada path untuk project tanpa remote, sebagai pengaman race dua sesi paralel. Bentuk index ada di `identity-mapping.md`.
- Guard autentikasi `guardBmadApi` (cookie sesi atau Bearer MCP) tetap berlaku pada semua endpoint board; perubahan scoping tidak boleh melemahkan atau melewatinya.
- `awm_project_init` harus tetap kompatibel dengan pemanggil yang sudah ada: parameter opsional `projectId` tetap dihormati bila diberikan eksplisit.

## Non-goals

- Multi-tenancy penuh, isolasi per-team, atau kontrol akses per-project di luar guard autentikasi yang sudah ada.
- Pembuatan, penggantian nama, atau penghapusan project dari UI dashboard. Sidebar hanya memilih project yang sudah terdaftar.
- Menyatukan konsep workspace dengan konsep team/organisasi, atau memindahkan data antar-project.
- Perubahan pada alur OAuth 2.0 PKCE atau format token MCP.
- Sinkronisasi real-time multi-klien (WebSocket/SSE) di luar polling yang sudah ada.
- Membangun route `/api/projects/[projectId]/backlogs` yang belum ada, meskipun empat tool MCP memanggilnya (lihat `brownfield.md`). Tabel `bmad_backlogs` ikut dinormalisasi kuncinya karena termasuk kelas bug yang sama, tetapi tidak ada endpoint baru yang dibuat di sini.

## Success signal

Dua sesi agent berjalan bersamaan di dua repo berbeda, masing-masing melaporkan progres; dashboard menampilkan board yang berbeda dan benar untuk masing-masing saat workspace diganti, tanpa satu pun task muncul di board yang salah, dan tidak ada baris di `bmad_projects` yang terduplikasi untuk repo yang sama.

## Assumptions

- Workspace pada produk ini bukan entitas multi-tenant terpisah; satu workspace setara dengan satu project di `bmad_projects`.
- Sidebar hanya perlu menampilkan project yang sudah terdaftar; pembuatan project tetap lewat `awm_project_init` atau `POST /api/projects`.
- Remote URL yang sama pada path berbeda tetap dianggap workspace yang sama (repo dipindah direktori tidak menghasilkan project baru).
- Belum ada project real — semua data saat ini dummy milik `prj_default`. Karena itu tidak ada kebutuhan UI peringatan untuk workspace tanpa project: board kosong sudah cukup, dan tidak ada data pelanggan yang perlu dilindungi selama migrasi kunci.

## Open Questions

- Perlukah UI menampilkan peringatan ketika workspace aktif tidak memiliki project terdaftar? Spec ini mengasumsikan board kosong tanpa peringatan tambahan; keputusan ini dapat ditinjau ulang begitu project real pertama terdaftar.
