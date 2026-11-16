import { describe, expect, it } from "vitest";
import type { BMadAgentTreeNode } from "@/lib/bmad";
import { pickAgentTree } from "@/lib/agent-tree";

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
