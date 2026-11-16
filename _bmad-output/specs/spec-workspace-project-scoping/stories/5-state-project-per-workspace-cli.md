---
title: 'State project per-workspace di CLI Go'
type: 'feature'
created: '2026-11-06'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
deferred: []
baseline_revision: '7843f667aa85414879981ee80f312a56670b3a89'
---

<intent-contract>

## Intent

**Problem:** `~/.bmad-monitor/config.json` menyimpan satu `activeProjectId` global untuk semua direktori, dan `awm_project_init` selalu memanggil `CreateProject` tanpa mencari project yang sudah ada. Dua sesi agent di dua repo berbeda saling menimpa project aktif — last writer wins — sehingga laporan progres repo A muncul di board repo B. Sebelas titik di `internal/mcp/tools.go` membaca `ActiveProjectID` langsung, jadi memperbaikinya satu per satu mudah terlewat.

**Approach:** Config menyimpan peta `workspaceProjects` (kunci workspace → projectId) di samping `activeProjectId` yang tetap ada sebagai default. Satu fungsi resolve berbasis direktori kerja proses menggantikan seluruh fallback langsung, dan `awm_project_init` menjadi get-or-create lewat endpoint resolve di web.

## Boundaries & Constraints

**Always:** Satu fungsi resolve menggantikan **semua** fallback `ActiveProjectID` di `internal/mcp/tools.go` — bukan sebagian. `activeProjectId` tingkat atas tetap dibaca sebagai default agar config lama tetap berfungsi. Peta per-workspace ditulis dengan read-modify-write ber-lock file agar dua proses CLI paralel tidak saling menimpa. Kunci workspace mengikuti aturan `identity-mapping.md` (remote ternormalisasi, fallback path absolut) dan harus identik dengan yang dipakai web. `awm_project_init` memakai endpoint resolve, bukan create.

**Never:** Jangan menghapus atau menimpa `activeProjectId` lama. Jangan mengubah format token OAuth. Jangan mengubah kontrak endpoint web. Jangan menulis ke database langsung dari CLI. Jangan memakai nama workspace sebagai kunci.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dua direktori | Proses CLI di repo A lalu repo B | Laporan menuju project berbeda sesuai direktori | Tidak ada error |
| Config lama | Config tanpa `workspaceProjects` | Tetap terbaca; `activeProjectId` dipakai sebagai default | Tidak ada error |
| Proses paralel | Dua CLI menulis peta bersamaan | Kedua entri tersimpan, tidak ada yang hilang | Tidak ada error |
| Kembali ke repo A | Repo A pernah dipakai, lalu pindah ke B dan kembali | Kembali ke project A tanpa membuat baru | Tidak ada error |
| Repo tanpa project | Direktori belum pernah diinisialisasi | Resolve membuat/menemukan project lewat API lalu menyimpannya | Error API diteruskan |
| Tanpa git remote | Direktori tanpa remote | Kunci memakai path absolut ternormalisasi | Tidak ada error |
| Identitas tak dikenal | Direktori kerja tidak bisa diidentifikasi | Jatuh ke `activeProjectId` | Tidak ada error |
| Status CLI | `status` dijalankan di dua direktori | Melaporkan project per-direktori, sama dengan yang dipakai tool | Tidak ada error |

</intent-contract>

## Code Map

Lokasi: `/Users/adamramadhan/Projects/bmad-monitor-mcp` (repo terpisah; bukan working tree dashboard).

- `internal/config/config.go:12-17` -- struct `Config` dengan `ActiveProjectID` tunggal.
- `internal/config/config.go:63-76` -- `Save()` menulis seluruh struct lewat `os.WriteFile`, tanpa lock: dua proses bersamaan saling menimpa.
- `internal/mcp/tools.go:198` -- `awm_project_init` memanggil `CreateProject` lalu menyetel `ActiveProjectID`, tanpa lookup.
- `internal/mcp/tools.go` -- sebelas titik membaca `r.cfg.ActiveProjectID` langsung (termasuk `awm_auth_status` di `:124` yang melaporkannya sebagai status).
- `internal/client/api_client.go:129` -- `CreateTasks`; `:214` -- `CreateBacklogItem`; pola request ke `/api/projects/{id}/...`.
- Endpoint web baru: `POST /api/projects/resolve` (`src/app/api/projects/resolve/route.ts` di repo dashboard), mengembalikan project + `created`, dan menerima `projectId` eksplisit.
- `_bmad-output/specs/spec-workspace-project-scoping/identity-mapping.md` -- aturan normalisasi dan bentuk peta `workspaceProjects`. Otoritatif.
- Catatan: repo ini memakai `go test`; tidak ada test yang menyentuh config saat ini.

