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
  bmadNodeToWorktreeNode,
  formatTokens,
  type WorktreeNode,
} from "./worktree-tree-data";
import { formatClock } from "./agent-board-data";
import { Kanban, GitBranch, ChevronDown, Copy, RefreshCw } from "@/components/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Button } from "@/components/ui/button-clean";
import { SegmentedControl } from "@/components/ui/segmented-control-clean";
import { apiFetch } from "@/lib/api";
import type { BMadAgentTreeNode, BMadTaskItem } from "@/lib/bmad";
import type { AgentSessionSummary } from "@/lib/agent-tree";
import { useActiveProject } from "./project-context";
import { WORKSPACE_LIST_FAILED } from "./workspace-switcher-state";
import "./search-filter-controls.css";

/** `ProjectSnapshot` (and the `LoadState` halves it carries) lives in
 *  `board-load.ts`: the token rule and the per-request state mapping are pure
 *  there, so they run under the node-environment unit suite. */
/** A session as the picker shows it; the label is built when the response
 *  arrives, so rendering stays free of clock reads. */
type WorktreeSession = AgentSessionSummary & { label: string; detail: string };

/** The Worktree half of a load: every session, and the tree of one of them. */
interface WorktreeView {
  run: WorktreeNode | null;
  sessions: WorktreeSession[];
  selectedId: string | null;
}

type ProjectSnapshot = BoardSnapshot<AgentTask, WorktreeView>;

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
const SESSION_WORD: Record<AgentSessionSummary["status"], string> = { live: "live", idle: "idle", ended: "ended" };

/** "live since 08:37 · 13.3k tokens", "ended 08:44 · 54.1k tokens". */
function sessionDetail(session: AgentSessionSummary, now: Date): string {
  const time = session.status === "ended" ? session.lastActivityAt : session.startedAt;
  const when = session.status === "ended" ? `ended ${formatClock(time, now)}` : `${SESSION_WORD[session.status]} since ${formatClock(time, now)}`;
  return `${when} · ${formatTokens(session.totalTokens)}`;
}

function parseWorktree(body: unknown): WorktreeView {
  const value = body as { sessions?: unknown; selectedId?: unknown; tree?: unknown } | null;
  if (!value || typeof value !== "object" || !Array.isArray(value.sessions)) {
    throw new Error("Unexpected /agent-tree?sessions=1 payload");
  }
  const tree = value.tree as BMadAgentTreeNode | null;
  if (tree !== null && (typeof tree !== "object" || typeof tree.id !== "string")) {
    throw new Error("Unexpected /agent-tree payload");
  }
  const now = new Date();
  return {
    run: tree ? bmadNodeToWorktreeNode(tree) : null,
    sessions: (value.sessions as AgentSessionSummary[]).map(session => {
      const detail = sessionDetail(session, now);
      return { ...session, detail, label: `${session.name} · ${detail}` };
    }),
    selectedId: typeof value.selectedId === "string" ? value.selectedId : null,
  };
}


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
      Try again
    </Button>
  );
}

const SESSION_STATUS: Record<AgentSessionSummary["status"], { label: string; dot: string }> = {
  live: { label: "Live", dot: "bg-[var(--agent-done)] motion-safe:animate-pulse" },
  idle: { label: "Idle", dot: "bg-[var(--agent-waiting)]" },
  ended: { label: "Ended", dot: "bg-muted-foreground/50" },
};

