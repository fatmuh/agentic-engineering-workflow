# task-identity.md — Keunikan ID task, node, dan backlog

Tiga tabel memakai `id TEXT PRIMARY KEY` **global**, padahal ketiganya milik sebuah project. Setelah board di-scope per project, ID dari dua project berbeda akan bertabrakan. Companion ini menetapkan bentuk perbaikannya. CAP-5 bergantung pada ini.

## Masalah konkret

- `bmad_tasks.id` global + `tasks/batch/route.ts:57` memakai `ON CONFLICT (id) DO UPDATE`. Task `TASK-101` yang dibuat di project B akan **menimpa** `TASK-101` milik project A, bukan gagal.
- `bmad_agent_nodes.id` global. Node dilaporkan agent dengan ID bermakna seperti `agent-analyst-1` (`awm_agent_progress` menerima `nodeId` apa adanya), jadi tabrakan lintas project hampir pasti terjadi, bukan sekadar mungkin.
- `bmad_backlogs.id` global dengan pola yang sama.

## Keputusan: composite primary key

Ketiga tabel pindah ke `PRIMARY KEY (project_id, id)`.

Alasan memilih ini dibanding prefiks ID (`prj_abc__TASK-101`):

- Pemanggil tidak berubah. `taskId` tetap `TASK-101` di URL dan di tool MCP; yang berubah hanya cakupan keunikannya.
- Tidak ada parsing string untuk memisahkan project dari ID.
- FK bisa ikut composite, karena tabel anak sudah membawa `project_id`.

Biaya yang diterima: `getBMadTasks` dan `agent-tree` tetap mengembalikan `id` tanpa prefiks, jadi konsumen yang ingin ID yang benar-benar unik lintas project harus memakai pasangan `(projectId, id)`.

## Bentuk target

```sql
-- bmad_tasks
CREATE TABLE bmad_tasks (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES bmad_projects(id) ON DELETE CASCADE,
  ...
  PRIMARY KEY (project_id, id)
);

-- bmad_agent_nodes
CREATE TABLE bmad_agent_nodes (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES bmad_projects(id) ON DELETE CASCADE,
  task_id     TEXT,
  parent_id   TEXT,
  ...
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, task_id)
    REFERENCES bmad_tasks (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, parent_id)
    REFERENCES bmad_agent_nodes (project_id, id) ON DELETE CASCADE
);

-- bmad_backlogs
PRIMARY KEY (project_id, id)
```

### Mengapa FK `task_id` berubah dari SET NULL ke CASCADE

FK tunggal lama: `task_id TEXT REFERENCES bmad_tasks(id) ON DELETE SET NULL`. Sebagai composite, `SET NULL` akan ikut mengosongkan `project_id` — kolom `NOT NULL` yang merupakan bagian dari primary key. PostgreSQL menolak kombinasi itu. `CASCADE` adalah satu-satunya pilihan yang konsisten.

Konsekuensinya disengaja dan diterima: agent node adalah catatan progres *milik* sebuah task, jadi menghapus task memang seharusnya menghapus jejak progresnya. Ini perubahan perilaku yang harus dicatat di deskripsi perubahan, bukan disembunyikan.

Perhatikan bahwa `ON DELETE CASCADE` pada `project_id` kini bersifat berlebihan untuk tabel anak — menghapus project sudah cukup. Yang benar-benar berubah maknanya hanya `task_id`.

### Mengapa FK `parent_id` juga composite

Self-reference tunggal akan mengizinkan node di project A menjadi anak node di project B. Tabel sudah punya `project_id`, sehingga composite tidak menambah kolom apa pun.

## Urutan migrasi

PostgreSQL 18.6 (terverifikasi dari server proyek ini). Semua langkah di bawah berjalan dalam satu transaksi; tidak ada rewrite penuh karena data eksisting sudah unik secara global, sehingga kunci baru pasti valid.

1. Lepas FK yang menyentuh kolom terdampak (child lebih dulu): `bmad_agent_nodes.task_id`, `bmad_agent_nodes.parent_id`.
2. Lepas primary key lama ketiga tabel: `ALTER TABLE ... DROP CONSTRAINT ..._pkey`.
3. Tambah primary key baru: `ALTER TABLE ... ADD PRIMARY KEY (project_id, id)`.
4. Tambah ulang FK dalam bentuk composite.
5. Tambah index yang dibutuhkan pola akses: `(project_id, updated_at DESC)` untuk daftar task, `(project_id, parent_id)` untuk perakitan tree. Index `(project_id, stage)` yang sudah ada dipertahankan.

Migrasi harus idempoten seperti blok schema sebelumnya: periksa `pg_constraint` untuk bentuk kunci saat ini sebelum mengubah, agar aman dijalankan ulang pada database yang sudah termigrasi.

## Aturan untuk penulis data

- `ON CONFLICT` pada `bmad_tasks` di `tasks/batch` berubah target menjadi `(project_id, id)`.
- `ON CONFLICT` pada `bmad_agent_nodes` di `agent-tree/step` berubah target menjadi `(project_id, id)`.
- ID yang dikirim klien tetap dipakai apa adanya. Tidak ada penambahan prefiks di sisi server — itu akan mengubah kontrak tanpa manfaat.
