import type { BMadTokenUsage } from "@/lib/bmad";

/**
 * Board model. The board monitors agent work, so a card answers three things:
 * where the task is (column + state), how long it ran (or has been running),
 * and what it cost in tokens. Approval is not part of it: SIMS agents never
 * wait for a reviewer, so an "approve" step on the board only implied a gate
 * that does not exist.
 */
export type AgentTaskState = "backlog" | "todo" | "running" | "done" | "wontdo";
export type AgentColumnId = "todo" | "running" | "done";

export interface AgentStep {
  text: string;
  time: string;
}

export interface TaskChecklist {
  title: string;
  completed: boolean;
}

export interface TaskContextFile {
  path: string;
  description?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  description: string;
  state: AgentTaskState;
  agent: string;
  steps: AgentStep[];
  stage?: string;
  rejectionReason?: string | null;
  checklists?: TaskChecklist[];
  contextFiles?: TaskContextFile[];
  /** ISO times; null when the task never ran or is still open. */
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  tokens: BMadTokenUsage;
}

const NO_TOKENS: BMadTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

/** Dashboard stage → board state. Unknown stages count as to do. */
export function stageState(stage: string): AgentTaskState {
  switch (stage) {
    case "in_progress":
    case "analysis":
      return "running";
    case "completed":
      return "done";
    case "rejected":
      return "wontdo";
    case "backlog":
      return "backlog";
    default:
      return "todo";
  }
}

export function bmadTaskToAgentTask(item: {
  id: string;
  title: string;
  description: string;
  stage: string;
  assignedAgent: string;
  rejectionReason?: string | null;
  steps?: AgentStep[];
  checklists?: TaskChecklist[];
  contextFiles?: TaskContextFile[];
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  tokenUsage?: BMadTokenUsage;
}): AgentTask {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    state: stageState(item.stage),
    stage: item.stage,
    rejectionReason: item.rejectionReason,
    agent: item.assignedAgent || "BMad Agent",
    steps: item.steps ?? [],
    checklists: item.checklists || [],
    contextFiles: item.contextFiles || [],
    startedAt: item.startedAt ?? null,
    completedAt: item.completedAt ?? null,
    createdAt: item.createdAt ?? null,
    tokens: item.tokenUsage ?? NO_TOKENS,
  };
}

/** One line of a card's timeline. `at` is an ISO time, or null when unknown. */
export interface TimelineEntry {
  text: string;
  at: string | null;
}

/** Placeholder step older rows carry; creation now comes from `createdAt`. */
const PLACEHOLDER_STEP = "Task created by BMad agent";

/**
 * The card's timeline: created, started and finished from the recorded
 * times, plus the steps agents reported. A step's stored time is kept only when
 * it is a real timestamp; older rows stored relative words ("now", "5m ago")
 * that were frozen at write time and would read as current forever.
 */
export function taskTimeline(task: Pick<AgentTask, "state" | "steps" | "createdAt" | "startedAt" | "completedAt">): TimelineEntry[] {
  const real = (time: string) => (time && !Number.isNaN(Date.parse(time)) && /\d{4}-\d{2}-\d{2}/.test(time) ? time : null);
  const entries: TimelineEntry[] = [];
  if (task.createdAt) entries.push({ text: "Created", at: task.createdAt });
  for (const step of task.steps) {
    if (step.text === PLACEHOLDER_STEP) continue;
    entries.push({ text: step.text, at: real(step.time) });
  }
  if (task.startedAt) entries.push({ text: "Started", at: task.startedAt });
  if (task.completedAt) entries.push({ text: task.state === "wontdo" ? "Closed" : "Finished", at: task.completedAt });
  // Chronological where times are known; untimed steps keep their place
  // relative to the entry before them.
  const keyed = entries.map((entry, index) => ({ entry, index, t: entry.at ? Date.parse(entry.at) : null }));
  let last = -Infinity;
  for (const k of keyed) {
    if (k.t === null) k.t = last;
    else last = k.t;
  }
  return keyed.sort((a, b) => (a.t! - b.t!) || (a.index - b.index)).map(k => k.entry);
}

/** Milliseconds the task ran: start to finish, or start to `now` while running. */
export function runMillis(task: Pick<AgentTask, "state" | "startedAt" | "completedAt">, now: number): number | null {
  if (!task.startedAt) return null;
  const start = Date.parse(task.startedAt);
  const end = task.state === "running" ? now : task.completedAt ? Date.parse(task.completedAt) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** `45s`, `12m 03s`, `2h 05m`. */
export function formatRunTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** Clock time for a card: `14:32` today, `16 Nov, 14:32` otherwise. */
export function formatClock(iso: string, now: Date, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
  return `${day}, ${time}`;
}

/** Full timestamp for the expanded card. */
export function formatDateTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(date);
}

export function parseDurationToSeconds(str: string): number {
  if (!str) return 0;
  const minMatch = str.match(/(\d+)\s*m/);
  const secMatch = str.match(/(\d+)\s*s/);
  const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
  const secs = secMatch ? parseInt(secMatch[1], 10) : 0;
  if (!minMatch && !secMatch) {
    const rawNum = parseInt(str, 10);
    return isNaN(rawNum) ? 0 : rawNum;
  }
  return mins * 60 + secs;
}

export function formatSecondsToDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const mins = Math.floor(s / 60);
  const remSecs = s % 60;
  if (mins > 0) {
    return `${mins}m ${remSecs < 10 ? `0${remSecs}` : remSecs}s`;
  }
  return `${remSecs}s`;
}

export const agentColumns: { id: AgentColumnId; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
];

export function agentTaskColumn(state: AgentTaskState): AgentColumnId {
  if (state === "backlog" || state === "todo") return "todo";
  if (state === "wontdo") return "done";
  return state;
}
