import type { AgentTaskState } from "./agent-board-data";
import type { BMadAgentTreeNode } from "@/lib/bmad";

export type WorktreeAvatar = "claude" | "gemini" | "openai";
export type WorktreeTool = "slack" | "notion" | "github" | "figma" | "stripe" | "hubspot";

export interface WorktreeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
}

export type WorktreeNode = {
  id: string;
  agent: string;
  model: string;
  state: AgentTaskState;
  task: string;
  cost?: string;
  tokenUsage?: WorktreeTokenUsage;
  time: string;
  avatar: WorktreeAvatar;
  tools: WorktreeTool[];
  artifacts?: string[];
  children?: WorktreeNode[];
};

export function formatTokens(num: number): string {
  if (!num) return "0 tokens";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M tokens`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k tokens`;
  return `${num} tokens`;
}

export function bmadNodeToWorktreeNode(node: BMadAgentTreeNode): WorktreeNode {
  let state: AgentTaskState = "running";
  if (node.status === "completed") state = "done";
  else if (node.status === "failed") state = "failed";
  else if (node.status === "waiting_approval") state = "waiting";

  const providerLower = (node.modelUsed?.provider || "").toLowerCase();
  const modelIdLower = (node.modelUsed?.modelId || "").toLowerCase();

  let avatar: WorktreeAvatar = "claude";
  if (providerLower.includes("openai") || modelIdLower.includes("gpt")) avatar = "openai";
  else if (providerLower.includes("gemini") || modelIdLower.includes("gemini")) avatar = "gemini";

  const seconds = Math.round((node.durationMs || 0) / 1000);
  const timeFormatted = seconds > 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  const validTools: WorktreeTool[] = ["slack", "notion", "github", "figma", "stripe", "hubspot"];
  const tools = (node.tools || ["github"]).filter((t): t is WorktreeTool => validTools.includes(t as WorktreeTool));

  return {
    id: node.id,
    agent: node.name,
    model: node.modelUsed?.modelId || "BMad Agent",
    state,
    task: node.action || "No action recorded",
    tokenUsage: node.tokenUsage,
    time: timeFormatted,
    avatar,
    tools: tools.length > 0 ? tools : ["github"],
    artifacts: node.artifacts || [],
    children: node.children?.map(bmadNodeToWorktreeNode),
  };
}

/** Screenshot-matching local fixture; compact BMad sprint (2 branches) for layout checks. */
export const bmadWorktreeRun: WorktreeNode = {
  id: "bmad-orchestrator", agent: "BMad Master Orchestrator", model: "claude-opus-5-5",
  state: "running", task: "Mengkoordinasikan analisis arsitektur dan eksekusi task sprint",
  cost: "21.6k tokens", time: "1m 36s", avatar: "claude", tools: ["github", "notion"],
  children: [
    {
      id: "bmad-analyst", agent: "BMad Analyst", model: "claude-sonnet-5-5",
      state: "running", task: "Menganalisis file context docs/PRD.md dan mengidentifikasi dependensi domain",
      cost: "14.6k tokens", time: "54s", avatar: "claude", tools: ["github"],
    },
    {
      id: "bmad-architect", agent: "BMad Architect", model: "claude-sonnet-5-5",
      state: "waiting", task: "Menyiapkan rancangan solusi arsitektur dan security gates",
      cost: "11.0k tokens", time: "36s", avatar: "claude", tools: ["github", "figma"],
      children: [{
        id: "bmad-developer", agent: "BMad Developer", model: "claude-haiku-5-5",
        state: "done", task: "Slicing komponen UI dan menyatukan telemetri token usage",
        cost: "7.8k tokens", time: "28s", avatar: "claude", tools: ["github", "stripe"],
        children: [{
          id: "bmad-qa", agent: "BMad QA Engineer", model: "claude-haiku-5-5",
          state: "running", task: "Menjalankan skenario verifikasi e2e permission gate dan kanban stage",
          cost: "5.0k tokens", time: "27s", avatar: "claude", tools: ["github"],
        }],
      }],
    },
  ],
};

/** Static demo matching the Agent Tree preview; no agents execute. */
export const demoWorktreeRun: WorktreeNode = {
  id: "run-orchestrator",
  agent: "Orchestrator",
  model: "Opus 5.5",
  state: "running",
  task: "Launch the new pricing page by Friday",
  cost: "$1.11",
  time: "47s",
  avatar: "claude",
  tools: ["slack", "notion", "github"],
  children: [
    {
      id: "run-researcher",
      agent: "Researcher",
      model: "Sonnet 5.5",
      state: "running",
      task: "Compare the pricing of five competitors",
      cost: "$0.27",
      time: "40s",
      avatar: "claude",
      tools: ["notion", "slack"],
      children: [
        {
          id: "run-scraper",
          agent: "Scraper",
          model: "Gemini 3.8 Flash",
          state: "done",
          task: "Read the pricing pages of Linear, Notion and three more",
          cost: "$0.03",
          time: "22s",
          avatar: "gemini",
          tools: ["notion"],
        },
        {
          id: "run-analyst",
          agent: "Analyst",
          model: "Sonnet 5.5",
          state: "running",
          task: "Summarize 120 G2 reviews that mention price",
          cost: "$0.08",
          time: "26s",
          avatar: "claude",
          tools: ["hubspot", "notion"],
        },
      ],
    },
    {
      id: "run-writer",
      agent: "Writer",
      model: "Sonnet 5.5",
      state: "waiting",
      task: "Write the copy for the three plans",
      cost: "$0.12",
      time: "36s",
      avatar: "claude",
      tools: ["notion", "figma"],
    },
    {
      id: "run-coder",
      agent: "Coder",
      model: "GPT-6 Sol",
      state: "running",
      task: "Build the page and wire up checkout",
      cost: "$0.21",
      time: "31s",
      avatar: "openai",
      tools: ["github", "stripe", "figma"],
      children: [
        {
          id: "run-tester",
          agent: "Tester",
          model: "GPT-6 Mini",
          state: "running",
          task: "Write and run the checkout tests",
          cost: "$0.03",
          time: "18s",
          avatar: "openai",
          tools: ["github"],
        },
      ],
    },
  ],
};
