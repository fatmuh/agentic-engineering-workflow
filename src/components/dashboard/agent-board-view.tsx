"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { AgentBoard } from "./agent-board";
import {
  bmadTaskToAgentTask,
  type AgentTask,
} from "./agent-board-data";
import {
  createLoadTracker,
  mergeLoad,
  runLoad,
  type BoardSnapshot,
  type Loaded,
  type LoadState,
} from "./board-load";
import { WorktreeTree } from "./worktree-tree";
import {
  demoWorktreeRun,
  bmadNodeToWorktreeNode,
  type WorktreeNode,
} from "./worktree-tree-data";
import { Kanban, GitBranch, Filter } from "@/components/icons";
import { Button } from "@/components/ui/button-clean";
import { FilterMenu } from "@/components/ui/filter-menu-clean";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control-clean";
import { apiFetch } from "@/lib/api";
import type { BMadAgentTreeNode, BMadTaskItem } from "@/lib/bmad";
import { useActiveProject } from "./project-context";
import { WORKSPACE_LIST_FAILED } from "./workspace-switcher-state";
import { useAnnounce } from "./announcement-context";
import "./search-filter-controls.css";

/** `ProjectSnapshot` (and the `LoadState` halves it carries) lives in
 *  `board-load.ts`: the token rule and the per-request state mapping are pure
 *  there, so they run under the node-environment unit suite. */
type ProjectSnapshot = BoardSnapshot<AgentTask, WorktreeNode>;

/** Read one request as a `Loaded<T>`: transport failure, a non-2xx status, an
 *  unparseable body, and a body of the wrong shape all mean "this request
 *  failed", never "the pair did".
 *
 *  Shape is validated here rather than trusted, following the convention the
 *  project list uses (`project-context.tsx`): a 200 with an error object, or a
 *  row that is not a task, must not become "no tasks" or a fabricated card —
 *  that is exactly the silent fabrication this board's headers forbid.
 *
 *  Logging is the caller's decision: on a 5 s poll against a down database,
 *  warning here would be two warnings every 5 seconds forever. */
async function readLoaded<T>(request: Promise<Response>, parse: (body: unknown) => T): Promise<Loaded<T>> {
  try {
    const response = await request;
    if (!response.ok) return { ok: false };
    return { ok: true, value: parse(await response.json()) };
  } catch {
    return { ok: false };
  }
}

/** `GET /tasks` answers an array of tasks; anything else (including an error
 *  envelope that still returned 2xx) is a failed read. Non-object rows are
 *  dropped rather than mapped — `bmadTaskToAgentTask` would happily fabricate
 *  a card from `null`. */
function parseTasks(body: unknown): AgentTask[] {
  if (!Array.isArray(body)) throw new Error("Unexpected /tasks payload");
  return body
    .filter((row): row is BMadTaskItem => typeof row === "object" && row !== null)
    .map(bmadTaskToAgentTask);
}

/** `GET /agent-tree` answers a node object or `null` when the project has no
 *  tree. Anything else is a failed read, not an empty tree — a `{error}` body
 *  rendered as "Belum ada pohon agen" would claim the project has no agents. */
function parseTree(body: unknown): WorktreeNode | null {
  if (body === null) return null;
  if (typeof body !== "object" || typeof (body as { id?: unknown }).id !== "string") {
    throw new Error("Unexpected /agent-tree payload");
  }
  return bmadNodeToWorktreeNode(body as BMadAgentTreeNode);
}

/** The Worktree tab's tree source. One option is the workspace's own data and
 *  the other is the static sample in `worktree-tree-data.ts`, so the control is
 *  named for what it selects — calling both "contoh" would mislabel the live
 *  one. Each label says which is which before the choice is made. */
const WORKTREE_SOURCE_LIVE = "Pohon BMad langsung · database";
const WORKTREE_SOURCE_DEMO = "Contoh · Halaman harga · 3 cabang";

