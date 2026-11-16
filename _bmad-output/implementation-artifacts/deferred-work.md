# deferred-work.md — pekerjaan yang sengaja ditunda

- source_spec: `_bmad-output/specs/spec-bmad-hardening/stories/3-identitas-workspace-case-fold-dan-tolak-kredensial.md`
  summary: Repo bmad-monitor-mcp tidak punya satu pun unit test untuk logika urutan/migrasi peta workspace dan normalisasi identitas.
  evidence: `find . -name '*_test.go'` di /Users/adamramadhan/Projects/bmad-monitor-mcp mengembalikan nol berkas dan `go test ./...` melaporkan [no test files] untuk sembilan package; komparator migrasi peta yang terbalik dan parser urutan kunci lolos tanpa terdeteksi. Fungsi-fungsi ini murni string+file dan tidak butuh database, jadi test-nya murah.

- source_spec: `_bmad-output/specs/spec-bmad-hardening/stories/4-bootstrap-schema-tahan-multi-instance.md`
  summary: Timeout `lock_timeout` yang terjadi di dalam blok DDL bootstrap (bukan saat mengambil lock) tidak diuji.
  evidence: Mengujinya butuh 60 detik nyata plus table lock dari transaksi lain; dampaknya pesan diagnostik yang kurang kontekstual, bukan kehilangan data atau ketersediaan. Bila ini diperbaiki, tambahkan test yang memegang table lock `bmad_tasks` dari sesi lain selama bootstrap.
