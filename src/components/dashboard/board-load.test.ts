import { describe, expect, it } from "vitest";
import {
  createLoadTracker,
  mergeLoad,
  runLoad,
  type BoardSnapshot,
  type Loaded,
} from "./board-load";

/**
 * Unit coverage for the Agent Board's load orchestration (spec-bmad-hardening
 * story 5, CAP-7). Every row of the story's I/O matrix that does not need a
 * browser is pinned here: the pure module owns the token rule, the
 * allSettled → tasksState/treeState mapping, and the per-half merge, so the
 * component stays a thin caller and this file runs in the node environment
 * `vitest.config.mts` already uses (no jsdom in this repo).
 */

interface Task {
  id: string;
}
interface Tree {
  id: string;
}

/** A response factory: `resolve()`/`reject()` are driven by the test, so the
 *  ordering of "which load settles last" is explicit rather than timed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ok = <T,>(value: T): Loaded<T> => ({ ok: true, value });
const failed = <T,>(): Loaded<T> => ({ ok: false });

function snapshot(
  overrides: Partial<BoardSnapshot<Task, Tree>> = {},
): BoardSnapshot<Task, Tree> {
  return {
    projectId: "A",
    tasks: [],
    worktreeRun: null,
    tasksState: "ready",
    treeState: "ready",
    lastSyncTime: "10:00:00",
    ...overrides,
  };
}

describe("load token: only the newest load for the active project commits", () => {
  it("discards an older load that settles after a newer one (row 1)", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");

    const firstToken = tracker.start("A");
    const firstTasks = deferred<Loaded<Task[]>>();
    const firstTree = deferred<Loaded<Tree | null>>();
    const first = runLoad({
      tracker,
      token: firstToken,
      tasks: firstTasks.promise,
      tree: firstTree.promise,
    });

    const secondToken = tracker.start("A");
    const second = await runLoad({
      tracker,
      token: secondToken,
      tasks: Promise.resolve(ok<Task[]>([{ id: "newer" }])),
      tree: Promise.resolve(ok<Tree | null>({ id: "tree-newer" })),
    });
    expect(second?.tasks).toEqual(ok<Task[]>([{ id: "newer" }]));

    // The older load settles last — and is dropped without an outcome.
    firstTasks.resolve(ok<Task[]>([{ id: "older" }]));
    firstTree.resolve(ok<Tree | null>({ id: "tree-older" }));
    await expect(first).resolves.toBeNull();
  });

  it("keeps the post-mutation reload when the 5 s poll started first (row 2)", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");

    // The poll starts first but is slow.
    const pollToken = tracker.start("A");
    const pollTasks = deferred<Loaded<Task[]>>();
    const pollTree = deferred<Loaded<Tree | null>>();
    const poll = runLoad({
      tracker,
      token: pollToken,
      tasks: pollTasks.promise,
      tree: pollTree.promise,
    });

    // The approve/reject reload starts later and lands first.
    const reloadToken = tracker.start("A");
    const reload = await runLoad({
      tracker,
      token: reloadToken,
      tasks: Promise.resolve(ok<Task[]>([{ id: "approved" }])),
      tree: Promise.resolve(ok<Tree | null>({ id: "tree" })),
    });

    pollTasks.resolve(ok<Task[]>([{ id: "approved" }]));
    pollTree.resolve(ok<Tree | null>({ id: "tree" }));
    await expect(poll).resolves.toBeNull();

    const merged = mergeLoad<Task, Tree>(null, reload!, "10:00:05");
    expect(merged.tasks).toEqual([{ id: "approved" }]);
    expect(merged.tasksState).toBe("ready");
    expect(merged.treeState).toBe("ready");
  });

  it("discards a load from the project the user left, even after switching back (row 3)", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");

    const tokenA = tracker.start("A");
    const inFlightA = runLoad({
      tracker,
      token: tokenA,
      tasks: Promise.resolve(ok<Task[]>([{ id: "A-task" }])),
      tree: Promise.resolve(ok<Tree | null>({ id: "A-tree" })),
    });

    // Switch to B while A's load is still running.
    tracker.setActiveProject("B");
    await expect(inFlightA).resolves.toBeNull();

    // Back to A: the earlier visit's token must not become current again.
    tracker.setActiveProject("A");
    expect(tracker.isCurrent(tokenA)).toBe(false);

    const freshA = tracker.start("A");
    expect(freshA.serial).not.toBe(tokenA.serial);
    const reloaded = await runLoad({
      tracker,
      token: freshA,
      tasks: Promise.resolve(ok<Task[]>([{ id: "fresh-A" }])),
      tree: Promise.resolve(ok<Tree | null>(null)),
    });
    expect(reloaded?.tasks).toEqual(ok<Task[]>([{ id: "fresh-A" }]));
  });

  it("does not commit a load for a project that is not active", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("B");

    // A mutation for A resolving after the switch starts one last load for A.
    const tokenA = tracker.start("A");
    const outcome = await runLoad({
      tracker,
      token: tokenA,
      tasks: Promise.resolve(ok<Task[]>([{ id: "A" }])),
      tree: Promise.resolve(ok<Tree | null>(null)),
    });
    expect(outcome).toBeNull();
  });
});

describe("separated loadState: each request reports only itself", () => {
  it("agent-tree fails while tasks succeed (row 4)", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");
    const outcome = await runLoad<Task, Tree>({
      tracker,
      token: tracker.start("A"),
      tasks: Promise.resolve(ok<Task[]>([{ id: "TASK-1" }])),
      tree: Promise.resolve(failed<Tree | null>()),
    });
    const merged = mergeLoad<Task, Tree>(null, outcome!, "10:00:05");

    expect(merged.tasksState).toBe("ready");
    expect(merged.treeState).toBe("error");
    expect(merged.tasks).toEqual([{ id: "TASK-1" }]);
    expect(merged.worktreeRun).toBeNull();
  });

  it("tasks fail while agent-tree succeeds (row 5)", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");
    const outcome = await runLoad<Task, Tree>({
      tracker,
      token: tracker.start("A"),
      tasks: Promise.resolve(failed<Task[]>()),
      tree: Promise.resolve(ok<Tree | null>({ id: "root" })),
    });
    const merged = mergeLoad<Task, Tree>(null, outcome!, "10:00:05");

    expect(merged.tasksState).toBe("error");
    expect(merged.treeState).toBe("ready");
    expect(merged.worktreeRun).toEqual({ id: "root" });
  });

  it("both fail (row 6) — a rejection that lands after the other half settled still fails only its own half", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");
    // The tree settles first; the tasks request rejects only afterwards, so the
    // rejection genuinely arrives late rather than being already-settled at
    // call time. That ordering is what `deferred` exists to produce.
    const lateTasks = deferred<Loaded<Task[]>>();
    const loading = runLoad<Task, Tree>({
      tracker,
      token: tracker.start("A"),
      tasks: lateTasks.promise,
      tree: Promise.resolve(failed<Tree | null>()),
    });

    lateTasks.reject(new Error("500"));
    const outcome = await loading;
    const merged = mergeLoad<Task, Tree>(null, outcome!, "10:00:05");

    expect(merged.tasksState).toBe("error");
    expect(merged.treeState).toBe("error");
  });

  it("both succeed and empty (row 7)", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");
    const outcome = await runLoad<Task, Tree>({
      tracker,
      token: tracker.start("A"),
      tasks: Promise.resolve(ok<Task[]>([])),
      tree: Promise.resolve(ok<Tree | null>(null)),
    });
    const merged = mergeLoad<Task, Tree>(null, outcome!, "10:00:05");

    expect(merged.tasksState).toBe("ready");
    expect(merged.treeState).toBe("ready");
    expect(merged.tasks).toEqual([]);
    expect(merged.worktreeRun).toBeNull();
  });

  it("writes no snapshot at all when the project changed mid-load (row 8)", async () => {
    const tracker = createLoadTracker();
    tracker.setActiveProject("A");
    const token = tracker.start("A");

    tracker.setActiveProject("B");
    const outcome = await runLoad<Task, Tree>({
      tracker,
      token,
      tasks: Promise.resolve(ok<Task[]>([{ id: "A-task" }])),
      tree: Promise.resolve(ok<Tree | null>({ id: "A-tree" })),
    });

    // `null` is the contract: the caller commits nothing — not the snapshot,
    // not lastSyncTime, not the sync indicator.
    expect(outcome).toBeNull();
  });
});

describe("mergeLoad", () => {
  it("keeps the other half's committed data when one request fails", () => {
    const base = snapshot({
      tasks: [{ id: "kept" }],
      worktreeRun: { id: "kept-tree" },
    });

    const tasksFailed = mergeLoad<Task, Tree>(
      base,
      {
        projectId: "A",
        tasks: failed<Task[]>(),
        tree: ok<Tree | null>({ id: "new-tree" }),
      },
      "10:00:10",
    );
    expect(tasksFailed.tasks).toEqual([{ id: "kept" }]);
    expect(tasksFailed.tasksState).toBe("error");
    expect(tasksFailed.worktreeRun).toEqual({ id: "new-tree" });

    const treeFailed = mergeLoad<Task, Tree>(
      base,
      {
        projectId: "A",
        tasks: ok<Task[]>([{ id: "new-task" }]),
        tree: failed<Tree | null>(),
      },
      "10:00:10",
    );
    expect(treeFailed.worktreeRun).toEqual({ id: "kept-tree" });
    expect(treeFailed.treeState).toBe("error");
    expect(treeFailed.tasks).toEqual([{ id: "new-task" }]);
  });

  it("never borrows another project's data as the base", () => {
    const base = snapshot({ projectId: "B", tasks: [{ id: "B-task" }] });
    const merged = mergeLoad<Task, Tree>(
      base,
      {
        projectId: "A",
        tasks: failed<Task[]>(),
        tree: failed<Tree | null>(),
      },
      "10:00:10",
    );
    expect(merged.projectId).toBe("A");
    expect(merged.tasks).toEqual([]);
    expect(merged.worktreeRun).toBeNull();
    expect(merged.tasksState).toBe("error");
    expect(merged.treeState).toBe("error");
  });

  it("advances lastSyncTime only when both requests succeeded", () => {
    const base = snapshot({ lastSyncTime: "10:00:00" });

    const partial = mergeLoad<Task, Tree>(
      base,
      {
        projectId: "A",
        tasks: ok<Task[]>([]),
        tree: failed<Tree | null>(),
      },
      "10:00:10",
    );
    expect(partial.lastSyncTime).toBe("10:00:00");

    const full = mergeLoad<Task, Tree>(
      base,
      {
        projectId: "A",
        tasks: ok<Task[]>([]),
        tree: ok<Tree | null>(null),
      },
      "10:00:10",
    );
    expect(full.lastSyncTime).toBe("10:00:10");
  });

  it("reports no sync time when the very first load is half-failed", () => {
    const merged = mergeLoad<Task, Tree>(
      null,
      {
        projectId: "A",
        tasks: ok<Task[]>([]),
        tree: failed<Tree | null>(),
      },
      "10:00:10",
    );
    expect(merged.lastSyncTime).toBeNull();
  });
});
