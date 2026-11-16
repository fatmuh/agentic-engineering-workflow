import { query } from "./db";
import { pickAgentTree } from "./agent-tree";

export interface BMadTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
}

export interface BMadModelSpec {
  provider: string;
  modelId: string;
}

export interface BMadTaskChecklist {
  title: string;
  completed: boolean;
}

export interface BMadContextFileRef {
  path: string;
  description?: string;
  fileSizeBytes?: number;
  lastModified?: string;
}

export interface BMadTaskStep {
  text: string;
  time: string;
}

export type BMadStage =
  | "backlog"
  | "analysis"
  | "ready_for_review"
  | "in_progress"
  | "completed"
  | "rejected";

export type BMadApprovalStatus = "pending" | "approved" | "rejected";

export interface BMadTaskItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  stage: BMadStage;
  priority: "low" | "medium" | "high" | "urgent";
  approvalStatus: BMadApprovalStatus;
  assignedAgent: string;
  rejectionReason?: string | null;
  contextFiles: BMadContextFileRef[];
  checklists: BMadTaskChecklist[];
  steps: BMadTaskStep[];
  sources: number;
  toolCalls: number;
  duration: string;
  createdAt: string;
  updatedAt: string;
}

export interface BMadAgentTreeNode {
  id: string;
  projectId: string;
  taskId?: string | null;
  parentId?: string | null;
  name: string;
  role: "orchestrator" | "analyst" | "architect" | "developer" | "qa" | string;
  status: "idle" | "running" | "waiting_approval" | "completed" | "failed";
  action: string;
  durationMs: number;
  tokenUsage: BMadTokenUsage;
  modelUsed: BMadModelSpec;
  artifacts: string[];
  tools: string[];
  errorDetail?: string | null;
  timestamp: string;
  children?: BMadAgentTreeNode[];
}

export interface BMadProject {
  id: string;
  name: string;
  gitRemoteUrl?: string | null;
  workspacePath?: string | null;
  ownerId?: string | null;
  teamId?: string | null;
  createdAt: string;
}

/**
 * The demo project that ships with the app. It is the ONLY project the demo
 * seed below ever targets — every other project starts empty on purpose.
 */
export const DEMO_PROJECT_ID = "prj_default";

/**
 * Seed the demo board for `DEMO_PROJECT_ID` if that project is still empty.
 *
 * Idempotent, and deliberately NOT on any read path: `GET /api/projects` must
 * be a read, and reading a brand-new project's board must not plant demo tasks
 * in it. The single caller is the server-startup hook
 * (`src/instrumentation.ts`); nothing else should invoke it.
 *
 * Pass `tasks` on a later attempt to skip the task-count probe and go straight
 * to the node half — see `seedWithNodes` in the startup hook, which uses this
 * to finish a seed that died between the two inserts.
 */
export async function seedDefaultProjectData(
  tasks: "probe" | "present" = "probe"
): Promise<void> {
  await ensureInitialBMadData(DEMO_PROJECT_ID, { tasks });
}

/**
 * Seed the demo tasks/nodes of `projectId` if that project has none.
 *
 * `projectId` has no default: a caller that forgets it must fail to compile
 * rather than silently read and write another project's board.
 *
 * The two inserts are separate statements on purpose — they use different
 * parameter lists and the node insert is a `SELECT ... FROM (VALUES ...)` — so
 * a failure between them leaves a half-seeded project. `tasks: "present"`
 * re-runs only the node half, which is how the startup hook repairs that state;
 * without it the task-count probe would see rows and skip forever, leaving
 * `getBMadAgentTree` returning null indefinitely.
 */