/** Whether the chosen session is running, waiting for a prompt, or over. */
function SessionStatus({ status }: { status: AgentSessionSummary["status"] }) {
  const { label, dot } = SESSION_STATUS[status];
  return (
    <span data-session-status={status} className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs font-medium text-muted-foreground">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

const HOOK_COMMAND = "bmad-monitor hook-settings";

/** No session has ever reported here: say how to make one appear. */
function WorktreeEmptyState() {
  const copy = () => {
    navigator.clipboard.writeText(HOOK_COMMAND).then(
      () => toast.success("Command copied"),
      () => toast.error(`Couldn't copy. Run: ${HOOK_COMMAND}`),
    );
  };
  return (
    <div data-worktree-empty className="rounded-[14px] bg-muted/50 px-5 py-6 text-sm">
      <h2 className="font-medium">No agent sessions yet</h2>
      <p className="mt-1 text-muted-foreground">Sessions appear here once the Claude Code hook reports to this workspace.</p>
      <ol className="mt-3 grid list-decimal gap-2 ps-5 text-muted-foreground">
        <li>
          <span>Install the hook on the developer machine and merge its output into <code className="text-xs">~/.claude/settings.json</code>:</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-background px-2 py-1 font-mono text-xs text-foreground ring-1 ring-border">{HOOK_COMMAND}</code>
            <Button size="sm" variant="secondary" icon={<Copy />} onClick={copy}>Copy</Button>
          </span>
        </li>
        <li>Start Claude Code in the repository linked to this workspace.</li>
        <li>Move a ticket to in progress to see its work and tokens under the session.</li>
      </ol>
    </div>
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
  const [tab, setTab] = useState<"board" | "worktree">("board");
  // The session the user picked in the Worktree, per project. A ref, not
  // state: the server answers with the session it actually chose (`selectedId`)
  // and that is what renders; the pick only shapes the next request.
  const sessionChoice = useRef<{ projectId: string; id: string } | null>(null);

  const current = snapshot && snapshot.projectId === projectId ? snapshot : null;
  const tasks = current?.tasks ?? [];
  const worktree = current?.worktreeRun ?? null;
  const worktreeRun = worktree?.run ?? null;
  const sessions = worktree?.sessions ?? [];
  const selectedSession = sessions.find(session => session.id === worktree?.selectedId) ?? null;
  // Two independent states: each half of the board reports only its own
  // request, so one failing never marks the other as failed.
  const projectLoadState: LoadState = projectStatus === "error" ? "error" : "loading";
  const tasksState: LoadState = current?.tasksState ?? projectLoadState;
  const treeState: LoadState = current?.treeState ?? projectLoadState;
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
    const choice = sessionChoice.current;
    const sessionParam = choice && choice.projectId === id ? `&session=${encodeURIComponent(choice.id)}` : "";
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
      tree: readLoaded<WorktreeView>(
        apiFetch(`/api/projects/${segment}/agent-tree?sessions=1${sessionParam}`, { cache: "no-store" }),
        parseWorktree,
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

  const chooseSession = (id: string) => {
    if (!projectId) return;
    sessionChoice.current = { projectId, id };
    void loadProjectData(projectId);
  };

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

  // The project-level branch is shared: with no workspace selected, both tabs
  // must report the workspace list's state rather than claim their own data is
  // still loading forever (a failing `/api/projects` never produces an id).
  //
  // The failure case is deliberately NOT part of this string: a failed list is
  // rendered once, by `projectListNotice` below, with its recovery. Both panels
  // suppress the messages that would otherwise repeat it.
  const projectMessage = projectStatus === "ready"
    ? "No workspaces yet."
    : "Loading workspaces…";

  // Each tab reads its OWN half of the snapshot, never the pair. The failure
  // copy must also appear when data from the last successful sync is still on
  // screen (`mergeLoad` keeps it), otherwise a board that worked and then
  // started failing would show stale data and no warning at all — the very
  // case this story exists to make visible. `retained` is that distinction.
  const tasksRetained = tasks.length > 0;
  const treeRetained = worktreeRun !== null;

  const boardEmptyMessage = tasksRetained
    ? "Couldn't refresh this workspace's tasks. Showing data from the last successful sync."
    : "Couldn't load this workspace's tasks. Check the database connection, then press Refresh.";
  const emptyMessage = !projectId
    ? projectMessage
    : tasksState === "loading"
      ? "Loading workspace tasks…"
      : tasksState === "error"
        ? boardEmptyMessage
        : `No tasks in ${project?.name ?? "this workspace"} yet. Tasks reported by agents will appear here.`;

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
      ? "Loading the agent tree…"
      : treeState === "error"
        ? treeRetained
          ? "Couldn't refresh this workspace's agent tree. Showing the tree from the last successful sync."
          : "Couldn't load this workspace's agent tree."
        : `No agent tree in ${project?.name ?? "this workspace"} yet.`;

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
          {/* The id links a repo to this workspace (awm_project_init with
              projectId), so it sits where people look while working on it. */}
          {project && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(project.id).then(
                  () => toast.success("Project ID copied"),
                  () => toast.error(`Couldn't copy. Project ID: ${project.id}`),
                );
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded px-1 font-mono text-[11px] opacity-75 hover:bg-muted hover:opacity-100"
              title="Copy project ID"
              aria-label={`Copy project ID ${project.id}`}
            >
              <Copy className="size-3" aria-hidden="true" />
              {project.id}
            </button>
          )}
          {/* With no project id there is nothing to refetch HERE — the thing
              that failed was `/api/projects`, so the button reloads the list
              instead of being a dead control beside the recovery notice.
              `data-sync-state` is the board's live-sync indicator: the icon
              turns while a load (a poll or a click) is in flight. */}
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw />}
            data-sync-state={syncingFor === projectId && projectId !== null ? "syncing" : "idle"}
            className="data-[sync-state=syncing]:[&_svg]:motion-safe:animate-spin"
            onClick={() => { if (projectId) void loadProjectData(projectId); else reload(); }}
            title={projectId ? "Reload BMad data" : "Reload the workspace list"}
          >
            Refresh
          </Button>
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
            />
          )}
        </div>

        <div
          id="agent-worktree-panel"
          role="tabpanel"
          aria-labelledby="agent-worktree-panel-tab"
          tabIndex={0}
          hidden={tab !== "worktree"}
          className="mt-2 min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {sessions.length > 0 && (
            <div className="search-filter-controls mb-4 flex flex-wrap items-center gap-2">
              {/* A single choice, so a radio menu like the workspace switcher:
                  the visible label is the trigger's accessible name (WCAG
                  2.5.3), with a hidden prefix saying what it picks. */}
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="lg" variant="secondary" className="search-filter-trigger" icon={<GitBranch />} iconRight={<ChevronDown />} />}>
                  <span className="sr-only">Session: </span>{selectedSession?.label ?? "Choose a session"}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={4} className="w-[min(360px,calc(100vw-32px))]">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Sessions, newest first</DropdownMenuLabel>
                    <div className="custom-scrollbar max-h-[calc(5*48px)] overflow-y-auto overscroll-contain">
                      <DropdownMenuRadioGroup value={selectedSession?.id ?? ""} onValueChange={id => { if (id) chooseSession(String(id)); }}>
                        {sessions.map(session => (
                          <DropdownMenuRadioItem key={session.id} value={session.id} label={session.name} closeOnClick className="min-h-12 items-start py-1.5">
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{session.name}</span>
                              <span className="truncate text-xs text-muted-foreground">{session.detail}</span>
                            </span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </div>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {selectedSession && <SessionStatus status={selectedSession.status} />}
            </div>
          )}

          {tab === "worktree" && (
            <>
              {/* Rendered ABOVE the tree, not instead of it: when the last
                  sync succeeded and this one failed, the tree on screen is
                  stale and the user must be told so. A failed project list is
                  the exception — its own notice already says it. */}
              {treeState === "error" && !projectListBlocked && (
                <div className="mb-2"><BoardNotice tone="status">{worktreeEmptyMessage}</BoardNotice></div>
              )}
              {worktreeRun
                // Keyed by session so the tree's open/focus state resets on a switch.
                ? <WorktreeTree key={`live-${projectId ?? "none"}-${selectedSession?.id ?? "none"}`} run={worktreeRun} />
                : treeState === "ready" && sessions.length === 0
                  ? <WorktreeEmptyState />
                  : treeState !== "error" && !projectListBlocked && <BoardNotice tone="status">{worktreeEmptyMessage}</BoardNotice>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
