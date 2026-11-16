import type { PoolClient } from "pg";
import { ensureSchema, pool, query } from "./db";
import type { BMadTaskItem, BMadTokenUsage } from "./bmad";
import { isUniqueViolation } from "./projects";

/**
 * Backlog DB logic (spec-bmad-hardening story 2) — the ide → impact → promote
 * flow behind the four `awm_backlog_*` MCP tools. Routes stay thin: every
 * query here filters by project_id, because since schema v7 a `BKL-001` in one
 * project is a different row from a `BKL-001` in another.
 *
 * Wire shapes are the Go MCP client's contracts (internal/models/models.go,
 * read-only reference): `BacklogItem` for backlogs, `KanbanTaskItem` for a
 * promoted task. Field names are camelCase; `impactAnalysis` and the three
 * promoted_* fields appear only when filled, mirroring the client's omitempty
 * tags so a draft never answers with `promotedToTaskId: null`.
 */

/** Mirror of the Go client's CodeImpactAnalysis. Stored verbatim as JSONB and
 *  returned as-is — only `riskLevel` is validated; nothing is reshaped. */
export interface BacklogImpactAnalysis {
  analyzedAt: string;
  analyzerAgent: string;
  affectedFiles: { path: string; changeType: string; description: string }[];
  riskLevel: string;
  breakingChange: boolean;
  breakingChangeDetails?: string;
  handlingStrategy: {
    architecturalApproach: string;
    backwardCompatibility: string;
    rollbackPlan?: string;
  };
  suggestedChecklists: { title: string; estimatedEffort: string }[];
  tokenUsage: BMadTokenUsage;
}

/** The backlog shape every backlog endpoint returns (Go: BacklogItem). */
export interface BacklogItem {
  id: string;
  projectId: string;
  title: string;
  rawDescription: string;
  source: string;
  createdBy: string;
  createdAt: string;
  status: string;
  impactAnalysis?: BacklogImpactAnalysis;
  promotedToTaskId?: string;
  promotedBy?: string;
  promotedAt?: string;
}

/**
 * A backlog-flow failure the routes answer with its own HTTP status. Anything
 * else escaping this module is a real error and becomes a 500.
 */
export class BacklogError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BacklogError";
    this.status = status;
  }
}

/** A `bmad_backlogs` row as pg returns it (v5 columns + the v8 promotion trio). */
interface BacklogRow {
  id: string;
  project_id: string;
  title: string;
  raw_description: string;
  source: string;
  created_by: string;
  status: string;
  impact_analysis: BacklogImpactAnalysis | null;
  promoted_to_task_id: string | null;
  promoted_by: string | null;
  promoted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toBacklogItem(row: BacklogRow): BacklogItem {
  const item: BacklogItem = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    rawDescription: row.raw_description,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    status: row.status,
  };
  if (row.impact_analysis !== null) item.impactAnalysis = row.impact_analysis;
  if (row.promoted_to_task_id !== null) item.promotedToTaskId = row.promoted_to_task_id;
  if (row.promoted_by !== null) item.promotedBy = row.promoted_by;
  if (row.promoted_at !== null) item.promotedAt = row.promoted_at.toISOString();
  return item;
}

/** A `bmad_tasks` row as pg returns it. */
interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  stage: BMadTaskItem["stage"];
  priority: BMadTaskItem["priority"];
  approval_status: BMadTaskItem["approvalStatus"];
  assigned_agent: string;
  rejection_reason: string | null;
  context_files: BMadTaskItem["contextFiles"];
  checklists: BMadTaskItem["checklists"];
  steps: BMadTaskItem["steps"];
  sources: number;
  tool_calls: number;
  duration: string;
  created_at: Date;
  updated_at: Date;
}

/** Map to the promote response — a KanbanTaskItem for the Go client (a
 *  BMadTaskItem; Go ignores the steps/sources/toolCalls/duration extras). */
function toTaskItem(row: TaskRow): BMadTaskItem {
  return {
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
  };
}

/** Non-empty string, or undefined. The Go client marshals zero-value strings
 *  ("" id, "" targetStage), which must read as "absent", never as a value. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** How many read→insert rounds before giving up on a constantly-losing id race. */
