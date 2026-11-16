import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { guardBmadApi } from "@/lib/oauth";
import {
  ProjectIdentityError,
  newProjectId,
  normalizeProjectIdentity,
  toProjectConflict,
  toProjectResponse,
} from "@/lib/projects";

export async function GET(req: Request) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    // Read-only on purpose: the demo seed is a startup concern
    // (`src/instrumentation.ts`), not a side effect of listing projects.
    const res = await query<{
      id: string;
      name: string;
      git_remote_url: string | null;
      workspace_path: string | null;
      owner_id: string | null;
      team_id: string | null;
      created_at: Date;
    }>(`SELECT * FROM bmad_projects ORDER BY created_at DESC`);

    // The shared mapper, so the userinfo filter (D-5) and every other field
    // shape live in one place rather than once per endpoint.
    const projects = res.rows.map(toProjectResponse);

    return NextResponse.json(projects);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const { name, gitRemoteUrl, workspacePath } = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  try {
    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    // A malformed field is a bad request, not a silent NULL: only strings (or
    // null/absent) are identities.
    for (const [field, value] of [
      ["gitRemoteUrl", gitRemoteUrl],
      ["workspacePath", workspacePath],
    ] as const) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        return NextResponse.json(
          { error: `${field} must be a string` },
          { status: 400 }
        );
      }
    }

    // Same helpers the resolver uses, so a row created here is stored in the
    // form a later resolve will match: normalised path (`~/x`, `/a//b` would
    // otherwise occupy a key nothing can reach) and NULL for a degenerate
    // remote (`" "`, `"https://"`) instead of an unmatchable index slot.
    const identity = normalizeProjectIdentity({
      gitRemoteUrl: typeof gitRemoteUrl === "string" ? gitRemoteUrl : null,
      workspacePath: typeof workspacePath === "string" ? workspacePath : null,
    });

    const res = await query<{
      id: string;
      name: string;
      git_remote_url: string | null;
      workspace_path: string | null;
      owner_id: string | null;
      team_id: string | null;
      created_at: Date;
    }>(
      `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [newProjectId(), name, identity.gitRemoteUrl, identity.workspacePath]
    );

    return NextResponse.json(toProjectResponse(res.rows[0]), { status: 201 });
  } catch (err: unknown) {
    // An identity the normaliser refuses (non-ASCII remote, relative path) is
    // the caller's mistake, same as on the resolve path.
    if (err instanceof ProjectIdentityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // A create that collides with uq_bmad_projects_remote/workspace is a
    // client-visible conflict, not a 500: name the remote/path that is already
    // taken and point at the get-or-create path.
    const conflict = toProjectConflict(err, {
      gitRemoteUrl: typeof gitRemoteUrl === "string" ? gitRemoteUrl : null,
      workspacePath: typeof workspacePath === "string" ? workspacePath : null,
    });
    if (conflict) {
      return NextResponse.json(
        { error: conflict.message, conflict: conflict.target },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
