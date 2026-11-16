import type { BMadAgentTreeNode } from "@/lib/bmad";

/**
 * Links a project's flat agent nodes into trees and returns the one to show.
 *
 * A project can hold several roots: every Claude Code session reported by the
 * `bmad-monitor hook` is its own root, and an `awm_agent_progress` caller may
 * add another. The board shows one tree, so it shows the tree with the most
 * recent activity anywhere in it. Picking the first root by timestamp instead
 * showed the root updated LEAST recently, because every upsert moves a node's
 * timestamp to now(): one stale root hid all later work.
 *
 * `nodes` must be fresh objects; their `children` arrays are filled in place.
 */
export function pickAgentTree(nodes: BMadAgentTreeNode[]): BMadAgentTreeNode | null {
  const byId = new Map<string, BMadAgentTreeNode>();
  for (const node of nodes) {
    node.children = [];
    byId.set(node.id, node);
  }

  const roots: BMadAgentTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent !== node) parent.children!.push(node);
    else roots.push(node);
  }

  let best: BMadAgentTreeNode | null = null;
  let bestTime = -Infinity;
  for (const root of roots) {
    const time = latestActivity(root, new Set());
    if (time >= bestTime) {
      best = root;
      bestTime = time;
    }
  }
  return best;
}

function latestActivity(node: BMadAgentTreeNode, seen: Set<string>): number {
  if (seen.has(node.id)) return -Infinity;
  seen.add(node.id);
  let latest = Date.parse(node.timestamp) || 0;
  for (const child of node.children ?? []) latest = Math.max(latest, latestActivity(child, seen));
  return latest;
}
