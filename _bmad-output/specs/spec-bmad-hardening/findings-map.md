# findings-map.md — Kesembilan temuan, bukti terkini, dan letaknya

Setiap entri diverifikasi ulang pada 2026-11-06 terhadap HEAD `ad8055a` (dashboard) dan `86bbfc9` (bmad-monitor-mcp). Kolom "Bukti" menyebut apa yang benar-benar terlihat di kode, bukan ringkasan dari catatan lama.

| ID | Capability | Area | Bukti terkini | Status |
|---|---|---|---|---|
| D-1 | CAP-1 | `src/lib/db.ts` | `pg_advisory_xact_lock` hanya ada di dalam `migrateProjectScopedKeys` (`:233`), bukan di seluruh `ensureSchema()`. Boot paralel 8× masih gagal 1 dari 8. | Terbuka |
| D-2 | CAP-2 | `src/app/api/projects/[projectId]/`, `src/lib/db.ts:321` | Hanya ada `agent-tree`, `context-files`, `tasks`. `bmad_backlogs` tidak punya kolom promo yang diharapkan klien Go, dan `id`-nya masih `TEXT PRIMARY KEY` global. | Terbuka |
| D-3 | CAP-3 | `tests/matrix/`, `src/lib/*.test.ts` | `vitest.config.mts` hanya memuat `src/**/*.test.*`; dua berkas yang ada tidak menyentuh `@/lib/db`. | Terbuka (kini diizinkan) |
| D-4 | CAP-4 | `src/lib/project-identity.ts:79` | `normalizeWorkspacePath` tidak meng-case-fold; `path.resolve` dipakai apa adanya. | Terbuka |
| D-5 | CAP-5 | `src/lib/project-identity.ts:50-58` | `normalizeGitRemote` membuang userinfo, jadi remote ber-token menormalkan sama dengan yang bersih; nilai mentahnya tetap disimpan oleh `resolveProject`. | Terbuka |
| D-6 | CAP-6 | `agent-board-view.tsx:405` | `demoWorktreeRun` masih dirender untuk skenario "pricing" tanpa label eksplisit di sekitarnya. `demoAgentTasks` sudah tidak dipakai (pindah ke D-9). | Terbuka sebagian |
| D-7 | CAP-7 | `agent-board-view.tsx:71-83,128` | `isStale` hanya membandingkan `projectId`; `loadState` tunggal dipakai untuk `tasks` dan `agent-tree`. | Terbuka |
| D-8 | CAP-8 | `project-context.tsx:31` | `reload()` diekspos tetapi tidak pernah dipanggil; tidak ada listener `storage`. | Terbuka |
| D-9 | CAP-9 | `agent-board-data.ts:123`, `app-sidebar.tsx:75` | `demoAgentTasks` ekspor mati; toast "Switched workspace to …" berbahasa Inggris sementara string lain Indonesia; switcher tanpa keadaan memuat. | Terbuka |

## Ketergantungan antar-temuan

- D-3 harus dikerjakan **sebelum atau bersama** D-4 dan D-5: keduanya mengubah kunci identitas, dan test adalah satu-satunya cara membuktikan migrasinya benar.
- D-4 dan D-5 menyentuh fungsi yang sama (`project-identity.ts`) dan idealnya satu story, agar normalisasi tidak berubah dua kali dengan dua migrasi terpisah.
- D-6 dan D-9 sama-sama soal data demo; D-6 adalah perilakunya, D-9 adalah sisa kodenya. D-9 yang menghapus `demoAgentTasks`, D-6 yang memastikan tidak ada pengganti diam-diam.
- D-7 dan D-8 keduanya di lapisan state UI dan tidak bergantung pada yang lain.

## Yang **tidak** termasuk

Dua entri di `deferred-findings.md` tidak masuk spec ini dengan sengaja:

- Tidak ada. Kesembilan entri (D-1 sampai D-9) tercakup.