export async function ensureInitialBMadData(
  projectId: string,
  options: { tasks?: "probe" | "present" } = {}
) {
  const existingTasks = await query<{ count: string }>(
    `SELECT count(*) FROM bmad_tasks WHERE project_id = $1`,
    [projectId]
  );
  if (
    options.tasks !== "present" &&
    parseInt(existingTasks.rows[0]?.count ?? "0", 10) === 0
  ) {
    // Seed initial tasks compatible with both AgentBoard and BMad MCP
    await query(
      `INSERT INTO bmad_tasks
        (id, project_id, title, description, stage, priority, approval_status, assigned_agent, steps, checklists, context_files, sources, tool_calls, duration)
       VALUES
        (
          'TASK-101',
          $1,
          'Implementasi Autentikasi OAuth 2.0 PKCE & Whitelist',
          'Membuat handler otorisasi loopback dan endpoint validasi user allowance untuk CLI BMad Monitor.',
          'ready_for_review',
          'high',
          'pending',
          'bmad-architect',
          $2::jsonb,
          $3::jsonb,
          $4::jsonb,
          8, 14, '5m 20s'
        ),
        (
          'TASK-102',
          $1,
          'Analisis Dampak Kode (Code Impact Analysis) pada Auth System',
          'Identifikasi breaking changes dan deprecation modul basic auth lama.',
          'in_progress',
          'medium',
          'approved',
          'bmad-analyst',
          $5::jsonb,
          $6::jsonb,
          $7::jsonb,
          12, 19, '3m 45s'
        ),
        (
          'TASK-103',
          $1,
          'Setup Telemetri Token Usage pada AffectUI Agent Tree',
          'Mengganti metrik cost dolar dengan token breakdown (input, output, cache read/write).',
          'completed',
          'high',
          'approved',
          'bmad-dev',
          $8::jsonb,
          $9::jsonb,
          $10::jsonb,
          23, 31, '12m 10s'
        )
       ON CONFLICT (project_id, id) DO NOTHING`,
      [
        projectId,
        JSON.stringify([
          { text: "Membaca spesifikasi WEB_SPECIFICATION.md", time: "5m lalu" },
          { text: "Membuat endpoint /oauth/authorize dan /api/oauth/token", time: "3m lalu" },
          { text: "Menunggu persetujuan reviewer di Web Dashboard", time: "sekarang" },
        ]),
        JSON.stringify([
          { title: "Verifikasi allowance check di web", completed: true },
          { title: "Callback loopback redirect uri", completed: true },
          { title: "Code challenge S256 validation", completed: false },
        ]),
        JSON.stringify([{ path: "docs/WEB_SPECIFICATION.md", description: "Spesifikasi Auth" }]),
        JSON.stringify([
          { text: "Scanning dependency graph codebase", time: "3m lalu" },
          { text: "Menemukan 2 file terdampak breaking change", time: "1m lalu" },
          { text: "Menyusun strategi migrasi backward compatibility", time: "sekarang" },
        ]),
        JSON.stringify([
          { title: "Scan internal/auth/legacy", completed: true },
          { title: "Drafting mitigation strategy", completed: false },
        ]),
        JSON.stringify([{ path: "src/lib/auth.ts" }]),
        JSON.stringify([
          { text: "Merestrukturisasi komponen WorktreeCard", time: "12m lalu" },
          { text: "Menghubungkan payload tokenUsage dari API", time: "8m lalu" },
          { text: "Verifikasi tampilan responsive dark/light mode", time: "2m lalu" },
        ]),
        JSON.stringify([
          { title: "Format token number display (k/M)", completed: true },
          { title: "Hover tooltip detail cache read/write", completed: true },
        ]),
        JSON.stringify([{ path: "src/components/dashboard/worktree-tree.tsx" }]),
      ]
    );
  }

  const existingNodes = await query<{ count: string }>(
    `SELECT count(*) FROM bmad_agent_nodes WHERE project_id = $1`,
    [projectId]
  );
  if (parseInt(existingNodes.rows[0]?.count ?? "0", 10) === 0) {
    // Seed initial agent tree hierarchy.
    //
    // task_id is now a composite FK `(project_id, task_id) → bmad_tasks`, so a
    // node may only point at a task of its OWN project. The demo tasks above
    // are seeded only when the project had none, so a project that already had
    // some (e.g. a freshly created project that received TASK-101 through
    // tasks/batch) may not own the rest — the CASE narrows task_id to NULL for
    // exactly those. Without it the whole insert aborts on the FK, which
    // surfaces as a 500 on the project's first task-list read. Under v5's
    // global key this same insert silently attached nodes to another project's
    // tasks, which is the bug this migration removes.
    await query(
      `INSERT INTO bmad_agent_nodes
        (id, project_id, task_id, parent_id, name, role, status, action, duration_ms, token_usage, model_used, artifacts, tools)
       SELECT v.id, v.project_id,
              CASE WHEN EXISTS (SELECT 1 FROM bmad_tasks t
                                 WHERE t.project_id = v.project_id AND t.id = v.task_id)
                   THEN v.task_id END,
              v.parent_id, v.name, v.role, v.status, v.action, v.duration_ms,
              v.token_usage, v.model_used, v.artifacts, v.tools
         FROM (VALUES
        (
          'node-root-orchestrator'::text,
          $1::text,
          'TASK-101'::text,
          NULL::text,
          'BMad Master Orchestrator'::text,
          'orchestrator'::text,
          'running'::text,
          'Mengkoordinasikan analisis arsitektur dan eksekusi task sprint'::text,
          84000::bigint,
          $2::jsonb,
          $3::jsonb,
          $4::jsonb,
          $5::jsonb
        ),
        (
          'node-bmad-analyst-01'::text,
          $1::text,
          'TASK-102'::text,
          'node-root-orchestrator'::text,
          'BMad Analyst'::text,
          'analyst'::text,
          'running'::text,
          'Menganalisis file context docs/PRD.md dan mengidentifikasi dependensi domain'::text,
          42000::bigint,
          $6::jsonb,
          $7::jsonb,
          $8::jsonb,
          $9::jsonb
        ),
        (
          'node-bmad-architect-01'::text,
          $1::text,
          'TASK-101'::text,
          'node-root-orchestrator'::text,
          'BMad Architect'::text,
          'architect'::text,
          'waiting_approval'::text,
          'Menyiapkan rancangan solusi arsitektur dan security gates'::text,
          36000::bigint,
          $10::jsonb,
          $11::jsonb,
          $12::jsonb,
          $13::jsonb
        ),
        (
          'node-bmad-dev-01'::text,
          $1::text,
          'TASK-103'::text,
          'node-bmad-architect-01'::text,
          'BMad Developer'::text,
          'developer'::text,
          'completed'::text,
          'Slicing komponen UI dan menyatukan telemetri token usage'::text,
          28000::bigint,
          $14::jsonb,
          $15::jsonb,
          $16::jsonb,
          $17::jsonb
        )
        ) AS v(id, project_id, task_id, parent_id, name, role, status, action, duration_ms, token_usage, model_used, artifacts, tools)
       ON CONFLICT (project_id, id) DO NOTHING`,
      [
        projectId,
        JSON.stringify({ inputTokens: 18450, outputTokens: 3200, cacheReadTokens: 12000, cacheWriteTokens: 2400, totalTokens: 21650 }),
        JSON.stringify({ provider: "Anthropic", modelId: "claude-opus-5-5" }),
        JSON.stringify(["docs/sprint-plan.md"]),
        JSON.stringify(["github", "notion"]),

        JSON.stringify({ inputTokens: 12500, outputTokens: 2100, cacheReadTokens: 6000, cacheWriteTokens: 1100, totalTokens: 14600 }),
        JSON.stringify({ provider: "Anthropic", modelId: "claude-sonnet-5-5" }),
        JSON.stringify(["docs/analysis/domain-model.md"]),
        JSON.stringify(["github"]),

        JSON.stringify({ inputTokens: 9200, outputTokens: 1800, cacheReadTokens: 4200, cacheWriteTokens: 800, totalTokens: 11000 }),
        JSON.stringify({ provider: "Anthropic", modelId: "claude-sonnet-5-5" }),
        JSON.stringify(["docs/architecture-decision.md"]),
        JSON.stringify(["github", "figma"]),

        JSON.stringify({ inputTokens: 6400, outputTokens: 1400, cacheReadTokens: 3100, cacheWriteTokens: 500, totalTokens: 7800 }),
        JSON.stringify({ provider: "Anthropic", modelId: "claude-haiku-5-5" }),
        JSON.stringify(["src/components/dashboard/worktree-tree.tsx"]),
        JSON.stringify(["github", "stripe"]),
      ]
    );
  }
}