/** One notice for every state inside the board panels. Three grey blocks that
 *  each picked their own role and padding drifted apart (status/status/note,
 *  py-6/py-8/py-4); `tone` is now the only thing a caller chooses.
 *
 *  The live region is the sentence ALONE. A focusable control inside
 *  `role="status"` makes focusing it re-announce the whole sentence, so the
 *  action is a sibling in the same row, outside the region. */
function BoardNotice({ tone, children, describeId, action }: {
  tone: "status" | "sample";
  children: ReactNode;
  /** When set, the notice is a description rather than an announcement. */
  describeId?: string;
  /** The recovery for the state being reported, when one exists. */
  action?: ReactNode;
}) {
  return (
    <div
      data-board-notice={tone}
      className={`rounded-[10px] bg-muted/50 px-3 py-4 text-xs text-muted-foreground ${
        action ? "flex flex-wrap items-center justify-center gap-2" : "text-center"
      }`}
    >
      <p
        {...(describeId ? { id: describeId } : {})}
        {...(tone === "status" ? { role: "status" } : {})}
        className="min-w-0"
      >
        {children}
      </p>
      {action}
    </div>
  );
}

/**
 * The "Coba lagi" control for a failed workspace list.
 *
 * `reload()` is synchronous: by the time it returns, `status` is already
 * `"loading"`, this notice is unmounting, and the browser drops focus from the
 * removed button to `<body>` — a keyboard user loses their place entirely.
 * Focus is therefore moved to the board's own section first, which stays
 * mounted. The retry's own progress needs no state here: the board already
 * renders "Memuat workspace…" for the loading status, so a slow retry is
 * visibly working, and a second failure simply brings this notice back.
 */
function WorkspaceListRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={event => {
        // The section is the nearest stable landmark (it outlives the notice).
        event.currentTarget.closest("section")?.focus();
        onRetry();
      }}
    >
      Coba lagi
    </Button>
  );
}