## Tasks & Acceptance

**Execution:**
- `internal/config/config.go` -- Tambah `WorkspaceProjects map[string]string` (`json:"workspaceProjects,omitempty"`), getter/setter dengan lock file di direktori config, dan read-modify-write yang tidak menghapus entri lain -- peta harus aman ditulis dua proses paralel.
- `internal/workspace/identity.go` (baru) -- Normalisasi kunci workspace: remote git (via `git config --get remote.origin.url`) atau path absolut; cerminkan aturan `identity-mapping.md` -- kunci harus sama dengan yang dipakai web.
- `internal/mcp/resolve.go` (baru) -- Satu fungsi resolve `(ctx) (projectID string, err error)` yang membaca direktori kerja, mencari peta, dan bila belum ada memanggil endpoint resolve lalu menyimpan hasilnya -- satu tempat yang menggantikan sebelas fallback.
- `internal/mcp/tools.go` -- Ganti kesebelas pembacaan `r.cfg.ActiveProjectID` dengan pemanggilan resolver; ubah `awm_project_init` menjadi get-or-create lewat endpoint resolve -- jangan biarkan satu pun fallback langsung tersisa.

**Acceptance Criteria:**
- Given proses CLI dijalankan di dua direktori berbeda secara bergantian, when masing-masing melaporkan progres, then laporan menuju dua project berbeda sesuai direktorinya.
- Given config lama tanpa `workspaceProjects`, when CLI dijalankan, then config tetap terbaca dan `activeProjectId` dipakai sebagai default.
- Given dua proses CLI menulis peta bersamaan, when keduanya selesai, then kedua entri ada di file config.
- Given direktori yang belum punya project, when `awm_project_init` dipanggil dua kali, then project yang sama dikembalikan kedua kali dan tidak ada project duplikat.
- Given `grep -c "cfg.ActiveProjectID" internal/mcp/tools.go`, when dijalankan, then hasilnya 0.

## Spec Change Log

## Review Triage Log

### 2026-11-06 — Review pass
- verdicts: 6 findings — high 2, medium 1, low 1, false 1, reject 1
- findings:
  - `[high]` `[patch]` The resolver returned `activeProjectId` directly for ANY unmapped directory whenever the config had no map yet — reproduced: running `status` from the MCP repo reported `prj_default`, the exact defect the story exists to close. The legacy branch only survives when the workspace has no identity at all.
  - `[high]` `[patch]` `bmad-monitor status` only read the map and never resolved, so it could report a different project than the tools would use in the same directory. It now calls the same resolver.
  - `[medium]` `[patch]` Parallel-write safety was claimed but unverified for the real binary; verified with 8 concurrent processes — all entries survived, credentials and `activeProjectId` intact.
  - `[low]` `[patch]` `CreateProject` is now unused by any tool; left in place deliberately, noted here.
  - `[false]` `[reject]` "`awm_project_init` no longer requires `name`" — get-or-create derives it; the endpoint still rejects a genuinely nameless create.
  - `[reject]` `[reject]` "Lock degrades to lockless after 10s" — the merge path still preserves entries; blocking every tool call on a stuck lock is the worse failure.
- verified after patching: `status` from the MCP repo reports its own project and from the dashboard repo reports `prj_default`; alternating between them creates no duplicate; 8 parallel processes produced 10 map entries with none lost; `go build ./...` and `go vet ./...` clean; student config restored byte-identical and the live DB returned to 1 project / 3 tasks / 4 nodes.

## Design Notes

Sebelas titik fallback adalah alasan perubahan ini harus terpusat. Mengganti sebagian meninggalkan jalur yang tetap menulis ke project global, dan bug itu hanya muncul saat dua repo dipakai bersamaan — kondisi yang jarang diuji manual.

Lock file diperlukan karena `Save()` menulis seluruh struct. Read-modify-write tanpa lock berarti entri proses lain yang ditulis di antara baca dan tulis akan hilang, dan kehilangan itu tidak terlihat sampai workspace itu dipakai lagi.

## Verification

**Commands:**
- `go build ./...` -- expected: kompilasi sukses.
- `go vet ./...` -- expected: tanpa temuan.
- `grep -c "cfg.ActiveProjectID" internal/mcp/tools.go` -- expected: `0`.
- Jalankan binary dari dua direktori berbeda, cek `~/.bmad-monitor/config.json` memuat dua entri.
- Jalankan `awm_project_init` dua kali di direktori yang sama -- expected: project id sama, satu baris `bmad_projects` baru.
