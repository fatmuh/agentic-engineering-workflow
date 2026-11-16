import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { BMadTaskItem } from "@/lib/bmad";
import { guardBmadApi } from "@/lib/oauth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string; taskId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId, taskId } = await params;
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
      `SELECT * FROM bmad_tasks WHERE project_id = $1 AND id = $2`,
      [projectId, taskId]
    );

    if (res.rows.length === 0) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const r = res.rows[0];
    return NextResponse.json({
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ projectId: string; taskId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId, taskId } = await params;
    const body = await req.json();

    const existingRes = await query<{
      id: string;
      steps: BMadTaskItem["steps"];
      checklists: BMadTaskItem["checklists"];
      stage: BMadTaskItem["stage"];
      approval_status: BMadTaskItem["approvalStatus"];
    }>(
      `SELECT id, steps, checklists, stage, approval_status FROM bmad_tasks WHERE project_id = $1 AND id = $2`,
      [projectId, taskId]
    );

    if (existingRes.rows.length === 0) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const current = existingRes.rows[0];
    const newStage = body.stage ?? current.stage;
    const newApprovalStatus = body.approvalStatus ?? current.approval_status;
    const rejectionReason = body.rejectionReason !== undefined ? body.rejectionReason : null;
    const checklists = body.checklists ?? current.checklists;

    let steps = body.steps ?? current.steps;
    if (body.addStep && typeof body.addStep === "string") {
      steps = [...steps, { text: body.addStep, time: "now" }];
    } else if (newApprovalStatus === "approved" && current.approval_status !== "approved") {
      steps = [...steps, { text: "Disetujui oleh reviewer di Web Dashboard", time: "sekarang" }];
    } else if (newApprovalStatus === "rejected" && current.approval_status !== "rejected") {
      steps = [...steps, { text: `Ditolak oleh reviewer: ${rejectionReason || "tanpa catatan"}`, time: "sekarang" }];
    }

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
      `UPDATE bmad_tasks
       SET
         stage = $3,
         approval_status = $4,
         rejection_reason = $5,
         checklists = $6::jsonb,
         steps = $7::jsonb,
         updated_at = now()
       WHERE project_id = $1 AND id = $2
       RETURNING *`,
      [
        projectId,
        taskId,
        newStage,
        newApprovalStatus,
        rejectionReason,
        JSON.stringify(checklists),
        JSON.stringify(steps),
      ]
    );

    const r = res.rows[0];
    return NextResponse.json({
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
