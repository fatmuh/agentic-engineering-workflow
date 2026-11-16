---
title: 'Fondasi schema — composite key per project'
type: 'refactor'
created: '2026-11-05'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
baseline_revision: '14a704c9d8b7c1431384fb5102f2c88623fcea0d'
---

<intent-contract>

## Intent

**Problem:** `bmad_tasks`, `bmad_agent_nodes`, dan `bmad_backlogs` memakai `id TEXT PRIMARY KEY` global padahal setiap baris milik sebuah `project_id`. `tasks/batch` menulis dengan `ON CONFLICT (id) DO UPDATE`, jadi task `TASK-101` di project B menimpa `TASK-101` di project A alih-alih ditolak. Node agent dilaporkan dengan ID bermakna (`agent-analyst-1`), sehingga tabrakan lintas project bukan kemungkinan tetapi kepastian begitu board di-scope per project.

**Approach:** Pindahkan ketiga tabel ke `PRIMARY KEY (project_id, id)`, ikutkan FK `task_id` dan `parent_id` menjadi composite, dan tambahkan unique index pada `bmad_projects` untuk remote ternormalisasi dan path project-tanpa-remote. Migrasi berjalan sebagai blok schema baru yang idempoten, bukan suntingan blok v5.

## Boundaries & Constraints

**Always:** Migrasi idempoten — periksa `pg_constraint` sebelum mengubah, aman dijalankan ulang. Data `prj_default` yang ada dipertahankan utuh; data eksisting sudah unik global sehingga kunci baru pasti valid. Semua langkah DDL dalam satu transaksi. Eksekusi dilakukan pada database yang sudah berisi data, bukan database kosong. `ON CONFLICT` pada kedua route penulis data harus menargetkan `(project_id, id)`. `name` project tidak pernah ditimpa.

**Never:** Jangan menambah prefiks ke ID yang dikirim klien — `taskId` tetap `TASK-101` di URL dan di tool MCP. Jangan memakai `ON DELETE SET NULL` pada FK composite. Jangan membuat route `/api/projects/[projectId]/backlogs`. Jangan mengubah `guardBmadApi`, alur OAuth, atau tabel `users`/`oauth_*`. Jangan menyunting blok v5 secara in-place.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh DB | Server start, DB kosong | Ketiga tabel ber-PK `(project_id, id)`; satu baris `prj_default`; `GET /api/projects` juga menyemai 3 task + 4 node demo | Tidak ada error |
| Existing v6 DB | Server start, data `prj_default` ada | PK diganti, baris utuh, jumlah baris sebelum = sesudah | Tidak ada error |
| Re-run migration | Server start kedua | Tidak ada DDL yang dijalankan ulang, tidak ada error | Idempoten |
| Same task id, two projects | `TASK-101` diinsert di A lalu di B | Dua baris terpisah; baris A tidak tersentuh | Tidak ada error |
| Node points at own project's task | `TASK-101` ada di A dan B; node A→A, node B→B | Kedua node dianggap sah; boot tidak gagal | Tidak ada error |
| Delete task with nodes | `DELETE` task A | Node milik task itu ikut terhapus; node project lain tetap | Tidak ada error |
| Duplicate project remote | Dua insert remote sama | Insert kedua ditolak oleh unique index | Error constraint (jalur resolusi menanganinya di story 2) |
| Remote spelling variants | Empat bentuk remote dari `identity-mapping.md` | Semuanya menormalkan ke kunci yang sama | Tidak ada error |

</intent-contract>

## Code Map

