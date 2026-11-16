import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { BMadTaskItem } from "@/lib/bmad";
import { guardBmadApi } from "@/lib/oauth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId } = await params;
    const body = await req.json();
    const tasks: Partial<BMadTaskItem>[] = Array.isArray(body) ? body : [body];

    const created: BMadTaskItem[] = [];

    for (const t of tasks) {
      // Random, not clock-based: concurrent batches landed in the same
      // millisecond, and the upsert below overwrote one task with another.
      // Ten characters never match nextSequentialId's `TASK-[0-9]{1,9}`.
      const id = t.id || `TASK-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
      const title = t.title || "Untitled Task";
      const description = t.description || "";
      const stage = t.stage || "ready_for_review";
      const priority = t.priority || "medium";
      const approvalStatus = t.approvalStatus || "pending";
      const assignedAgent = t.assignedAgent || "bmad-agent";
      const contextFiles = t.contextFiles || [];
      const checklists = t.checklists || [];
      const steps = t.steps || [{ text: "Task created by BMad agent", time: "now" }];
      const duration = t.duration || "0s";

      const res = await query<{
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
      }>(
        `INSERT INTO bmad_tasks
          (id, project_id, title, description, stage, priority, approval_status, assigned_agent, context_files, checklists, steps, duration)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
         ON CONFLICT (project_id, id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          stage = EXCLUDED.stage,
          priority = EXCLUDED.priority,
          approval_status = EXCLUDED.approval_status,
          assigned_agent = EXCLUDED.assigned_agent,
          context_files = EXCLUDED.context_files,
          checklists = EXCLUDED.checklists,
          updated_at = now()
         RETURNING *`,
        [
          id,
          projectId,
          title,
          description,
          stage,
          priority,
          approvalStatus,
          assignedAgent,
          JSON.stringify(contextFiles),
          JSON.stringify(checklists),
          JSON.stringify(steps),
          duration,
        ]
      );

      const r = res.rows[0];
      created.push({
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        description: r.description,
        stage: r.stage,
        priority: r.priority,
        approvalStatus: r.approval_status,
        assignedAgent: r.assigned_agent,
        rejectionReason: r.rejection_reason,
        contextFiles: r.context_files || [],
        checklists: r.checklists || [],
        steps: r.steps || [],
        sources: r.sources || 0,
        toolCalls: r.tool_calls || 0,
        duration: r.duration || "0s",
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      });
    }

    return NextResponse.json(created, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