const ID_RACE_ATTEMPTS = 3;

/** pg errors carry a SQLSTATE; 23503 is foreign_key_violation. */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23503"
  );
}

/**
 * Next sequential `<prefix>-<n>` id for one project, read inside the caller's
 * transaction. Human-shaped ids (BKL-001) over timestamps, per the story's
 * design note; the 3-digit padding is cosmetic and grows naturally past 999.
 * MAX+1 counts the demo seeds (TASK-101…) and any explicit numeric ids, and a
 * create/promote race is settled by the unique violation + retry around the
 * transaction — the same convergence resolveProject relies on.
 *
 * The digit bound is `{1,9}`, not `+`: an explicit id like BKL-9999999999 does
 * not fit int4, and one such row would otherwise abort every later generated
 * create/promote in that project. Absurd ids are simply ignored by the MAX.
 */
async function nextSequentialId(
  client: PoolClient,
  table: "bmad_backlogs" | "bmad_tasks",
  projectId: string,
  prefix: "BKL" | "TASK"
): Promise<string> {
  const res = await client.query<{ n: number }>(
    `SELECT COALESCE(MAX((regexp_replace(id, '^${prefix}-', ''))::int), 0) + 1 AS n
       FROM ${table}
      WHERE project_id = $1 AND id ~ '^${prefix}-[0-9]{1,9}$'`,
    [projectId]
  );
  return `${prefix}-${String(res.rows[0].n).padStart(3, "0")}`;
}

export interface CreateBacklogInput {
  id?: string;
  title?: string;
  rawDescription?: string;
  source?: string;
  createdBy?: string;
}

/**
 * Insert one backlog row, always as a draft. `status` is never taken from the
 * body (the MCP client sends its own "draft" constant; the server decides).
 * An explicit non-empty id wins — two projects may each own a `BKL-001`
 * because the primary key is composite. Without one, the id is sequential per
 * project, allocated in the insert transaction with a 23505 retry.
 */
export async function createBMadBacklog(
  projectId: string,
  input: CreateBacklogInput
): Promise<BacklogItem> {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) {
    throw new BacklogError(400, "A backlog title is required");
  }

  const explicitId = optionalString(input?.id);
  const rawDescription = optionalString(input?.rawDescription) ?? "";
  // "t3_code" is the documented default of the awm_backlog_create tool
  // contract; the MCP server always sends source explicitly, so this fallback
  // serves bare HTTP callers only.
  const source = optionalString(input?.source) ?? "t3_code";
  const createdBy = optionalString(input?.createdBy) ?? "bmad-agent";

  await ensureSchema();

  for (let attempt = 0; attempt < ID_RACE_ATTEMPTS; attempt++) {
    // A fresh client per attempt: after a 23505 the previous transaction is
    // aborted, and the winner's row only becomes visible once it has committed.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = explicitId ?? (await nextSequentialId(client, "bmad_backlogs", projectId, "BKL"));
      const inserted = await client.query<BacklogRow>(
        `INSERT INTO bmad_backlogs (id, project_id, title, raw_description, source, created_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft')
         RETURNING *`,
        [id, projectId, title, rawDescription, source, createdBy]
      );
      await client.query("COMMIT");
      return toBacklogItem(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // The insert's only FK is project_id → bmad_projects, so a 23503 here
      // means the caller's project id is stale. A clean 404 beats a 500
      // carrying the raw Postgres message — and it is never a race, so it is
      // not retried.
      if (isForeignKeyViolation(error)) {
        throw new BacklogError(404, `Project ${projectId} not found`);
      }
      if (!isUniqueViolation(error)) throw error;
      // A GENERATED id losing a race is retried with a fresh MAX+1 read; an
      // EXPLICIT one means the row already exists — that is a conflict, not a
      // race, and must never be retried into a silent second create.
      if (explicitId) {
        throw new BacklogError(409, `Backlog ${explicitId} already exists in project ${projectId}`);
      }
    } finally {
      client.release();
    }
  }
  throw new Error("Could not create the backlog: concurrent creates kept winning the id race");
}

