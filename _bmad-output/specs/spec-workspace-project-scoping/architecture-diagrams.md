# architecture-diagrams.md — Alur resolusi dan scoping

## 1. Alur pemilihan workspace di web

```mermaid
sequenceDiagram
    participant U as Pengguna
    participant SB as AppSidebar / WorkspaceSwitcher
    participant ST as State project aktif (konteks + persistensi)
    participant AB as AgentBoardView
    participant API as /api/projects/[projectId]/**

    U->>SB: Pilih workspace B
    SB->>ST: setProjectId(project B)
    ST-->>SB: konfirmasi, tandai item aktif
    ST-->>AB: projectId berubah
    AB->>AB: batalkan poll lama, reset daftar task
    AB->>API: GET /api/projects/B/tasks + /agent-tree
    API-->>AB: data project B
    AB->>AB: mulai poll 5s terhadap project B
```

Kunci: penanda item aktif di sidebar dan sumber data di board berasal dari satu keadaan yang sama. Tidak boleh ada dua sumber kebenaran.

## 2. Resolusi identitas (get-or-create)

```mermaid
flowchart TD
    A[Workspace: path + remote opsional] --> B{Remote ada?}
    B -- ya --> C[normalisasi remote → host/owner/repo]
    C --> D{Ada project dengan remote sama?}
    D -- ya --> E[Pakai project itu]
    D -- tidak --> F[Buat project baru]
    B -- tidak --> G[normalisasi path absolut]
    G --> H{Ada project path sama dan tanpa remote?}
    H -- ya --> E
    H -- tidak --> F
    E --> I[Kembalikan projectId]
    F --> I
```

Pemeriksaan `D` dan `H` harus berada di dalam satu transaksi atau dilindungi unique index, agar dua sesi paralel tidak sama-sama lolos ke `F`.

## 3. Sebelum dan sesudah, sisi CLI

```mermaid
flowchart LR
    subgraph Sekarang
        P1[Proses CLI di repo A] --> C1[(config.json<br/>activeProjectId tunggal)]
        P2[Proses CLI di repo B] --> C1
        C1 --> R1[Selalu project terakhir yang menulis]
    end

    subgraph Sesudah
        P3[Proses CLI di repo A] --> K1[resolve oleh direktori kerja]
        P4[Proses CLI di repo B] --> K2[resolve oleh direktori kerja]
        K1 --> M[(config.json<br/>peta workspace → project)]
        K2 --> M
        K1 --> R3[Project A]
        K2 --> R4[Project B]
    end
```

## 4. Batas tanggung jawab

| Lapisan | Tahu tentang | Tidak tahu tentang |
|---|---|---|
| Sidebar / switcher | daftar project, project terpilih | cara task dimuat |
| AgentBoardView | project terpilih, siklus polling | cara identitas workspace dihitung |
| API `/api/projects/[projectId]/**` | `projectId` dari path | siapa penggunanya, workspace mana asalnya |
| Resolusi identitas | remote/path → project (get-or-create) | UI, tampilan |
| CLI state | direktori kerja → `projectId` | isi board |