/**
 * Get all tasks for a project. Pure read — seeding happens only at startup.
 */
export async function getBMadTasks(projectId: string): Promise<BMadTaskItem[]> {
  const res = await query<{
    id: string;
    project_id: string;
    title: string;
    description: string;
    stage: BMadStage;
    priority: "low" | "medium" | "high" | "urgent";
    approval_status: BMadApprovalStatus;
    assigned_agent: string;
    rejection_reason: string | null;
    context_files: BMadContextFileRef[];
    checklists: BMadTaskChecklist[];
    steps: BMadTaskStep[];
    sources: number;
    tool_calls: number;
    duration: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT * FROM bmad_tasks WHERE project_id = $1 ORDER BY updated_at DESC`,
    [projectId]
  );

  return res.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    stage: row.stage,
    priority: row.priority,
    approvalStatus: row.approval_status,
    assignedAgent: row.assigned_agent,
    rejectionReason: row.rejection_reason,
    contextFiles: row.context_files || [],
    checklists: row.checklists || [],
    steps: row.steps || [],
    sources: row.sources || 0,
    toolCalls: row.tool_calls || 0,
    duration: row.duration || "0s",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Get full hierarchical agent tree for a project. Pure read — seeding happens
 * only at startup.
 */
export async function getBMadAgentTree(projectId: string): Promise<BMadAgentTreeNode | null> {
  const res = await query<{
    id: string;
    project_id: string;
    task_id: string | null;
    parent_id: string | null;
    name: string;
    role: string;
    status: "idle" | "running" | "waiting_approval" | "completed" | "failed";
    action: string;
    duration_ms: string | number;
    token_usage: BMadTokenUsage;
    model_used: BMadModelSpec;
    artifacts: string[];
    tools: string[];
    error_detail: string | null;
    timestamp: Date;
  }>(
    `SELECT * FROM bmad_agent_nodes WHERE project_id = $1 ORDER BY timestamp ASC`,
    [projectId]
  );

  if (res.rows.length === 0) return null;

  const nodes: BMadAgentTreeNode[] = res.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    parentId: row.parent_id,
    name: row.name,
    role: row.role,
    status: row.status,
    action: row.action,
    durationMs: Number(row.duration_ms) || 0,
    tokenUsage: row.token_usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    modelUsed: row.model_used || { provider: "Anthropic", modelId: "claude-sonnet-5-5" },
    artifacts: row.artifacts || [],
    tools: row.tools || [],
    errorDetail: row.error_detail,
    timestamp: row.timestamp.toISOString(),
    children: [],
  }));

  return pickAgentTree(nodes);
}
