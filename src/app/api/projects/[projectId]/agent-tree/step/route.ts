import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { BMadAgentTreeNode } from "@/lib/bmad";
import { guardBmadApi } from "@/lib/oauth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId } = await params;
    const node: Partial<BMadAgentTreeNode> = await req.json();

    const id = node.id || `node-${Date.now().toString(36)}`;
    const parentId = node.parentId || null;
    const taskId = node.taskId || null;
    const name = node.name || "BMad Agent";
    const role = node.role || "orchestrator";
    const status = node.status || "running";
    const action = node.action || "";
    const durationMs = node.durationMs || 0;
    const tokenUsage = node.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const modelUsed = node.modelUsed || { provider: "Anthropic", modelId: "claude-sonnet-5-5" };
    const artifacts = node.artifacts || [];
    const tools = node.tools || ["github"];
    const errorDetail = node.errorDetail || null;

    // Task and parent are composite FKs scoped to this project, so a reference
    // the caller sends is only writable if it exists HERE. Checking up front
    // turns what would be a raw FK violation (a 500 carrying the Postgres
    // message) into a 400 that names the offending field.
    if (taskId) {
      const task = await query(
        `SELECT 1 FROM bmad_tasks WHERE project_id = $1 AND id = $2`,
        [projectId, taskId]
      );
      if (task.rows.length === 0) {
        return NextResponse.json(
          { error: `Task ${taskId} does not exist in project ${projectId}` },
          { status: 400 }
        );
      }
    }
    if (parentId) {
      const parent = await query(
        `SELECT 1 FROM bmad_agent_nodes WHERE project_id = $1 AND id = $2`,
        [projectId, parentId]
      );
      if (parent.rows.length === 0) {
        return NextResponse.json(
          { error: `Parent node ${parentId} does not exist in project ${projectId}` },
          { status: 400 }
        );
      }
    }

    const res = await query(
      `INSERT INTO bmad_agent_nodes
        (id, project_id, task_id, parent_id, name, role, status, action, duration_ms, token_usage, model_used, artifacts, tools, error_detail, timestamp)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, now())
       ON CONFLICT (project_id, id) DO UPDATE SET
        task_id = COALESCE(EXCLUDED.task_id, bmad_agent_nodes.task_id),
        parent_id = COALESCE(EXCLUDED.parent_id, bmad_agent_nodes.parent_id),
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        action = EXCLUDED.action,
        duration_ms = EXCLUDED.duration_ms,
        token_usage = EXCLUDED.token_usage,
        model_used = EXCLUDED.model_used,
        artifacts = EXCLUDED.artifacts,
        tools = EXCLUDED.tools,
        error_detail = EXCLUDED.error_detail,
        timestamp = now()
       RETURNING *`,
      [
        id,
        projectId,
        taskId,
        parentId,
        name,
        role,
        status,
        action,
        durationMs,
        JSON.stringify(tokenUsage),
        JSON.stringify(modelUsed),
        JSON.stringify(artifacts),
        JSON.stringify(tools),
        errorDetail,
      ]
    );

    return NextResponse.json(res.rows[0], { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
