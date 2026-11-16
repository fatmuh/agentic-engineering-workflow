import { NextResponse } from "next/server";
import { guardBmadApi } from "@/lib/oauth";
import {
  ProjectConflictError,
  ProjectIdentityError,
  getProjectById,
  resolveProject,
  type ResolvedProject,
} from "@/lib/projects";

/**
 * Get-or-create for a workspace (CAP-2). This is the path the CLI's
 * `awm_project_init` uses; `POST /api/projects` stays a pure create.
 *
 * Body: `{ name, gitRemoteUrl?, workspacePath?, projectId? }`.
 *
 * An explicit `projectId` wins with no resolution at all — that is the
 * compatibility path for callers that already know their project, and it
 * reads only: an unknown id is 404, never a create or an update.
 *
 * Otherwise at least one identity field must be present. Response: the
 * project fields plus `created`, so an idempotent caller can tell a fresh row
 * from a match.
 */
export async function POST(req: Request) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: "A JSON object body is required" },
        { status: 400 }
      );
    }

    const fields = body as Record<string, unknown>;
    for (const field of ["gitRemoteUrl", "workspacePath", "projectId"] as const) {
      const value = fields[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return NextResponse.json(
          { error: `${field} must be a string` },
          { status: 400 }
        );
      }
    }

    const projectId = typeof fields.projectId === "string" ? fields.projectId.trim() : "";
    if (projectId !== "") {
      const project = await getProjectById(projectId);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      return NextResponse.json({ ...project, created: false }, { status: 200 });
    }

    const name = typeof fields.name === "string" ? fields.name : "";
    if (name.trim() === "") {
      return NextResponse.json(
        { error: "A project name is required" },
        { status: 400 }
      );
    }
    const hasRemote =
      typeof fields.gitRemoteUrl === "string" && fields.gitRemoteUrl.trim() !== "";
    const hasPath =
      typeof fields.workspacePath === "string" && fields.workspacePath.trim() !== "";
    if (!hasRemote && !hasPath) {
      return NextResponse.json(
        { error: "A git remote URL or a workspace path is required" },
        { status: 400 }
      );
    }

    const resolved: ResolvedProject = await resolveProject({
      name,
      gitRemoteUrl: hasRemote ? (fields.gitRemoteUrl as string) : null,
      workspacePath: hasPath ? (fields.workspacePath as string) : null,
    });

    return NextResponse.json(
      { ...resolved.project, created: resolved.created },
      { status: resolved.created ? 201 : 200 }
    );
  } catch (err: unknown) {
    // Written for the caller. `ProjectConflictError` is reachable when a
    // manual insert in another session wins the index between this attempt's
    // SELECT and its INSERT; that is a race, not a server fault, so it keeps
    // its specific message at 409. Everything else is driver or runtime detail
    // and must not be echoed — log it, return a generic body.
    if (err instanceof ProjectIdentityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ProjectConflictError) {
      return NextResponse.json(
        { error: err.message, conflict: err.target },
        { status: 409 }
      );
    }
    console.error("POST /api/projects/resolve failed:", err);
    return NextResponse.json(
      { error: "Failed to resolve project" },
      { status: 500 }
    );
  }
}
