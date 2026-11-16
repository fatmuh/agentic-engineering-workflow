# migration-plan.md — Dampak D-4 dan D-5 pada data yang sudah ada

Dua keputusan mengubah **kunci identitas**. Ini bagian yang paling mudah salah dan paling mahal kalau dilewatkan, jadi aturannya ditulis di sini, bukan di kernel.

## D-4 — case-folding path

### Apa yang berubah

`normalizeWorkspacePath` mengembalikan path lowercase. Kunci baru = kunci lama yang di-lowercase, kecuali pada sistem yang sudah menyimpan path lowercase.

### Bentuk migrasi

Data lama ada di dua tempat, dan keduanya harus berubah bersama dalam satu rilis — bukan satu per satu:

1. **`bmad_projects.workspace_path`** — kolom yang di-index oleh `uq_bmad_projects_workspace`. Migrasi menormalkan kolom dan index harus dibangun ulang dari bentuk baru. Bila dua baris menjadi sama setelah di-lowercase, migrasi **gagal dan berhenti** dengan pesan yang menyebut kedua project; menggabungkan atau menghapus project secara otomatis bukan wewenang migrasi.
2. **`~/.bmad-monitor/config.json` → `workspaceProjects`** — kunci peta di-lowercase. Bila dua kunci lama jatuh ke kunci yang sama, yang dipertahankan adalah entri yang **lebih baru** ditulis; konflik dicatat ke stderr sekali, bukan setiap panggilan.

### Urutan yang aman

Aplikasi harus menerima kunci lama **dan** baru selama masa transisi, jika tidak CLI versi lama yang belum diperbarui akan kehilangan project-nya saat dashboard naik lebih dulu. Resolver membaca kunci baru lebih dulu, lalu kunci lama sebagai fallback baca-saja, dan menulis kunci baru.

### Yang harus dibuktikan

Memasukkan project ber-path berhuruf besar lewat jalur lama, menjalankan migrasi, lalu resolve path yang sama dengan kapitalisasi berbeda — hasilnya harus project yang sama, bukan dua.

## D-5 — penolakan remote ber-kredensial

### Apa yang ditolak

Remote yang mengandung userinfo berbentuk `user:token@` atau `user@` pada skema yang mendukungnya. Deteksi dilakukan pada nilai mentah **sebelum** normalisasi, karena normalisasi yang membuang userinfo justru menghilangkan bukti yang dicari.

Yang ditolak adalah **input baru**. Baris yang sudah ada tidak pernah ditolak oleh migrasi.

### Data lama

Baris lama yang sudah menyimpan remote ber-kredensial tetap dipakai untuk pencocokan, tetapi:

- Bagian userinfo **tidak dikembalikan** oleh API `GET /api/projects` maupun `POST /api/projects/resolve`.
- Membaca baris itu tidak boleh menghasilkan error; ia hanya tidak menampilkan rahasianya.
- Tidak ada operasi tulis otomatis ke baris lama. Membersihkannya adalah tindakan manual yang didokumentasikan, bukan efek samping boot.

### Mengapa penolakan, bukan redaksi

User memutuskan kredensial bukan bagian dari identitas workspace. Kredensial adalah konfigurasi akses yang harus bisa berganti tanpa mengubah project. Menyimpannya ter-redaksi tetap menyimpan rahasia di tabel yang ditampilkan dan di-backup; menolak membuat kelas kebocoran ini tidak mungkin terjadi.

### Yang harus dibuktikan

`POST /api/projects` dan `POST /api/projects/resolve` dengan `gitRemoteUrl` berbentuk `https://user:token@host/repo` sama-sama `400`, dan `bmad_projects` tidak bertambah. Baris lama yang telanjur menyimpan token tidak memuat token itu di respons mana pun.