/** Statuses the list filter accepts — the lifecycle the routes actually write. */
const BACKLOG_STATUSES = ["draft", "analyzing", "analyzed", "promoted"] as const;

/**
 * All backlogs of one project, oldest first. An unknown project is simply an
 * empty list — the caller asked a question whose answer is "nothing yet". An
 * unknown status filter is NOT: a typo answering 200 [] would be
 * indistinguishable from an empty board, so it is a 400 like every other
 * enum-shaped input (riskLevel, targetStage).
 */
export async function getBMadBacklogs(
  projectId: string,
  status?: string
): Promise<BacklogItem[]> {
  const filter = optionalString(status);
  if (filter && !(BACKLOG_STATUSES as readonly string[]).includes(filter)) {
    throw new BacklogError(400, `status must be one of: ${BACKLOG_STATUSES.join(", ")}`);
  }
  await ensureSchema();
  const res = await query<BacklogRow>(
    `SELECT * FROM bmad_backlogs
      WHERE project_id = $1${filter ? " AND status = $2" : ""}
      ORDER BY created_at ASC, id ASC`,
    filter ? [projectId, filter] : [projectId]
  );
  return res.rows.map(toBacklogItem);
}

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/**
 * Attach an impact analysis verbatim and move the backlog to `analyzed`.
 * `riskLevel` is the one field validated — it is the promote gate's input.
 * A promoted backlog refuses further analysis (409): its task already exists
 * and re-analysing underneath it would change what was promoted.
 */
export async function reportBacklogImpact(
  projectId: string,
  backlogId: string,
  analysis: unknown
): Promise<BacklogItem> {
  const riskLevel =
    typeof analysis === "object" && analysis !== null
      ? (analysis as { riskLevel?: unknown }).riskLevel
      : undefined;
  if (typeof riskLevel !== "string" || !(RISK_LEVELS as readonly string[]).includes(riskLevel)) {
    throw new BacklogError(400, `riskLevel must be one of: ${RISK_LEVELS.join(", ")}`);
  }

  await ensureSchema();

  // The promoted-guard rides the UPDATE itself, so a promote landing between
  // check and write cannot be overwritten: zero rows means absent or promoted,
  // distinguished by the read after.
  const updated = await query<BacklogRow>(
    `UPDATE bmad_backlogs
        SET impact_analysis = $3::jsonb, status = 'analyzed', updated_at = now()
      WHERE project_id = $1 AND id = $2 AND status <> 'promoted'
      RETURNING *`,
    [projectId, backlogId, JSON.stringify(analysis)]
  );
  if (updated.rows[0]) return toBacklogItem(updated.rows[0]);

  const existing = await query<{ status: string }>(
    `SELECT status FROM bmad_backlogs WHERE project_id = $1 AND id = $2`,
    [projectId, backlogId]
  );
  if (!existing.rows[0]) {
    throw new BacklogError(404, `Backlog ${backlogId} not found in project ${projectId}`);
  }
  throw new BacklogError(
    409,
    `Backlog ${backlogId} in project ${projectId} has already been promoted — impact analysis can no longer be reported`
  );
}

const PROMOTABLE_STAGES = ["backlog", "analysis", "ready_for_review"] as const;

export interface PromoteBacklogInput {
  targetStage?: string;
  /** Who promoted; the Go client sends no such field today, hence the default. */
  promotedBy?: string;
}

export interface PromotedBacklog {
  task: BMadTaskItem;
  /** False for the promote that created the task; true for an idempotent repeat. */
  alreadyPromoted: boolean;
}

/**
 * Raise an `analyzed` backlog to a Kanban task, as ONE transaction on ONE
 * client: the task INSERT and the backlog UPDATE commit together or not at
 * all, so `status='promoted'` can never exist without its task.
 *
 * Idempotent by the row lock: `SELECT ... FOR UPDATE` serialises concurrent
 * promotes of the same backlog, and the loser then sees the winner's committed
 * `promoted` row and answers with the SAME task instead of a second one.
 * Anything but `analyzed` is refused (409) — the MCP flow's impact-report step
 * is enforced server-side, not trusted from the client.
 *
 * `suggestedChecklists` from the analysis are deliberately NOT copied into the
 * task's `checklists`: the shapes differ (`estimatedEffort` vs `completed`)
 * and copying would be a product decision the story does not make.
 */
