import { describe, expect, it } from "vitest";
import type { BMadAgentTreeNode } from "@/lib/bmad";
import { defaultSessionId, linkAgentTrees, pickAgentTree, SESSION_SILENCE_MS, summarizeSessions } from "@/lib/agent-tree";

function node(id: string, timestamp: string, parentId: string | null = null): BMadAgentTreeNode {
  return {
    id, parentId, timestamp, projectId: "p", name: id, role: "orchestrator", status: "completed", action: "",
    durationMs: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    modelUsed: { provider: "Anthropic", modelId: "m" }, artifacts: [], tools: [],
  };
}

describe("pickAgentTree", () => {
  it("returns null for a project without nodes", () => {
    expect(pickAgentTree([])).toBeNull();
  });

  it("links children under their parent", () => {
    const tree = pickAgentTree([node("root", "2026-11-16T01:00:00Z"), node("child", "2026-11-16T01:01:00Z", "root")]);
    expect(tree?.id).toBe("root");
    expect(tree?.children?.map((c) => c.id)).toEqual(["child"]);
  });

  // Rows arrive ordered by timestamp ASC and every upsert moves timestamp to
  // now(), so the first root is the least recently updated one.
  it("shows the session with the latest activity, not the stalest root", () => {
    const tree = pickAgentTree([
      node("cc-setup", "2026-11-16T01:00:00Z"),
      node("cc-tickets", "2026-11-16T02:00:00Z"),
      node("cc-implement", "2026-11-16T03:00:00Z"),
      node("cc-implement-ag1", "2026-11-16T02:59:00Z", "cc-implement"),
    ]);
    expect(tree?.id).toBe("cc-implement");
    expect(tree?.children?.map((c) => c.id)).toEqual(["cc-implement-ag1"]);
  });

  it("counts activity anywhere in a tree, not only on its root", () => {
    const tree = pickAgentTree([
      node("old-root-busy-child", "2026-11-16T01:00:00Z"),
      node("newer-root", "2026-11-16T02:00:00Z"),
      node("child", "2026-11-16T03:00:00Z", "old-root-busy-child"),
    ]);
    expect(tree?.id).toBe("old-root-busy-child");
  });

  it("treats a node whose parent is missing as a root and survives a self-parent", () => {
    const tree = pickAgentTree([node("orphan", "2026-11-16T05:00:00Z", "gone"), node("self", "2026-11-16T01:00:00Z", "self")]);
    expect(tree?.id).toBe("orphan");
  });
});

function full(id: string, timestamp: string, opts: Partial<BMadAgentTreeNode> = {}): BMadAgentTreeNode {
  return { ...node(id, timestamp, opts.parentId ?? null), ...opts };
}

describe("sessions", () => {
  const now = Date.parse("2026-11-17T08:00:00Z");
  const tokens = (total: number) => ({ inputTokens: total, outputTokens: 0, totalTokens: total });

  it("summarises each root, newest activity first, without counting task nodes twice", () => {
    const roots = linkAgentTrees([
      full("cc-old", "2026-11-17T06:00:00Z", { status: "completed", durationMs: 600_000, tokenUsage: tokens(500) }),
      full("cc-new", "2026-11-17T07:55:00Z", { status: "idle", durationMs: 300_000, tokenUsage: tokens(3300) }),
      full("cc-new-task-f-01", "2026-11-17T07:56:00Z", { parentId: "cc-new", status: "completed", tokenUsage: tokens(2200) }),
      full("cc-new-ag1", "2026-11-17T07:57:00Z", { parentId: "cc-new-task-f-01", status: "completed", tokenUsage: tokens(330) }),
    ]);
    const sessions = summarizeSessions(roots, now);
    expect(sessions.map(s => s.id)).toEqual(["cc-new", "cc-old"]);
    expect(sessions[0]).toMatchObject({ status: "idle", totalTokens: 3630, nodeCount: 3, startedAt: "2026-11-17T07:50:00.000Z", lastActivityAt: "2026-11-17T07:57:00.000Z" });
    expect(sessions[1]).toMatchObject({ status: "ended", totalTokens: 500 });
  });

  it("calls a session live while anything in it runs, and ended once it goes silent", () => {
    const live = summarizeSessions(linkAgentTrees([
      full("cc-a", "2026-11-17T07:59:00Z", { status: "idle" }),
      full("cc-a-ag", "2026-11-17T07:59:30Z", { parentId: "cc-a", status: "running" }),
    ]), now);
    expect(live[0].status).toBe("live");
    const silent = summarizeSessions(linkAgentTrees([
      full("cc-b", new Date(now - SESSION_SILENCE_MS - 1000).toISOString(), { status: "running" }),
    ]), now);
    expect(silent[0].status).toBe("ended");
  });

  it("defaults to a live session, then to the most recent one", () => {
    const base = { name: "", startedAt: "", lastActivityAt: "", totalTokens: 0, nodeCount: 1 };
    expect(defaultSessionId([{ ...base, id: "a", status: "ended" }, { ...base, id: "b", status: "live" }])).toBe("b");
    expect(defaultSessionId([{ ...base, id: "a", status: "idle" }, { ...base, id: "b", status: "ended" }])).toBe("a");
    expect(defaultSessionId([])).toBeNull();
  });

  it("returns the requested session's tree, or the latest when it is gone", () => {
    const make = () => [full("cc-1", "2026-11-17T06:00:00Z"), full("cc-2", "2026-11-17T07:00:00Z")];
    expect(pickAgentTree(make(), "cc-1")?.id).toBe("cc-1");
    expect(pickAgentTree(make(), "cc-gone")?.id).toBe("cc-2");
  });
});
