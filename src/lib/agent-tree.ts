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
export function pickAgentTree(nodes: BMadAgentTreeNode[], rootId?: string | null): BMadAgentTreeNode | null {
  const roots = linkAgentTrees(nodes);
  if (rootId) {
    const chosen = roots.find(root => root.id === rootId);
    if (chosen) return chosen;
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

/** Links flat nodes into trees (filling `children` in place) and returns the
 *  roots. A node whose parent is missing, or is itself, is a root. */
export function linkAgentTrees(nodes: BMadAgentTreeNode[]): BMadAgentTreeNode[] {
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
  return roots;
}

/** A session (one root) as the Worktree's session picker lists it. */
export interface AgentSessionSummary {
  id: string;
  name: string;
  /** live: something is running; idle: open but waiting; ended: closed, or
   *  silent for longer than SESSION_SILENCE_MS (a session that died without
   *  SessionEnd). */
  status: "live" | "idle" | "ended";
  startedAt: string;
  lastActivityAt: string;
  totalTokens: number;
  nodeCount: number;
}

/** Silence after which an unclosed session counts as ended. */
export const SESSION_SILENCE_MS = 30 * 60 * 1000;

/**
 * Summarise linked roots, most recent activity first.
 *
 * Tokens: the session node plus its descendants, except the per-task nodes the
 * hook adds (`<root>-task-<id>`): those hold a slice of the session node's own
 * tokens, so adding them would count that work twice.
 */
export function summarizeSessions(roots: BMadAgentTreeNode[], now: number): AgentSessionSummary[] {
  return roots
    .map(root => {
      let tokens = 0;
      let count = 0;
      let running = false;
      let latest = Date.parse(root.timestamp) || 0;
      const seen = new Set<string>();
      const walk = (node: BMadAgentTreeNode) => {
        if (seen.has(node.id)) return;
        seen.add(node.id);
        count += 1;
        latest = Math.max(latest, Date.parse(node.timestamp) || 0);
        if (node.status === "running") running = true;
        if (!node.id.startsWith(`${root.id}-task-`)) tokens += node.tokenUsage?.totalTokens ?? 0;
        for (const child of node.children ?? []) walk(child);
      };
      walk(root);
      const rootTime = Date.parse(root.timestamp) || latest;
      const started = Math.min(rootTime - (root.durationMs || 0), latest);
      const silent = now - latest > SESSION_SILENCE_MS;
      const status: AgentSessionSummary["status"] =
        root.status === "completed" || root.status === "failed" || silent ? "ended" : running ? "live" : "idle";
      return {
        id: root.id,
        name: root.name,
        status,
        startedAt: new Date(started).toISOString(),
        lastActivityAt: new Date(latest).toISOString(),
        totalTokens: tokens,
        nodeCount: count,
      };
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/** The session to show when the user has not picked one: a live one first,
 *  then the most recently active. */
export function defaultSessionId(sessions: AgentSessionSummary[]): string | null {
  return (sessions.find(session => session.status === "live") ?? sessions[0])?.id ?? null;
}
