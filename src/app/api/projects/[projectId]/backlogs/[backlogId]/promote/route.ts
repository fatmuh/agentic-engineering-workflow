import { NextResponse } from "next/server";
import { guardBmadApi } from "@/lib/oauth";
import { backlogErrorResponse, promoteBacklogToTask } from "@/lib/backlogs";

/** POST /api/projects/:projectId/backlogs/:backlogId/promote — the
 *  awm_backlog_promote tool. Body is `{"targetStage": "..."}` (the Go client
 *  defaults it). Response is the promoted task as a KanbanTaskItem: 201 when
 *  this call created it, 200 when the promote was idempotent and the task
 *  already existed. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string; backlogId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId, backlogId } = await params;
    // .catch(() => null): a malformed body falls back to the default stage
    // instead of dying in the parser as a 500 — same pattern as
    // /api/projects/resolve.
    const { task, alreadyPromoted } = await promoteBacklogToTask(
      projectId,
      backlogId,
      await req.json().catch(() => null)
    );
    return NextResponse.json(task, { status: alreadyPromoted ? 200 : 201 });
  } catch (err: unknown) {
    return backlogErrorResponse(err);
  }
}
