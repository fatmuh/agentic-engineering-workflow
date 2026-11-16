import { NextResponse } from "next/server";
import { guardBmadApi } from "@/lib/oauth";
import { backlogErrorResponse, createBMadBacklog, getBMadBacklogs } from "@/lib/backlogs";

/** GET /api/projects/:projectId/backlogs[?status=] — the awm_backlog_list tool. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId } = await params;
    const status = new URL(req.url).searchParams.get("status") ?? undefined;
    return NextResponse.json(await getBMadBacklogs(projectId, status));
  } catch (err: unknown) {
    return backlogErrorResponse(err);
  }
}

/** POST /api/projects/:projectId/backlogs — the awm_backlog_create tool. The
 *  Go client marshals its whole BacklogItem struct (empty-string id, its own
 *  "draft" status); the lib treats empties as absent and forces draft. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId } = await params;
    // .catch(() => null): an empty/malformed body must reach the lib's own
    // validation as "absent" (400 title), not die in the parser as a 500 —
    // same pattern as /api/projects/resolve.
    const item = await createBMadBacklog(projectId, await req.json().catch(() => null));
    return NextResponse.json(item, { status: 201 });
  } catch (err: unknown) {
    return backlogErrorResponse(err);
  }
}
