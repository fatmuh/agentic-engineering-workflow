import { NextResponse } from "next/server";
import { getBMadTasks } from "@/lib/bmad";
import { guardBmadApi } from "@/lib/oauth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const { projectId } = await params;
    const tasks = await getBMadTasks(projectId);
    return NextResponse.json(tasks);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
