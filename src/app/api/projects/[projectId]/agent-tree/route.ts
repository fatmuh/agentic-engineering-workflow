import { NextResponse } from "next/server";
import { getBMadAgentSessions, getBMadAgentTree } from "@/lib/bmad";
import { guardBmadApi } from "@/lib/oauth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId } = await params;
    // `?sessions=1` is the Worktree's shape: { sessions, selectedId, tree },
    // with `session=<root id>` choosing the tree. Without it the response stays
    // the bare tree (or null) that existing callers read.
    const url = new URL(req.url);
    if (url.searchParams.get("sessions") === "1") {
      return NextResponse.json(await getBMadAgentSessions(projectId, url.searchParams.get("session")));
    }
    const tree = await getBMadAgentTree(projectId);
    return NextResponse.json(tree);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
