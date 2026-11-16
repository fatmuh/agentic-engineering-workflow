/**
 * Pure orchestration for the Agent Board's load: which response may write, and
 * what each of the two independent requests means for its own half of the
 * board.
 *
 * The board fires two requests per load (`tasks` and `agent-tree`) on a 5 s
 * poll, and a mutation (approve/reject) triggers an extra load on top of it, so
 * responses genuinely arrive out of order. Two rules keep the screen honest:
 *
 *   1. A load that started earlier never commits over one that started later.
 *      Every load takes a monotonic token per project when it STARTS; only the
 *      newest token for the active project may write. Tokens are per project
 *      (and compared against the active project) so a load from project A that
 *      settles after a switch to B is discarded rather than read as B's data.
 *   2. The two requests are independent. `tasksState` and `treeState` each
 *      describe only their own request, so a failed `agent-tree` no longer
 *      paints the task list as failed (or the reverse). `lastSyncTime` is only
 *      advanced by a load where BOTH requests succeeded.
 *
 * No React, no DOM, no fetch: the caller resolves each request into a
 * `Loaded<T>`, which keeps every rule above unit-testable in the node
 * environment `vitest.config.mts` uses (this repo has no jsdom).
 */

/** `"loading"` and `"error"` describe the first load; `"ready"` means the
 *  last response for that half of the board committed. Empty is `"ready"` with
 *  zero items — never a demo fixture standing in for the database. */
export type LoadState = "loading" | "ready" | "error";

/** What a *stored* snapshot half can be. A snapshot only ever comes from a
 *  load that committed, so `"loading"` is never stored — the panel synthesizes
 *  it while no snapshot for the active project exists yet. Narrowing this is
 *  what stops a reader concluding a stored snapshot may be mid-load. */
export type SettledState = "ready" | "error";

/**
 * Everything shown for one project, tagged with the project it came from.
 * The tag is what makes switching safe: a response (or a stale render) from
 * project A can never be read as project B's data, and no reset effect is
 * needed — state for a project the panel is no longer showing is simply not
 * current. `tasks: []` is a real answer, never a fixture.
 *
 * The two `*State` fields are deliberately separate: one request failing must
 * not mark the other as failed. Both are settled states — a snapshot exists
 * only after a load committed, so it can never be `"loading"`.
 */
export interface BoardSnapshot<TTask, TTree> {
  projectId: string;
  tasks: TTask[];
  worktreeRun: TTree | null;
  tasksState: SettledState;
  treeState: SettledState;
  lastSyncTime: string | null;
}

/** A load's identity: which project it was started for, and which attempt. */
export interface LoadToken {
  readonly projectId: string;
  readonly serial: number;
}

export interface LoadTracker {
  /** Which project the screen currently shows. Switching projects is what
   *  makes every in-flight token for the previous one non-current. */
  setActiveProject(projectId: string | null): void;
  /** Take the token for a load that is starting now. Deliberately does NOT set
   *  the active project: a mutation that was started for project A can resolve
   *  after a switch to B and kick off one last load for A, which must lose. */
  start(projectId: string): LoadToken;
  /** Whether this load is still the newest one for the active project. */
  isCurrent(token: LoadToken): boolean;
}

export function createLoadTracker(): LoadTracker {
  let activeProjectId: string | null = null;
  // Serial counters are per project and never reset: switching away and back
  // must not hand a still-in-flight load from the earlier visit a token that
  // matches the counter again.
  const latest = new Map<string, number>();
  const bump = (projectId: string) => {
    const serial = (latest.get(projectId) ?? 0) + 1;
    latest.set(projectId, serial);
    return serial;
  };

  return {
    setActiveProject(projectId) {
      // Entering a project starts a new count for it as well as leaving the old
      // one behind: coming back to A is a fresh visit, and a load that was in
      // flight during the earlier visit must not become current again.
      if (projectId !== null && projectId !== activeProjectId) bump(projectId);
      activeProjectId = projectId;
    },
    start(projectId) {
      return { projectId, serial: bump(projectId) };
    },
    isCurrent(token) {
      return (
        token.projectId === activeProjectId &&
        latest.get(token.projectId) === token.serial
      );
    },
  };
}

/** Outcome of ONE request. `ok: false` is any failure — transport, a non-2xx
 *  response, or an unparseable body. The caller decides how to log it. */
export type Loaded<T> = { ok: true; value: T } | { ok: false };

export interface LoadOutcome<TTask, TTree> {
  projectId: string;
  tasks: Loaded<TTask[]>;
  tree: Loaded<TTree | null>;
}

/**
 * Await both requests, then decide whether this load may commit.
 *
 * Returns `null` when a newer load (or a project switch) happened while these
 * were in flight — in that case the caller writes no state at all: not the
 * snapshot, not `lastSyncTime`, not the per-project sync indicator.
 */
export async function runLoad<TTask, TTree>(params: {
  tracker: LoadTracker;
  token: LoadToken;
  tasks: Promise<Loaded<TTask[]>>;
  tree: Promise<Loaded<TTree | null>>;
}): Promise<LoadOutcome<TTask, TTree> | null> {
  const [tasksResult, treeResult] = await Promise.allSettled([
    params.tasks,
    params.tree,
  ]);

  // Checked AFTER both settle and BEFORE anything is written: a request that
  // started earlier and resolves later loses to the newer one, regardless of
  // which half it carried.
  if (!params.tracker.isCurrent(params.token)) return null;

  return {
    projectId: params.token.projectId,
    // A rejection is a failure of that one request, never of the pair.
    tasks: tasksResult.status === "fulfilled" ? tasksResult.value : { ok: false },
    tree: treeResult.status === "fulfilled" ? treeResult.value : { ok: false },
  };
}

/**
 * Fold a committed outcome into the snapshot. Pure: the caller passes the
 * previous snapshot (and gets the next one back), so a successful half keeps
 * whatever the other half already had for this project instead of blanking it.
 */
export function mergeLoad<TTask, TTree>(
  previous: BoardSnapshot<TTask, TTree> | null,
  outcome: LoadOutcome<TTask, TTree>,
  syncedAt: string,
): BoardSnapshot<TTask, TTree> {
  const base =
    previous && previous.projectId === outcome.projectId ? previous : null;

  return {
    projectId: outcome.projectId,
    tasks: outcome.tasks.ok ? outcome.tasks.value : base?.tasks ?? [],
    worktreeRun: outcome.tree.ok ? outcome.tree.value : base?.worktreeRun ?? null,
    tasksState: outcome.tasks.ok ? "ready" : "error",
    treeState: outcome.tree.ok ? "ready" : "error",
    // Only a load that resolved BOTH requests is a full sync. A half-failed
    // load must not claim the board is up to date.
    lastSyncTime:
      outcome.tasks.ok && outcome.tree.ok
        ? syncedAt
        : base?.lastSyncTime ?? null,
  };
}
