export type AgentTaskState = "waiting" | "failed" | "running" | "done";
export type AgentColumnId = "needs-you" | "running" | "done";

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
  duration: string;
  sources: number;
  toolCalls: number;
  agent: string;
  steps: AgentStep[];
  stage?: string;
  approvalStatus?: "pending" | "approved" | "rejected";
  rejectionReason?: string | null;
  checklists?: TaskChecklist[];
  contextFiles?: TaskContextFile[];
}

export function bmadTaskToAgentTask(item: {
  id: string;
  title: string;
  description: string;
  stage: string;
  approvalStatus: string;
  assignedAgent: string;
  rejectionReason?: string | null;
  steps?: AgentStep[];
  checklists?: TaskChecklist[];
  contextFiles?: TaskContextFile[];
  sources?: number;
  toolCalls?: number;
  duration?: string;
}): AgentTask {
  let state: AgentTaskState = "running";
  if (item.stage === "completed") {
    state = "done";
  } else if (item.stage === "ready_for_review" && item.approvalStatus === "pending") {
    state = "waiting";
  } else if (item.approvalStatus === "rejected") {
    state = "failed";
  } else if (item.stage === "in_progress" || item.stage === "analysis") {
    state = "running";
  }

  return {
    id: item.id,
    title: item.title,
    description: item.description,
    state,
    stage: item.stage,
    approvalStatus: item.approvalStatus as "pending" | "approved" | "rejected",
    rejectionReason: item.rejectionReason,
    duration: item.duration || "0s",
    sources: item.sources || 0,
    toolCalls: item.toolCalls || 0,
    agent: item.assignedAgent || "BMad Agent",
    steps: item.steps && item.steps.length > 0 ? item.steps : [{ text: "Task created by BMad agent", time: "recently" }],
    checklists: item.checklists || [],
    contextFiles: item.contextFiles || [],
  };
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
  { id: "needs-you", label: "Needs You" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
];

export function agentTaskColumn(state: AgentTaskState): AgentColumnId {
  return state === "waiting" || state === "failed" ? "needs-you" : state;
}

