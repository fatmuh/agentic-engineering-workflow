# identity-mapping.md — Aturan resolusi workspace → project

Companion ini memuat aturan normalisasi dan tabel keputusan yang dipakai CAP-2, CAP-4, dan CAP-5. Kernel hanya menyebut prinsipnya; detail di sini.

## Kunci identitas

Dua kolom di `bmad_projects` berperan, sesuai urutan prioritas:

1. `git_remote_url` — kunci utama.
2. `workspace_path` — fallback, hanya dipakai bila remote tidak ada.

Project dianggap cocok bila **salah satu** aturan berikut benar, diperiksa berurutan:

| Urutan | Kondisi cocok | Catatan |
|---|---|---|
| 1 | `git_remote_url` ternormalisasi sama | Berlaku walau `workspace_path` berbeda — repo dipindah direktori tetap project yang sama |
| 2 | `workspace_path` ternormalisasi sama **dan** kedua sisi tidak punya remote | Mencegah path yang kebetulan sama mencaplok project ber-remote |
| 3 | tidak ada yang cocok | Buat project baru (`get-or-create` jalur create) |

Aturan 2 sengaja mensyaratkan kedua sisi tanpa remote. Tanpa syarat itu, path `/tmp/x` milik project ber-remote bisa tercocokkan oleh workspace tanpa remote dan menghasilkan penggabungan yang salah.

Resolusi dilakukan dalam satu transaksi. Pengaman akhirnya adalah unique index parsial di bawah — bukan pemeriksaan baca-lalu-tulis, yang bisa dilalui dua request paralel sekaligus.

## Normalisasi remote URL

Semua bentuk berikut harus menghasilkan kunci yang sama:

```
git@github.com:fatmuh/agentic-engineering-workflow.git
https://github.com/fatmuh/agentic-engineering-workflow.git
https://github.com/fatmuh/agentic-engineering-workflow
ssh://git@github.com/fatmuh/agentic-engineering-workflow.git
```

Langkah normalisasi, dalam urutan ini:

1. Trim spasi dan buang `/` di akhir.
2. Buang suffix `.git`.
3. Ubah `git@host:owner/repo` (scp-like) menjadi `host/owner/repo`.
4. Buang skema (`ssh://`, `https://`, `http://`, `git://`), userinfo (`git@`), dan port.
5. Lowercase seluruhnya.

Hasil yang disimpan untuk perbandingan: `host/owner/repo` lowercase.

## Normalisasi workspace path

1. Ekspansi `~` bila ada.
2. Resolve ke path absolut.
3. Buang `/` di akhir; pertahankan `/` untuk root.
4. Jangan resolve symlink — path fisik berbeda yang di-symlink ke direktori yang sama tetap dianggap workspace berbeda; ini disengaja agar worktree tidak saling menimpa.

Path yang tidak ada di disk pada saat resolusi tetap diterima apa adanya setelah normalisasi. Tidak ada validasi keberadaan direktori di jalur ini.

## Perilaku `awm_project_init` dan endpoint project

| Pemanggil | Masukan | Hasil |
|---|---|---|
| `awm_project_init` | `name` + `gitRemoteUrl` | get-or-create berdasarkan remote; bila cocok, project lama dipakai, `name` tidak ditimpa |
| `awm_project_init` | `name` + `workspacePath`, tanpa remote | get-or-create berdasarkan path (aturan 2) |
| `awm_project_init` | `projectId` eksplisit | Pakai langsung tanpa resolusi — jalur kompatibilitas |
| `POST /api/projects` | body lengkap | Tetap `create` murni (perilaku lama dipertahankan untuk pembuatan eksplisit) |

`name` tidak pernah menimpa project yang sudah ada. Mengganti nama project bukan bagian dari spec ini.

## Pengaman race: unique index

Dua sesi CLI yang dijalankan bersamaan dapat sama-sama tidak menemukan project yang cocok lalu sama-sama membuat. Yang mencegah duplikasi bukan pemeriksaan di aplikasi, melainkan constraint:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_bmad_projects_remote
  ON bmad_projects (
    lower(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      regexp_replace(regexp_replace(btrim(git_remote_url), '/+$', ''), '\.git$', ''),
      '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '^[^/@]*@', ''),
      '^([^/:]+):[0-9]+(/.*)$', '\1\2'), '^([^/:]+):(.*)$', '\1/\2'))
  WHERE git_remote_url IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bmad_projects_workspace
  ON bmad_projects ((
    CASE WHEN btrim(workspace_path) ~ '^/+$' THEN '/'
         ELSE regexp_replace(btrim(workspace_path), '/+$', '') END
  ))
  WHERE git_remote_url IS NULL AND workspace_path IS NOT NULL;
```

Bentuk di atas adalah yang **benar-benar terpasang** setelah story 1; versi sebelumnya di dokumen ini (hanya `lower()` + strip `.git`, dan kolom `workspace_path` mentah) sudah tidak berlaku. Index workspace memakai ekstra sepasang kurung karena `CREATE INDEX` menolak `CASE` tanpa kurung.

Index kedua hanya mencakup project tanpa remote, sesuai aturan 2. Kedua index memakai bentuk normalisasi yang sama dengan aturan di atas; bila implementasi JS menormalkan lebih agresif daripada SQL, samakan keduanya di satu fungsi bersama agar keduanya tidak menyimpang.

Satu pengecualian yang disengaja: normalisasi path di resolver menambahkan ekspansi `~` dan pembuatan path absolut, yang tidak bisa dilakukan SQL. Karena itu **path disimpan dalam bentuk sudah ternormalisasi**, sehingga index hanya melihat string absolut dan tidak perlu mengekspansi apa pun. `POST /api/projects` wajib melakukan hal yang sama; kalau tidak, baris yang dibuat lewat jalur create tidak akan pernah cocok dengan hasil resolusi.

Remote wajib ASCII. PostgreSQL `lower()` dan JavaScript `toLowerCase()` berbeda pada karakter non-ASCII (`İ`, sigma Yunani), sehingga kunci TS tidak akan pernah sama dengan kunci SQL dan setiap resolusi akan membuat project duplikat. Remote yang mengandung non-ASCII ditolak, bukan dinormalkan diam-diam.

## State di CLI

`~/.bmad-monitor/config.json` berubah dari satu `activeProjectId` menjadi peta per-workspace:

```json
{
  "activeProjectId": "prj_default",
  "workspaceProjects": {
    "github.com/fatmuh/agentic-engineering-workflow": "prj_default",
    "/Users/adamramadhan/Projects/bmad-monitor-mcp": "prj_abc123"
  }
}
```

- `activeProjectId` tingkat atas dipertahankan sebagai nilai default agar config lama tetap terbaca; ia dipakai hanya bila direktori kerja saat ini tidak ada di peta.
- Setiap tool yang memakai project aktif melakukan resolve berdasarkan direktori kerja proses CLI. Bila peta belum memuat kunci tersebut, jalankan get-or-create lewat API lalu simpan hasilnya ke peta.
- Menulis ke peta adalah read-modify-write dengan penguncian file, karena beberapa proses CLI bisa berjalan bersamaan. Hilangnya satu entri peta tidak boleh menghilangkan entri lain.
