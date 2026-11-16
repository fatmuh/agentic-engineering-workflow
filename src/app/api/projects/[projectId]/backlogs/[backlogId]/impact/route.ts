import { NextResponse } from "next/server";
import { guardBmadApi } from "@/lib/oauth";
import { backlogErrorResponse, reportBacklogImpact } from "@/lib/backlogs";

/** POST /api/projects/:projectId/backlogs/:backlogId/impact — the
 *  awm_backlog_report_impact tool. Body is the full CodeImpactAnalysis the Go
 *  client marshals; only riskLevel is validated, the rest is stored verbatim
 *  and the updated BacklogItem is returned. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string; backlogId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId, backlogId } = await params;
    // .catch(() => null): a malformed body must reach the riskLevel validation
    // as "absent" (400), not die in the parser as a 500 — same pattern as
    // /api/projects/resolve.
    const item = await reportBacklogImpact(projectId, backlogId, await req.json().catch(() => null));
    return NextResponse.json(item, { status: 200 });
  } catch (err: unknown) {
    return backlogErrorResponse(err);
  }
}
