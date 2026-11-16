/**
 * Workspace → project resolution (CAP-2, identity-mapping.md).
 *
 * `POST /api/projects` stays a pure create; get-or-create lives here so that
 * every caller that only knows "which workspace am I in?" converges on one
 * project instead of inserting a new row each session.
 *
 * Matching order is the table in identity-mapping.md, not an OR of both keys:
 *
 *   1. normalised git remote equal          — works even when the workspace
 *                                             moved to another directory
 *   2. normalised path equal AND both sides  — a path that merely happens to
 *      have no remote                          match a remote-backed project
 *                                              must not claim it
 *   3. otherwise                             — create
 *
 * The comparison runs IN SQL, against the exact expressions the two partial
 * unique indexes are built from (`NORMALIZED_REMOTE_SQL` and
 * `NORMALIZED_WORKSPACE_SQL` in ./db). Normalising in TypeScript and comparing
 * a JS string in `WHERE` would be a second, drifting definition of equality:
 * `normalizeGitRemote`/`normalizeWorkspacePath` in ./project-identity exist for
 * the same key and are asserted equal to the SQL, but the queries below use the
 * SQL form so the guard and the lookup cannot disagree.
 *
 * Race safety is the unique index, not the SELECT: two parallel resolvers can
 * both miss, both insert, and the loser gets SQLSTATE 23505. That is caught,
 * the winner is read back, and both responses carry the same id.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ensureSchema,
  pool,
  query,
  NORMALIZED_REMOTE_SQL,
  NORMALIZED_WORKSPACE_SQL,
} from "./db";
import type { BMadProject } from "./bmad";
import {
  ProjectIdentityError,
  assertRemoteHasNoCredentials,
  normalizeGitRemote,
  normalizeWorkspacePath,
  redactRemoteCredentials,
} from "./project-identity";

/**
 * Raised by the normalisers in ./project-identity and by this module.
 * Re-exported so every caller in the API layer has one import site, while the
 * pure module stays free of `pg`.
 */
export { ProjectIdentityError };

/** A `bmad_projects` row as pg returns it. */
export interface ProjectRow {
  id: string;
  name: string;
  git_remote_url: string | null;
  workspace_path: string | null;
  owner_id: string | null;
  team_id: string | null;
  created_at: Date;
}

/** Input to {@link resolveProject}; both identity fields are optional but at
 *  least one must carry a usable value. */
export interface ResolveProjectInput {
  name: string;
  gitRemoteUrl?: string | null;
  workspacePath?: string | null;
}

export interface ResolvedProject {
  project: BMadProject;
  /** True only for the request that actually inserted the row. */
  created: boolean;
}

/**
 * A create collided with one of the identity indexes — another project already
 * owns this remote/path. Mapped to 409 by `POST /api/projects`.
 */
export class ProjectConflictError extends Error {
  readonly target: "git remote" | "workspace path";
  readonly value: string;

  constructor(target: "git remote" | "workspace path", value: string) {
    super(
      `A project already exists with this ${target} (${value}). ` +
        `Use POST /api/projects/resolve to get it.`
    );
    this.name = "ProjectConflictError";
    this.target = target;
    this.value = value;
  }
}

/** pg errors carry a SQLSTATE; 23505 is unique_violation. */
interface PgError {
  code?: string;
  constraint?: string;
}

function asPgError(error: unknown): PgError {
  return typeof error === "object" && error !== null ? (error as PgError) : {};
}

export function isUniqueViolation(error: unknown): boolean {
  return asPgError(error).code === "23505";
}

/** Index name → user-facing field, for turning a constraint hit into a message. */
const CONFLICT_TARGETS: Record<string, "git remote" | "workspace path"> = {
  uq_bmad_projects_remote: "git remote",
  uq_bmad_projects_workspace: "workspace path",
};

/**
 * Translate a unique-index violation on `bmad_projects` into the 409 error the
 * create route returns. Any other unique violation (a primary-key clash on a
 * concurrent `prj_` id, say) is not an identity conflict and returns null, so
 * the caller keeps treating it as a 500 instead of claiming the wrong cause.
 */
export function toProjectConflict(
  error: unknown,
  input: { gitRemoteUrl?: string | null; workspacePath?: string | null }
): ProjectConflictError | null {
  if (!isUniqueViolation(error)) return null;
  const target = CONFLICT_TARGETS[asPgError(error).constraint ?? ""];
  if (!target) return null;
  const value =
    (target === "git remote" ? input.gitRemoteUrl : input.workspacePath) ?? "";
  return new ProjectConflictError(target, value);
}

