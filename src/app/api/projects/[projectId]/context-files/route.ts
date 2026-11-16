import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { BMadContextFileRef } from "@/lib/bmad";
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
    const files: BMadContextFileRef[] = Array.isArray(body) ? body : [body];

    for (const f of files) {
      await query(
        `INSERT INTO bmad_context_files (project_id, path, description, file_size_bytes, last_modified)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          projectId,
          f.path,
          f.description || "",
          f.fileSizeBytes || 0,
          f.lastModified ? new Date(f.lastModified) : new Date(),
        ]
      );
    }

    return NextResponse.json({ success: true, count: files.length }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