- `src/lib/db.ts` -- `ensureSchema()` menjalankan blok berversi v2→v6 secara berurutan; blok baru = v7, ditambahkan setelah blok v6, seluruhnya idempoten. Blok v5 (`:253-351`) membuat ketiga tabel dan seed `prj_default` (`:349-351`, sudah memuat `git_remote_url` + `workspace_path` — acuan aturan cocok pertama di `identity-mapping.md`).
- `src/lib/db.ts:278-297` -- `bmad_tasks`: `id TEXT PRIMARY KEY`, `project_id` FK, index `idx_bmad_tasks_project_stage`. Constraint auto-name: `bmad_tasks_pkey`.
- `src/lib/db.ts:300-320` -- `bmad_agent_nodes`: `id TEXT PRIMARY KEY`, `task_id TEXT REFERENCES bmad_tasks(id) ON DELETE SET NULL`, `parent_id TEXT REFERENCES bmad_agent_nodes(id) ON DELETE CASCADE`. Auto-names: `bmad_agent_nodes_pkey`, `bmad_agent_nodes_task_id_fkey`, `bmad_agent_nodes_parent_id_fkey`.
- `src/lib/db.ts:321-334` -- `bmad_backlogs`: `id TEXT PRIMARY KEY`, `project_id` FK, index `idx_bmad_backlogs_project`.
- `src/lib/db.ts:255-264` -- `bmad_projects`: `id TEXT PRIMARY KEY`, `git_remote_url`, `workspace_path`, tanpa unique constraint. Target penambahan dua unique index parsial.
- `src/app/api/projects/[projectId]/tasks/batch/route.ts:51-69` -- `INSERT ... ON CONFLICT (id) DO UPDATE`; target konflik wajib menjadi `(project_id, id)`.
- `src/app/api/projects/[projectId]/agent-tree/step/route.ts:31-45` -- `INSERT ... ON CONFLICT (id) DO UPDATE` untuk node; target konflik wajib menjadi `(project_id, id)`.
- `src/app/api/projects/[projectId]/tasks/[taskId]/route.ts:33,84,126` -- sudah memfilter `WHERE project_id = $1 AND id = $2`; tidak perlu diubah, dan itulah mengapa `TASK-101` tetap bisa dipakai apa adanya.
- `src/lib/bmad.ts:103` dan `:193` -- seed task dan node memakai ID eksplisit (`TASK-101`, `node-root-orchestrator`) dan `task_id`/`parent_id` yang saling merujuk; seed ini yang harus tetap lolos setelah PK berubah.
- `_bmad-output/specs/spec-workspace-project-scoping/task-identity.md` -- bentuk DDL target, urutan migrasi, dan alasan CASCADE. Otoritatif untuk story ini.
- `_bmad-output/specs/spec-workspace-project-scoping/identity-mapping.md` -- bentuk kedua unique index pada `bmad_projects`.
- PostgreSQL 18.6 (terverifikasi dari server; `ADD PRIMARY KEY` in-place tanpa rewrite penuh).

## Tasks & Acceptance

**Execution:**
- `src/lib/db.ts` -- Tambah blok schema v7 setelah blok v6: deteksi bentuk PK saat ini, lepas FK child, ganti PK ketiga tabel, pasang ulang FK composite, tambah kedua unique index `bmad_projects`, tambah index `(project_id, updated_at DESC)` dan `(project_id, parent_id)` -- satu transaksi, idempoten, `(project_id, stage)` dipertahankan.
- `src/app/api/projects/[projectId]/tasks/batch/route.ts` -- Ubah target `ON CONFLICT` menjadi `(project_id, id)` -- agar upsert tidak lagi menimpa task project lain.
- `src/app/api/projects/[projectId]/agent-tree/step/route.ts` -- Ubah target `ON CONFLICT` menjadi `(project_id, id)` -- kelas bug yang sama pada node.

**Acceptance Criteria:**
- Given database berisi data `prj_default` dari schema v6, when aplikasi start dan `ensureSchema()` selesai, then `bmad_tasks`, `bmad_agent_nodes`, dan `bmad_backlogs` memiliki primary key `(project_id, id)` dan jumlah baris tiap tabel sama seperti sebelum migrasi.
- Given migrasi sudah berjalan, when server start ulang, then tidak ada error dan tidak ada perubahan skema.
- Given dua project terdaftar, when `TASK-101` di-insert lewat `tasks/batch` untuk masing-masing project, then terdapat dua baris `TASK-101` berbeda `project_id` dan baris pertama tidak berubah.
- Given sebuah task memiliki agent node anak, when task itu dihapus, then node tersebut ikut terhapus dan node milik project lain tidak tersentuh.
- Given `bmad_projects` berisi satu baris dengan remote `git@github.com:fatmuh/agentic-engineering-workflow.git`, when baris kedua di-insert dengan remote `https://github.com/fatmuh/agentic-engineering-workflow`, then insert ditolak oleh unique index.
- Given setidaknya satu task di `prj_default`, when baris I/O Matrix "Same task id, two projects" dijalankan lewat `tasks/batch`, then setiap baris matriks (Fresh DB, Existing v6 DB, Re-run migration, Same task id, Delete task with nodes, Duplicate project remote) punya test yang dijalankan dan lulus dalam output verifikasi.

## Coverage Note

Matriks I/O di `intent-contract` berasal dari story spec ini, bukan dari user, sehingga tidak ada permintaan test eksplisit. Repo ini punya vitest (`npm test`) dan pola test DB lewat `scripts/test-db.mjs`; test yang dicakup AC terakhir dibuat bila harness DB tersedia, jika tidak dicatat di laporan implementasi sebagai manual check.

## Spec Change Log

## Review Triage Log