export function AgentBoardView() {
  const { projectId, project, status: projectStatus, reload } = useActiveProject();
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  // Expansion and fold state are also per project: task ids repeat across
  // projects by design (TASK-101 may exist in both), so carrying A's open ids
  // into B would silently unfold a card the user never touched there.
  const [openState, setOpenState] = useState<{ projectId: string | null; ids: string[] }>({
    projectId: null,
    ids: [],
  });
  const [justMoved, setJustMoved] = useState<{ projectId: string; id: string } | null>(null);
  // Write-only: the live region itself lives in `DashboardShell`, so a
  // workspace switch made from any route is announced. `announce` is not a
  // React setter — writing the same sentence twice is a new announcement.
  const announce = useAnnounce();
  const [tab, setTab] = useState<"board" | "worktree">("board");
  const [worktreeSource, setWorktreeSource] = useState("live");

  const current = snapshot && snapshot.projectId === projectId ? snapshot : null;
  const tasks = current?.tasks ?? [];
  const worktreeRun = current?.worktreeRun ?? null;
  // Two independent states: each half of the board reports only its own
  // request, so one failing never marks the other as failed.
  const projectLoadState: LoadState = projectStatus === "error" ? "error" : "loading";
  const tasksState: LoadState = current?.tasksState ?? projectLoadState;
  const treeState: LoadState = current?.treeState ?? projectLoadState;
  const lastSyncTime = current?.lastSyncTime ?? null;
  const openIds = openState.projectId === projectId ? openState.ids : [];
  const justMovedId = justMoved && justMoved.projectId === projectId ? justMoved.id : null;

  // Latest active project, readable from async callbacks. Kept in a ref so a
  // response that started before a switch can tell it is no longer current.
  const projectIdRef = useRef<string | null>(projectId);
  // Which load may still write: a monotonic token per project, taken when a
  // load STARTS. It complements the project guard above — the guard alone let a
  // poll that started before an approve/reject commit AFTER the post-mutation
  // reload and put the old card state back on screen.
  const loadTracker = useRef(createLoadTracker());
  useEffect(() => {
    projectIdRef.current = projectId;
    loadTracker.current.setActiveProject(projectId);
  }, [projectId]);

  // `syncingFor` instead of a boolean: "is this project loading" derives from
  // the active id, so a switch never needs a reset render to clear a spinner
  // left over from the previous project.
  const [syncingFor, setSyncingFor] = useState<string | null>(null);

  // One warning per transition INTO failure, not per poll: a 5 s poll against a
  // down database would otherwise log two lines every 5 seconds forever. Reset
  // whenever a load succeeds again, so the next outage is reported too.
  const failingRef = useRef(false);

  const loadProjectData = useCallback(async (id: string) => {
    const segment = encodeURIComponent(id);
    // The pre-existing project guard, kept alongside the token: a response for
    // a project the panel no longer shows is never current.
    const isStale = () => projectIdRef.current !== id;
    const token = loadTracker.current.start(id);
    // A load for a project the panel no longer shows must not even light the
    // sync indicator: that id can never be cleared again (its own finally is
    // stale), so it would leave the indicator claiming a sync that is not
    // happening here.
    if (!isStale()) setSyncingFor(id);
    const outcome = await runLoad({
      tracker: loadTracker.current,
      token,
      tasks: readLoaded<AgentTask[]>(
        apiFetch(`/api/projects/${segment}/tasks`, { cache: "no-store" }),
        parseTasks,
      ),
      tree: readLoaded<WorktreeNode | null>(
        apiFetch(`/api/projects/${segment}/agent-tree`, { cache: "no-store" }),
        parseTree,
      ),
    });
    // A superseded load writes NOTHING: no snapshot, no lastSyncTime, and no
    // indicator change. The commit and the clear are separate guards because
    // the indicator belongs to the load in flight, not to the one settling: a
    // stale load may finish while a NEWER load is still running, and clearing
    // on settle would drop the dot to "idle" mid-sync.
    if (outcome && !isStale()) {
      // Both half-failure paths (a rejected request folded by `runLoad`, and a
      // 2xx body of the wrong shape) arrive here as `ok: false`; `readLoaded`
      // never rejects, so there is no third path to invent.
      const failed = !outcome.tasks.ok || !outcome.tree.ok;
      if (failed !== failingRef.current) {
        failingRef.current = failed;
        if (failed) console.warn("[BMad Monitor] Sebagian data BMad gagal dimuat; menampilkan hasil sync terakhir.");
      }
      setSnapshot(previous => mergeLoad(previous, outcome, new Date().toLocaleTimeString()));
    }
    if (!isStale() && loadTracker.current.isCurrent(token)) {
      setSyncingFor(syncing => (syncing === id ? null : syncing));
    }
  }, []);

  // Initial fetch and auto-polling every 5 seconds. The effect depends on the
  // active project: switching tears down the old interval and starts one bound
  // to the new id — an interval holding the previous id would keep fetching
  // project A under project B's heading, a failure that looks right at first.
  useEffect(() => {
    if (!projectId) return;
    const id = projectId;
    const poll = () => {
      void loadProjectData(id);
    };
    // The effect body only registers timers; every state commit happens in a
    // timer callback, after the render it belongs to has been painted.
    const kickoff = setTimeout(poll, 0);
    const interval = setInterval(poll, 5000);
    return () => {
      clearTimeout(kickoff);
      clearInterval(interval);
    };
  }, [projectId, loadProjectData]);

  useEffect(() => {
    if (!justMoved) return;
    const timer = setTimeout(() => setJustMoved(null), 900);
    return () => clearTimeout(timer);
  }, [justMoved]);

  const toggle = (id: string) => {
    if (!projectId) return;
    const owner = projectId;
    setOpenState(previous => {
      const ids = previous.projectId === owner ? previous.ids : [];
      return {
        projectId: owner,
        ids: ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id],
      };
    });
  };

  const closeCard = (owner: string, id: string) => {
    setOpenState(previous => (previous.projectId === owner
      ? { projectId: owner, ids: previous.ids.filter(item => item !== id) }
      : previous));
  };

  const patchTaskLocally = (owner: string, id: string, patch: Partial<AgentTask>) => {
    setSnapshot(previous => (previous && previous.projectId === owner
      ? {
          ...previous,
          tasks: previous.tasks.map(item => (item.id === id ? { ...item, ...patch } : item)),
        }
      : previous));
  };

  const approve = async (id: string) => {
    if (!projectId) return;
    const owner = projectId;
    const task = tasks.find(item => item.id === id);
    if (!task) return;

    // Optimistic UI update
    patchTaskLocally(owner, id, {
      state: "running",
      stage: "in_progress",
      approvalStatus: "approved",
      steps: [
        ...task.steps,
        { text: "Disetujui oleh reviewer di Web Dashboard", time: "sekarang" },
      ],
    });
    closeCard(owner, id);
    setJustMoved({ projectId: owner, id });
    announce(`${task.title} disetujui dan dialihkan ke Running.`);

    // Persist to the active workspace's project — the same one the board shows.
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(owner)}/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "in_progress",
          approvalStatus: "approved",
          addStep: "Disetujui oleh reviewer di Web Dashboard",
        }),
      });
      // apiFetch only resolves the transport; a 4xx/5xx is a resolved response.
      // Without this check the optimistic card would silently agree to a write
      // that never happened.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void loadProjectData(owner);
    } catch (err) {
      console.error("[BMad Monitor] Gagal memperbarui status approval:", err);
      void loadProjectData(owner);
      announce(`Gagal menyetujui ${task.title}. Perubahan dibatalkan.`);
    }
  };

  const reject = async (id: string) => {
    if (!projectId) return;
    const owner = projectId;
    const task = tasks.find(item => item.id === id);
    if (!task) return;

    const reason = window.prompt("Masukkan alasan penolakan (opsional):", "") || "Ditolak dari Web Dashboard";

    // Optimistic UI update
    patchTaskLocally(owner, id, {
      state: "failed",
      stage: "rejected",
      approvalStatus: "rejected",
      rejectionReason: reason,
      steps: [
        ...task.steps,
        { text: `Ditolak oleh reviewer: ${reason}`, time: "sekarang" },
      ],
    });
    closeCard(owner, id);
    announce(`${task.title} ditolak.`);

    // Persist to the active workspace's project — the same one the board shows.
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(owner)}/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "rejected",
          approvalStatus: "rejected",
          rejectionReason: reason,
          addStep: `Ditolak oleh reviewer: ${reason}`,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void loadProjectData(owner);
    } catch (err) {
      console.error("[BMad Monitor] Gagal menolak task:", err);
      void loadProjectData(owner);
      announce(`Gagal menolak ${task.title}. Perubahan dibatalkan.`);
    }
  };

  // The project-level branch is shared: with no workspace selected, both tabs
  // must report the workspace list's state rather than claim their own data is
  // still loading forever (a failing `/api/projects` never produces an id).
  //
  // The failure case is deliberately NOT part of this string: a failed list is
  // rendered once, by `projectListNotice` below, with its recovery. Both panels
  // suppress the messages that would otherwise repeat it.
  const projectMessage = projectStatus === "ready"
    ? "Belum ada workspace terdaftar."
    : "Memuat workspace…";

  // Each tab reads its OWN half of the snapshot, never the pair. The failure
  // copy must also appear when data from the last successful sync is still on
  // screen (`mergeLoad` keeps it), otherwise a board that worked and then
  // started failing would show stale data and no warning at all — the very
  // case this story exists to make visible. `retained` is that distinction.
  const tasksRetained = tasks.length > 0;
  const treeRetained = worktreeRun !== null;

  const boardEmptyMessage = tasksRetained
    ? "Gagal memperbarui task workspace ini. Menampilkan data dari sync terakhir yang berhasil."
    : "Gagal memuat task workspace ini. Periksa koneksi database lalu tekan Refresh.";
  const emptyMessage = !projectId
    ? projectMessage
    : tasksState === "loading"
      ? "Memuat task workspace…"
      : tasksState === "error"
        ? boardEmptyMessage
        : `Belum ada task di workspace ${project?.name ?? "ini"}. Task yang dilaporkan agent akan muncul di sini.`;

  // A failed project list is recoverable in place. `reload()` is the context's
  // single recovery path — the same one the switcher's "Coba lagi" uses — so
  // the board gets a visible way to reach it instead of the old advice to
  // reload the whole page.
  //
  // There is deliberately no "stale but populated" variant here. Reaching it
  // needs a `reload()` while rows are loaded, and nothing does that: the
  // switcher's retry only exists on the error path, and the board's Refresh
  // reloads the board's own data. The switcher's menu DOES reach that state
  // and says so in its note (`WORKSPACE_LIST_STALE`); claiming to handle it
  // here would be a branch no user can arrive at.
  const projectListNotice = projectStatus === "error" ? (
    <div className="mb-2">
      <BoardNotice tone="status" action={<WorkspaceListRetry onRetry={reload} />}>
        {WORKSPACE_LIST_FAILED}
      </BoardNotice>
    </div>
  ) : null;

  // The project-level state is already reported by `projectListNotice`, so the
  // panel must not repeat it. Only the board's own emptiness belongs here. The
  // worktree tab has its own message below; rendering both at once tells the
  // user two different things about one project.
  const projectListBlocked = !projectId && projectStatus === "error";
  const showEmptyMessage = !projectListBlocked
    && (!projectId || tasksState === "loading" || tasksState === "error" || tasks.length === 0);
  const worktreeEmptyMessage = !projectId
    ? projectMessage
    : treeState === "loading"
      ? "Memuat pohon agen…"
      : treeState === "error"
        ? treeRetained
          ? "Gagal memperbarui pohon agen workspace ini. Menampilkan pohon dari sync terakhir yang berhasil."
          : "Gagal memuat pohon agen workspace ini."
        : `Belum ada pohon agen di workspace ${project?.name ?? "ini"}.`;

  return (
    // `tabIndex={-1}` makes the section focusable as a programme target only:
    // it takes focus when the retry button unmounts, and stays out of the tab
    // order otherwise.
    <section aria-label="Agent Board" tabIndex={-1} className="flex min-w-0 flex-col gap-4 pb-6 focus-visible:outline-none">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="sr-only">Agent Board</h1>
        <SegmentedControl
          variant="tray"
          size="sm"
          kind="tabs"
          aria-label="Agent Board view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "board", label: "Board", icon: <Kanban />, controls: "agent-board-panel" },
            { value: "worktree", label: "Worktree", icon: <GitBranch />, controls: "agent-worktree-panel" },
          ]}
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* `data-sync-state` mirrors the dot for tests: the dot is
              decorative (`aria-hidden`), so its colour is not observable. */}
          <span
            data-sync-state={syncingFor === projectId && projectId !== null ? "syncing" : "idle"}
            className={`inline-block size-2 rounded-full ${
              syncingFor === projectId && projectId !== null ? "bg-amber-500 animate-pulse" : "bg-emerald-500"
            }`}
            aria-hidden="true"
          />
          <span>BMad Monitor Live Sync</span>
          {project && <span className="text-[11px] opacity-75">· {project.name}</span>}
          {lastSyncTime && <span className="text-[11px] opacity-75">· {lastSyncTime}</span>}
          {/* With no project id there is nothing to refetch HERE — the thing
              that failed was `/api/projects`, and the board's Refresh used to
              be silently inert in exactly that state. Naming the button's real
              job in that case is better than a dead control beside a notice
              that asks the user to recover. */}
          <button
            type="button"
            onClick={() => { if (projectId) void loadProjectData(projectId); else reload(); }}
            className="ms-1 cursor-pointer underline hover:text-foreground"
            title={projectId ? "Muat ulang data BMad" : "Muat ulang daftar workspace"}
          >
            Refresh
          </button>
        </div>
      </div>

      {projectListNotice}

      <div className="min-w-0">
        <div
          id="agent-board-panel"
          role="tabpanel"
          aria-labelledby="agent-board-panel-tab"
          tabIndex={0}
          hidden={tab !== "board"}
          className="mt-2 min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {showEmptyMessage && <div className="mb-2"><BoardNotice tone="status">{emptyMessage}</BoardNotice></div>}
          {tab === "board" && (
            <AgentBoard
              tasks={tasks}
              openIds={openIds}
              justMovedId={justMovedId}
              onToggle={toggle}
              onApprove={approve}
              onReject={reject}
            />
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Terhubung langsung ke database BMad Monitor · Perubahan Approve/Reject langsung terbaca oleh sesi agent di T3 Code CLI.
          </p>
        </div>

        <div
          id="agent-worktree-panel"
          role="tabpanel"
          aria-labelledby="agent-worktree-panel-tab"
          tabIndex={0}
          hidden={tab !== "worktree"}
          className="mt-2 min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <div className="search-filter-controls mb-4">
            <Popover>
              <PopoverTrigger render={<Button size="lg" variant="secondary" className="search-filter-trigger" icon={<Filter />} aria-label="Sumber pohon Worktree" />}>
                {worktreeSource === "live" ? WORKTREE_SOURCE_LIVE : WORKTREE_SOURCE_DEMO}
              </PopoverTrigger>
              <PopoverContent unstyled align="start" className="search-filter-popover">
                <PopoverTitle className="sr-only">Pilih sumber pohon Worktree</PopoverTitle>
                <FilterMenu title="Sumber pohon" selectionMode="single"
                  groups={[{ id: "scenario", label: "Sumber", options: [
                    { id: "live", label: WORKTREE_SOURCE_LIVE },
                    { id: "pricing", label: WORKTREE_SOURCE_DEMO },
                  ] }]}
                  value={{ scenario: [worktreeSource] }}
                  onChange={value => { if (value.scenario?.[0]) setWorktreeSource(value.scenario[0]); }} />
              </PopoverContent>
            </Popover>
          </div>

          {tab === "worktree" && (worktreeSource === "live"
            ? (
              <>
                {/* Rendered ABOVE the tree, not instead of it: when the last
                    sync succeeded and this one failed, the tree on screen is
                    stale and the user must be told so. A failed project list is
                    the exception — its own notice already says it. */}
                {treeState === "error" && !projectListBlocked && (
                  <div className="mb-2"><BoardNotice tone="status">{worktreeEmptyMessage}</BoardNotice></div>
                )}
                {worktreeRun
                  // Keyed by project so the tree's open/focus state resets on a switch.
                  ? <WorktreeTree key={`live-${projectId ?? "none"}`} run={worktreeRun} />
                  : treeState !== "error" && !projectListBlocked && <BoardNotice tone="status">{worktreeEmptyMessage}</BoardNotice>}
              </>
            )
            : (
              // The tree's container describes itself with the caveat, so a
              // screen reader reading the tree meets the label too — a sibling
              // `<p>` would be skipped by anyone navigating straight to the tree.
              <section aria-label="Pohon contoh" aria-describedby="worktree-sample-note">
                <div className="mb-2">
                  <BoardNotice tone="sample" describeId="worktree-sample-note">
                    {project
                      ? "Data contoh, bukan data database. Pohon ini hanya untuk melihat tampilan dan tidak berasal dari workspace " + project.name + "."
                      : "Data contoh, bukan data database. Pohon ini hanya untuk melihat tampilan; belum ada workspace aktif yang bisa menjadi sumbernya."}
                  </BoardNotice>
                </div>
                <WorktreeTree key={`pricing-${projectId ?? "none"}`} run={demoWorktreeRun} />
              </section>
            ))}
          <p className="mt-4 text-xs text-muted-foreground">
            Pohon agen BMad Monitor real-time · Metrik Token Usage (input, output, cache) dilaporkan secara otomatis oleh sub-agent.
          </p>
        </div>
      </div>
    </section>
  );
}