export async function promoteBacklogToTask(
  projectId: string,
  backlogId: string,
  input: PromoteBacklogInput = {}
): Promise<PromotedBacklog> {
  const targetStage = optionalString(input?.targetStage) ?? "ready_for_review";
  if (!(PROMOTABLE_STAGES as readonly string[]).includes(targetStage)) {
    throw new BacklogError(400, `targetStage must be one of: ${PROMOTABLE_STAGES.join(", ")}`);
  }
  const promotedBy = optionalString(input?.promotedBy) ?? "bmad-agent";

  await ensureSchema();

  for (let attempt = 0; attempt < ID_RACE_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const backlog = await client.query<BacklogRow>(
        `SELECT * FROM bmad_backlogs WHERE project_id = $1 AND id = $2 FOR UPDATE`,
        [projectId, backlogId]
      );
      const row = backlog.rows[0];
      if (!row) {
        throw new BacklogError(404, `Backlog ${backlogId} not found in project ${projectId}`);
      }

      if (row.status === "promoted" && row.promoted_to_task_id) {
        const task = await client.query<TaskRow>(
          `SELECT * FROM bmad_tasks WHERE project_id = $1 AND id = $2`,
          [projectId, row.promoted_to_task_id]
        );
        if (!task.rows[0]) {
          // Unreachable while the v8 FK exists — kept so a damaged database
          // fails loudly instead of answering an empty task.
          throw new Error(
            `Backlog ${backlogId} points at task ${row.promoted_to_task_id}, which does not exist in project ${projectId}`
          );
        }
        await client.query("COMMIT");
        return { task: toTaskItem(task.rows[0]), alreadyPromoted: true };
      }

      if (row.status !== "analyzed") {
        throw new BacklogError(
          409,
          `Backlog ${backlogId} in project ${projectId} is "${row.status}" — impact analysis must be reported (POST /backlogs/${backlogId}/impact) before it can be promoted`
        );
      }

      const taskId = await nextSequentialId(client, "bmad_tasks", projectId, "TASK");
      const inserted = await client.query<TaskRow>(
        `INSERT INTO bmad_tasks
           (id, project_id, title, description, stage, priority, approval_status,
            assigned_agent, context_files, checklists, steps, duration)
         VALUES ($1, $2, $3, $4, $5, 'medium', 'pending', 'bmad-agent',
                 '[]'::jsonb, '[]'::jsonb, $6::jsonb, '0s')
         RETURNING *`,
        [
          taskId,
          projectId,
          row.title,
          row.raw_description,
          targetStage,
          JSON.stringify([{ text: `Dipromosikan dari backlog ${backlogId}`, time: "now" }]),
        ]
      );
      const updatedBacklog = await client.query(
        `UPDATE bmad_backlogs
            SET status = 'promoted', promoted_to_task_id = $3, promoted_by = $4,
                promoted_at = now(), updated_at = now()
          WHERE project_id = $1 AND id = $2`,
        [projectId, backlogId, taskId, promotedBy]
      );
      if (updatedBacklog.rowCount !== 1) {
        throw new Error(`Backlog ${backlogId} vanished mid-promote`);
      }

      await client.query("COMMIT");
      return { task: toTaskItem(inserted.rows[0]), alreadyPromoted: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // Only a generated TASK id losing a same-project race (another backlog
      // promoted concurrently picked the same number) restarts the loop with a
      // fresh MAX+1; every other failure — 404, 409, FK — is real and propagates.
      if (!isUniqueViolation(error)) throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("Could not promote the backlog: concurrent promotes kept winning the task id race");
}

/**
 * The catch-block mapping every backlog route shares: a BacklogError answers
 * with its own status (Response.json for the same edge-safety guardBmadApi
 * already has), anything else is a 500 carrying the message — the same body
 * shape the other BMad routes return.
 */
export function backlogErrorResponse(error: unknown): Response {
  if (error instanceof BacklogError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Internal server error";
  return Response.json({ error: message }, { status: 500 });
}