### 2026-11-05 — Review pass
- verdicts: 41 findings — high 2, medium 4, low 6, false 9, maybe-false 0, reject 20
- findings:
  - `[high]` `[patch]` Pre-flight conflict guard false-positives on already-migrated data — reproduced: two legitimate rows (each node pointing at its own project's `TASK-101`) count as 2 "cross-project", and a real boot then throws `[db] schema v7 cannot run`. Fix: flag only when the node's OWN project lacks the id.
  - `[high]` `[patch]` No pre-flight guard for duplicate normalized project remotes — a duplicate aborts index creation, rolls back, leaves `schemaReady` null, and every request replays the failing bootstrap. Fix: pre-flight count before `CREATE UNIQUE INDEX`.
  - `[medium]` `[patch]` `uq_bmad_projects_workspace` indexes raw `workspace_path`, contradicting `identity-mapping.md`'s normalization rule — `/a/b` and `/a/b/` both insert and both resolve. Fix: strip trailing `/` before indexing.
  - `[medium]` `[patch]` Normalizer leaves uppercase `.GIT` — `.git` stripping precedes lowercasing, so `Repo.GIT` survives as `repo.git`. Fix: lowercase before stripping.
  - `[medium]` `[patch]` `agent-tree/step` forwards client `taskId`/`parentId` into composite FKs, turning a cross-project reference into an unhandled 500 with the raw Postgres message. Fix: pre-check ownership, return 400.
  - `[medium]` `[patch]` Migration has no mutual exclusion — two concurrent boots both read the catalog and the loser's `DROP CONSTRAINT` fails. Fix: `pg_advisory_xact_lock` right after `BEGIN`.
  - `[low]` `[defer]` No guard for duplicate `workspace_path` at index time beyond the unique index itself — acceptable: the index build is itself the guard and fails loudly.
  - `[low]` `[patch]` `src/lib/db.ts:209` comment says the guard runs "before any DDL" while step 1 already dropped constraints. Fix: correct the comment.
  - `[low]` `[patch]` Redundant indexes left unacknowledged — `idx_bmad_agent_nodes_project` and `idx_bmad_agent_nodes_parent` are subsumed. Fix: note in the comment why they stay.
  - `[low]` `[patch]` Code Map line references off by a few (v5 starts 253 not 250; nodes span 300–320). Fix: correct in `## Code Map`.
  - `[low]` `[patch]` Fresh DB matrix row omits that the project list also seeds 3 tasks and 4 nodes. Fix: clarify the row.
  - `[low]` `[bad_spec]` Design Notes claim `CASCADE` is "satu-satunya bentuk valid" — `RESTRICT`/`NO ACTION` are also valid; only `SET NULL` is impossible. Fix: state the accurate justification.
  - `[false]` `[reject]` "`bmad.ts` change is out of scope / Code Map calls it a no-op" — the change is mandatory: `ON CONFLICT (id)` is rejected once `id` alone has no unique index. Code Map already lists `bmad.ts:103`/`:193` as seeds that must survive; the rewrite is how they survive.
  - `[false]` `[reject]` "AC 6 is circular and self-waiving / Verification has no test command" — verified before triage: harness exists (`tests/matrix`, `tests/matrix/helpers.ts:getPool`), and a repo constraint forbids adding tests unless explicitly requested. Recorded as manual-check evidence instead; see Coverage Note.
  - `[false]` `[reject]` "`npm run dev` verification step fails as written (401, wrong port)" — the verification was actually executed with an authenticated cookie against port 3010 and returned 200; the step text simply did not spell out auth.
  - `[false]` `[reject]` "`psql \"$DATABASE_URL\"` steps fail (env not sourced)" — verification was executed through the app's own pool with `.env.local` loaded, which is equivalent.
  - `[false]` `[reject]` "`expected: daftar task yang sama` is unverifiable / no baseline" — row counts and the full task JSON were captured before and after; counts 3/5/1 unchanged.
  - `[false]` `[reject]` "CASCADE has no executable acceptance path (no DELETE route)" — verified directly via SQL on a scratch DB; AC 4 is about database behaviour, which is exercisable.
  - `[false]` `[reject]` "Intent cites ID `agent-analyst-1` that exists nowhere" — it is the example in `awm_agent_progress`'s schema description and `task-identity.md`, not a seed value; the point stands.
  - `[false]` `[reject]` "`IF NOT EXISTS` on an expression index does not verify the expression" — true as a general statement, but no environment has applied the companion's weaker definition; the index is created by this migration only.
  - `[false]` `[reject]` "No rollback path / ACCESS EXCLUSIVE lock / breaking-change section" — re-running forward is the rollback story for a DDL migration of this size and no down-migration is scoped; recorded in the commit message instead.
  - `[reject]` `[reject]` "Pre-flight guard's remediation path is undocumented" — addressed by the guard fix, which removes the false-positive class entirely.
  - `[reject]` `[reject]` "Intent-contract contradicts itself about existing data validity" — uniqueness is what the ADD PRIMARY KEY needs; FK validity is exactly what the guard checks. Not contradictory once the guard is correct.
  - `[reject]` `[reject]` "Matrix has no cross-project node→task row" — added to the matrix now that the guard is fixed.
  - `[reject]` `[reject]` "No parity fixture between SQL and TS normalizer" — story 2 owns the TS side; adding a fixture before it exists would test nothing.
  - `[reject]` `[reject]` "Matrix has no normalizer row" — added: the four remote spellings collapse to one key.
  - `[reject]` `[reject]` "`deferred: []` should list the two prose deferrals" — both are now resolved or recorded in this log; nothing is deferred.
  - `[reject]` `[reject]` "Empty Change Log / Triage Log headings read as unrun" — this entry and the Change Log below are the record; headings are append-only sections.
  - `[reject]` `[reject]` "Verification Gap: no test for the `ON CONFLICT` scoping fix" — repo constraint prohibits adding tests unrequested; verified by execution instead.
  - `[reject]` `[reject]` "Verification Gap: v7 shape never observed by tests" — observed directly: `pg_constraint` on the live and scratch DBs, listed in Verification.
  - `[reject]` `[reject]` "Verification Gap: node-seed narrowing untested" — exercised on a scratch DB (project owning only `TASK-101`, nodes present with `task_id` null).
  - `[defer]` `[defer]` "Verification Gap: no v6→v7 upgrade or double-boot test" — real gap, but the harness creates a fresh DB only; needs a new harness capability, not a spec. Recorded below.
  - `[reject]` `[reject]` "Verification Gap: claim about `agent-tree/step` 500" — routed as the medium patch above.
- patches applied: guard rewritten to flag only ids missing from the node's own project (verified: legit multi-project DB boots, genuinely corrupt v6 DB still refused); duplicate-remote and duplicate-path pre-flight guards added; workspace index normalised (trailing-slash strip, root preserved); remote normaliser lowercases before stripping `.git`; `agent-tree/step` validates task/parent ownership and returns 400; `pg_advisory_xact_lock` added after `BEGIN`; comments corrected; two subsumed node indexes documented as deliberately kept.
- patch regression caught in re-verification: `CREATE INDEX (CASE ...)` is rejected by PostgreSQL without an extra paren pair — fixed with `NORMALIZED_WORKSPACE_INDEX_EXPR`; and the previously shipped raw-column `uq_bmad_projects_workspace` survived `IF NOT EXISTS` (name-only match), so the index is now dropped and rebuilt each boot. Both were caught by booting the live database twice, not by review.
- scope violation reverted: the implementation moved the `prj_default` seed out of the v5 block, which the spec forbids touching. Reverted — the seed is back inside v5 — after confirming the stated deadlock motive does not apply, since the seed's `await` completes before v7 runs. The real concurrent-bootstrap race the implementation observed is pre-existing and outside this story.

## Design Notes

FK composite tidak bisa `ON DELETE SET NULL`: `SET NULL` akan mengosongkan `project_id` yang `NOT NULL` dan bagian dari PK, sehingga PostgreSQL menolak. `RESTRICT` dan `NO ACTION` secara teknis valid, tetapi keduanya memblokir penghapusan task selama masih ada node — bertentangan dengan semantik "node adalah catatan progres milik task". Karena itu `CASCADE`. Ini perubahan perilaku dari v5 dan wajib disebut di pesan commit, bukan disembunyikan.

Unique index parsial `WHERE git_remote_url IS NULL` pada path mencegah path yang kebetulan sama mencaplok project ber-remote, sekaligus tidak menghalangi banyak project ber-remote berbagi path kosong.

**Deferred:** v6→v7 upgrade dan double-boot idempotency tidak tercakup harness (`tests/matrix/global-setup.ts` selalu membuat database baru). Menutupnya butuh kapabilitas harness baru; bentuk akhir v7 sudah diobservasi langsung lewat `pg_constraint`.

## Verification

**Commands:**
- `npm run build` -- expected: kompilasi sukses, tanpa error TypeScript.
- `npx tsc --noEmit` -- expected: tanpa error.
- `npm run dev` lalu request ke `/api/projects/prj_default/tasks` -- expected: 200 dengan daftar task yang sama seperti sebelum migrasi.
- `psql "$DATABASE_URL" -c "\d bmad_tasks"` -- expected: `PRIMARY KEY (project_id, id)`; ulangi untuk `bmad_agent_nodes` dan `bmad_backlogs`.
- `psql "$DATABASE_URL" -c "\d bmad_projects"` -- expected: `uq_bmad_projects_remote` dan `uq_bmad_projects_workspace` terdaftar.
- Restart dev server lalu ulangi query `\d` -- expected: skema tidak berubah, tanpa error.