/** The project shape every endpoint returns (matches `BMadProject`). */
export function toProjectResponse(row: ProjectRow): BMadProject {
  return {
    id: row.id,
    name: row.name,
    // Filtered in the RESPONSE, never in the column (D-5): a row written by an
    // older release may still hold `https://user:token@host/repo`, and boot is
    // forbidden to rewrite it. Rewriting the column instead would make the
    // stored remote stop matching the identity the row was created with; the
    // response filter removes the secret while leaving the row intact.
    gitRemoteUrl:
      row.git_remote_url === null
        ? null
        : redactRemoteCredentials(row.git_remote_url),
    workspacePath: row.workspace_path,
    ownerId: row.owner_id,
    teamId: row.team_id,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Project ids are opaque `prj_*` strings. Timestamp-only ids collide when two
 * inserts land in the same millisecond (both resolvers of a race, or two
 * different workspaces in one burst), and a primary-key clash there would be
 * indistinguishable from a real identity conflict. Random material avoids it;
 * list ordering uses `created_at`, never the id.
 *
 * Exported so `POST /api/projects` uses the same generator — a create burst
 * must not 500 on a same-millisecond PK clash.
 */
export function newProjectId(): string {
  return `prj_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Which identity keys the request actually carries, after normalisation.
 *  `null` means "absent": an input that normalises to nothing (`"  "`,
 *  `".git"`) is not an identity and must not match every other empty key. */
interface IdentityKeys {
  remoteKey: string | null;
  workspaceKey: string | null;
}

/** What a request's identity becomes in the table, plus the keys it is
 *  matched by. One shape so `POST /api/projects` and `resolveProject` cannot
 *  store two different forms for the same workspace. */
export interface NormalizedProjectIdentity extends IdentityKeys {
  /** Stored `git_remote_url`: the caller's raw string (the display form),
   *  NULL when the value normalises to nothing — storing a degenerate remote
   *  would occupy an index slot no lookup can reach. The SQL expression
   *  normalises it on read, so raw and keyed forms agree.
   *
   *  Note the deliberate asymmetry with `workspacePath` below: the remote's
   *  SQL strips scheme/userinfo/port itself, the path's SQL only strips a
   *  trailing slash, so the path must already be normalised when stored. */
  gitRemoteUrl: string | null;
  /** Stored `workspace_path`: ALREADY normalised (`~` expanded, absolute,
   *  case-folded, no trailing slash) — see the note above. */
  workspacePath: string | null;
}

/**
 * Turn a request's optional identity fields into stored values + match keys.
 * Throws {@link ProjectIdentityError} for an identity that can never be
 * matched (non-ASCII remote, relative path) and for a remote that
 * carries credentials.
 *
 * The credential check deliberately runs on the RAW string, before
 * `normalizeGitRemote`: that normaliser strips userinfo, so a check on its
 * output could never see the token (D-5). A bare username (`ssh://git@host/x`,
 * `git@host:x`) is not a secret and is still accepted.
 *
 * Both normalisers treat `""` as absent; anything that normalises to an empty
 * string becomes `null` here so the identity indexes' empty slots stay empty.
 */
export function normalizeProjectIdentity(input: {
  gitRemoteUrl?: string | null;
  workspacePath?: string | null;
}): NormalizedProjectIdentity {
  const remote =
    typeof input.gitRemoteUrl === "string" ? input.gitRemoteUrl : "";
  const workspace =
    typeof input.workspacePath === "string" ? input.workspacePath : "";
  // Before anything else: normalisation would erase the evidence.
  assertRemoteHasNoCredentials(remote);
  const remoteKey = remote.trim() === "" ? "" : normalizeGitRemote(remote);
  const workspaceKey =
    workspace.trim() === "" ? "" : normalizeWorkspacePath(workspace);
  const hasRemote = remoteKey !== "";
  const hasWorkspace = workspaceKey !== "";
  return {
    remoteKey: hasRemote ? remoteKey : null,
    workspaceKey: hasWorkspace ? workspaceKey : null,
    gitRemoteUrl: hasRemote ? remote : null,
    workspacePath: hasWorkspace ? workspaceKey : null,
  };
}

/**
 * Rule 1 then rule 2, inside the caller's transaction. Uses the index
 * expressions so this lookup and `uq_bmad_projects_*` cannot diverge.
 *
 * Rule 2 needs ONLY the folded key (D-4 transition). The fold is applied to the
 * STORED value, so a row written before D-4 (`/Users/X/Proj`) folds to the same
 * key the request produces — one query reaches old and new rows alike. There is
 * deliberately no second, unfolded comparison: it could only ever match rows
 * this one already matched, and the round-trip was dead weight. What stays
 * true is the read-only half of the contract: nothing here writes, so an old
 * row is never rewritten and no second project is inserted for it.
 */
async function findProject(
  client: PoolClient,
  keys: IdentityKeys
): Promise<ProjectRow | null> {
  if (keys.remoteKey) {
    const byRemote = await client.query<ProjectRow>(
      `SELECT * FROM bmad_projects
        WHERE git_remote_url IS NOT NULL
          AND ${NORMALIZED_REMOTE_SQL} = $1
        LIMIT 1`,
      [keys.remoteKey]
    );
    if (byRemote.rows[0]) return byRemote.rows[0];
  }

  // Rule 2 only applies when THIS request has no remote: a remote-backed
  // workspace must never be adopted by a remote-less caller that happens to
  // share the directory (identity-mapping.md's reason for the two-sided test).
  if (!keys.remoteKey && keys.workspaceKey) {
    const byWorkspace = await client.query<ProjectRow>(
      `SELECT * FROM bmad_projects
        WHERE git_remote_url IS NULL
          AND workspace_path IS NOT NULL
          AND ${NORMALIZED_WORKSPACE_SQL} = $1
        LIMIT 1`,
      [keys.workspaceKey]
    );
    if (byWorkspace.rows[0]) return byWorkspace.rows[0];
  }

  return null;
}

/** How many read→insert rounds before giving up on a constantly-losing race. */
const RESOLVE_ATTEMPTS = 3;

/** True when `error` is a unique violation raised by one of the identity
 *  indexes — the only violation this loop is allowed to treat as "someone else
 *  won the race and I should read their row". */
function isProjectIdentityViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = CONFLICT_TARGETS[asPgError(error).constraint ?? ""];
  return target !== undefined;
}

/**
 * Get the project for this workspace, creating it only when none matches.
 *
 * `name` is used on insert and never applied to an existing row: renaming a
 * project is explicitly outside this capability, and silently overwriting the
 * name of someone else's workspace would be a write the caller never asked for.
 *
 * Each attempt is one transaction (`SELECT` and `INSERT` are a single logical
 * unit, per identity-mapping.md); the unique index — not the transaction — is
 * what makes two concurrent racers converge.
 */
export async function resolveProject(
  input: ResolveProjectInput
): Promise<ResolvedProject> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new ProjectIdentityError("A project name is required");
  }

  const identity = normalizeProjectIdentity(input);
  if (!identity.remoteKey && !identity.workspaceKey) {
    throw new ProjectIdentityError(
      "A git remote URL or a workspace path is required"
    );
  }

  await ensureSchema();

  // `keys` is the match set; the INSERT below takes only the two stored
  // columns, so neither is passed on by spreading `identity`.
  const { gitRemoteUrl, workspacePath } = identity;
  const keys: IdentityKeys = {
    remoteKey: identity.remoteKey,
    workspaceKey: identity.workspaceKey,
  };

  for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
    // A fresh client per attempt: after a 23505 the previous transaction is
    // aborted, and the winner's row only becomes visible once it has committed.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const existing = await findProject(client, keys);
      if (existing) {
        await client.query("COMMIT");
        return { project: toProjectResponse(existing), created: false };
      }

      const inserted = await client.query<ProjectRow>(
        `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [newProjectId(), name, gitRemoteUrl, workspacePath]
      );
      await client.query("COMMIT");
      return { project: toProjectResponse(inserted.rows[0]), created: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // Only an identity-index collision means "someone else won; read their
      // row on the next attempt". Any other failure — including a primary-key
      // clash on the generated id — is a real error and propagates, so this
      // loop can never mistake an unrelated violation for a resolvable race.
      if (!isProjectIdentityViolation(error)) throw error;
    } finally {
      client.release();
    }
  }

  // Three lost races in a row: read the winner once outside the loop rather
  // than inserting again. A miss here means the row was deleted in between —
  // report it instead of looping forever.
  const client = await pool.connect();
  try {
    const existing = await findProject(client, keys);
    if (existing) {
      return { project: toProjectResponse(existing), created: false };
    }
  } finally {
    client.release();
  }
  throw new Error(
    "Could not resolve the workspace: a concurrent create kept winning and the project could not be read back"
  );
}

/**
 * The explicit-`projectId` compatibility path (identity-mapping.md: "Pakai
 * langsung tanpa resolusi"). A caller that already knows which project it
 * means wins over any identity in the same request — no lookup by
 * remote/path, no create, and no write of any kind: an unknown id is `null`
 * so the route can answer 404 rather than silently making a new project.
 */
export async function getProjectById(
  projectId: string
): Promise<BMadProject | null> {
  await ensureSchema();
  const res = await query<ProjectRow>(
    `SELECT * FROM bmad_projects WHERE id = $1`,
    [projectId]
  );
  const row = res.rows[0];
  return row ? toProjectResponse(row) : null;
}
