import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  api,
  closeDbPool,
  FIXTURE_EMAILS,
  FIXTURE_PASSWORD,
  getPool,
  login,
  seedFixtureUsers,
  type ApiResult,
} from "./helpers";

/**
 * Workspace identity regression matrix (spec-bmad-hardening story 3) — one test
 * per row of the story's I/O matrix, plus the acceptance criteria that need
 * database-level proof (no new row on a rejection, row counts unchanged, the
 * legacy key still resolving).
 *
 * Two rules are pinned here:
 *
 *   1. D-4 case-fold — a workspace path keys case-insensitively, in the column,
 *      in `uq_bmad_projects_workspace`, and in the resolver. A row written by an
 *      older release keeps working through the read-only legacy-key fallback.
 *   2. D-5 no credentials — a remote carrying `user:token@` is a 400 on both
 *      input endpoints and never becomes a row; a row that already holds one
 *      keeps matching but never returns its userinfo.
 *
 * Same harness as bmad-scoping/bmad-backlog: real HTTP through api() against
 * the booted app, getPool() only for what HTTP cannot prove. Fixtures carry the
 * name prefix below and are cleaned up by it — nothing depends on `prj_default`
 * or on the dev database.
 */

const FIXTURE_NAME_PREFIX = "Matrix BMad Identity";

let cookie: string;

interface ProjectBody {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  workspacePath: string | null;
  created?: boolean;
}

/** Assert the status first: a 500 body is an error object, and reading it as a
 *  project would surface as a TypeError instead of the behaviour that broke. */
function expectStatus(response: ApiResult, status: number): ApiResult {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

function fixtureName(label: string): string {
  return `${FIXTURE_NAME_PREFIX} ${label}`;
}

async function createProject(body: Record<string, unknown>): Promise<ProjectBody> {
  const response = expectStatus(
    await api("/api/projects", { method: "POST", cookie, body }),
    201,
  );
  return response.body as ProjectBody;
}

async function projectCount(): Promise<number> {
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM bmad_projects`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** The stored row as pg returns it — the column itself, not the response shape. */
async function storedProject(id: string) {
  const { rows } = await getPool().query<{
    git_remote_url: string | null;
    workspace_path: string | null;
  }>(
    `SELECT git_remote_url, workspace_path FROM bmad_projects WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * Run `body` with DATABASE_URL pointed at the scratch database, then restore.
 *
 * db.ts binds DATABASE_URL at import time, so a replay of `ensureSchema()`
 * must swap it BEFORE the dynamic import. Restoring by assignment would store
 * the literal string "undefined" when the variable was never set — deleting the
 * key is the only faithful restore.
 */
async function withScratchDatabaseUrl<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.MATRIX_DB_URL;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous;
    }
  }
}

beforeAll(async () => {
  await seedFixtureUsers();
  cookie = await login(FIXTURE_EMAILS.admin, FIXTURE_PASSWORD);
});

afterAll(async () => {
  const pool = getPool();
  try {
    // Tasks and agent nodes cascade from the project; this file writes neither.
    await pool.query(`DELETE FROM bmad_projects WHERE name LIKE $1`, [`${FIXTURE_NAME_PREFIX}%`]);
  } finally {
    await closeDbPool();
  }
});

// --- D-4: case-folded workspace identity ------------------------------------

test("create stores the workspace path lowercased, and the response agrees with the column", async () => {
  const created = await createProject({
    name: fixtureName("Case Fold Create"),
    workspacePath: "/TMP/Matrix-BMad-Identity-Case-Fold/Proj",
  });

  // Lowercase is the stored form — not merely a match rule the resolver applies
  // on read. A stored mixed-case path would occupy a key the folded SQL cannot
  // reach, which is the duplicate-project bug this rule exists to prevent.
  expect(created.workspacePath).toBe("/tmp/matrix-bmad-identity-case-fold/proj");
  expect(await storedProject(created.id)).toEqual({
    git_remote_url: null,
    workspace_path: "/tmp/matrix-bmad-identity-case-fold/proj",
  });
});

test("resolve with different casing finds the same project and creates no row", async () => {
  const created = await createProject({
    name: fixtureName("Case Fold Resolve"),
    workspacePath: "/tmp/matrix-bmad-identity-case-resolve/Worktree",
  });
  const before = await projectCount();

  // Every casing must land on the one project: the exact stored value, all
  // upper case, and the mixed case the story's acceptance criterion names.
  for (const spelling of [
    "/tmp/matrix-bmad-identity-case-resolve/worktree",
    "/TMP/MATRIX-BMAD-IDENTITY-CASE-RESOLVE/WORKTREE",
    "/tmp/Matrix-BMad-Identity-Case-Resolve/Worktree/",
  ]) {
    const resolved = expectStatus(
      await api("/api/projects/resolve", {
        method: "POST",
        cookie,
        body: { name: "Nama lain", workspacePath: spelling },
      }),
      200,
    );
    expect(resolved.body).toMatchObject({ id: created.id, created: false });
  }
  expect(await projectCount()).toBe(before);
});

test("a second create that differs only by casing is a 409, not a second project", async () => {
  await createProject({
    name: fixtureName("Case Fold Duplicate Original"),
    workspacePath: "/tmp/matrix-bmad-identity-case-dupe/original",
  });
  const before = await projectCount();

  const conflict = expectStatus(
    await api("/api/projects", {
      method: "POST",
      cookie,
      body: {
        name: fixtureName("Case Fold Duplicate"),
        workspacePath: "/TMP/Matrix-BMad-Identity-Case-Dupe/Original",
      },
    }),
    409,
  );
  expect(conflict.body).toMatchObject({ conflict: "workspace path" });
  expect(await projectCount()).toBe(before);
});

test("legacy row with an unfolded path still resolves, without being rewritten", async () => {
  // Simulate a row written by a release older than D-4. The API cannot produce
  // one any more (it folds before storing), so it is inserted directly with a
  // mixed-case path.
  //
  // The mechanism is the folded comparison itself: NORMALIZED_WORKSPACE_SQL is
  // applied to the STORED value, so this row folds to the same key the request
  // produces. There is no separate legacy query — this test pins that the
  // folded path alone is sufficient, which is exactly what the resolver relies
  // on.
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
     VALUES ('prj_matrix_identity_legacy', $1, NULL, '/TMP/Matrix-BMad-Identity-Legacy/Heritage')
     RETURNING id`,
    [fixtureName("Case Fold Legacy")],
  );
  const legacyId = rows[0].id;
  const before = await projectCount();

  // The request uses a different casing again; the folded comparison on the
  // stored value is what makes it match.
  const resolved = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: {
        name: fixtureName("Case Fold Legacy Resolve"),
        workspacePath: "/tmp/Matrix-BMad-Identity-Legacy/heritage",
      },
    }),
    200,
  );
  expect(resolved.body).toMatchObject({ id: legacyId, created: false });
  expect(await projectCount()).toBe(before);

  // Read-only: a resolve never rewrites the legacy row (the spec forbids side
  // effects on old rows).
  expect((await storedProject(legacyId)).workspace_path).toBe(
    "/TMP/Matrix-BMad-Identity-Legacy/Heritage",
  );

  // A NEW workspace writes the folded key too, so reading old rows never
  // reintroduces unfolded writes.
  const fresh = await createProject({
    name: fixtureName("Case Fold Legacy Neighbour"),
    workspacePath: "/tmp/Matrix-BMad-Identity-Legacy/Neighbour",
  });
  expect(fresh.workspacePath).toBe("/tmp/matrix-bmad-identity-legacy/neighbour");
});

test("schema v9 is re-entrant: a replayed ensureSchema() migrates once, then changes nothing", async () => {
  // Same re-entrancy pattern as bmad-backlog: DATABASE_URL is swapped to the
  // scratch database BEFORE the dynamic import, because db.ts binds it at
  // import time. That is what makes importing @/lib/db here safe.
  //
  // An unfolded row inserted after boot makes the FIRST replay do real work
  // (fold it); the SECOND replay is the idempotence proof.
  const legacyId = (
    await getPool().query<{ id: string }>(
      `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
       VALUES ('prj_matrix_identity_reentrant', $1, NULL, '/TMP/Matrix-BMad-Identity-Reentrant/Once')
       RETURNING id`,
      [fixtureName("Case Fold Reentrant")],
    )
  ).rows[0].id;

  await withScratchDatabaseUrl(async () => {
    vi.resetModules();
    const first = await import("@/lib/db");
    await expect(first.ensureSchema()).resolves.toBeUndefined();
    const afterFirst = (await storedProject(legacyId)).workspace_path;
    // The replay really ran v9: the unfolded row is now folded.
    expect(afterFirst).toBe("/tmp/matrix-bmad-identity-reentrant/once");
    await first.pool.end();

    // A second, independent module instance proves the MIGRATION is idempotent
    // rather than merely memoised by `schemaReady`.
    vi.resetModules();
    const second = await import("@/lib/db");
    await expect(second.ensureSchema()).resolves.toBeUndefined();
    expect((await storedProject(legacyId)).workspace_path).toBe(afterFirst);
    await second.pool.end();
  });

  // The identity index is singular: a rebuild that never dropped would collide
  // on the name, one that dropped and failed would leave none.
  const { rows: indexes } = await getPool().query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'bmad_projects'
        AND indexname = 'uq_bmad_projects_workspace'`,
  );
  expect(indexes).toEqual([{ indexname: "uq_bmad_projects_workspace" }]);
});

test("the root path is preserved by the fold: '/' stays '/', and a replay changes nothing", async () => {
  // The fold's expression carries a root-preserving CASE arm. A copy that
  // dropped it would rewrite `/` to `''` — an unmatchable key — and would look
  // "still unfolded" on every boot, rebuilding the index forever.
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
     VALUES ('prj_matrix_identity_root', $1, NULL, '/')
     RETURNING id`,
    [fixtureName("Case Fold Root")],
  );
  const rootId = rows[0].id;

  await withScratchDatabaseUrl(async () => {
    vi.resetModules();
    const db = await import("@/lib/db");
    await expect(db.ensureSchema()).resolves.toBeUndefined();
    await db.pool.end();
  });
  expect((await storedProject(rootId)).workspace_path).toBe("/");

  // A second replay must do NOTHING. Proven by the row staying exactly `/` and
  // by the migration's own "still unfolded?" probe finding zero rows: a probe
  // that had lost the root arm would report this row as unfolded and rewrite
  // it to "" here.
  await withScratchDatabaseUrl(async () => {
    vi.resetModules();
    const db = await import("@/lib/db");
    await expect(db.ensureSchema()).resolves.toBeUndefined();
    await db.pool.end();
  });
  expect((await storedProject(rootId)).workspace_path).toBe("/");

  // And the root is a usable identity: a resolve keyed to `/` finds this row
  // rather than creating a second project for the same key.
  const resolved = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: { name: "akar", workspacePath: "/" },
    }),
    200,
  );
  expect(resolved.body).toMatchObject({ id: rootId, created: false });
});

// --- D-5: credentials are never stored --------------------------------------

test("schema v9 refuses to merge: two projects that fold to one key abort the boot and name both", async () => {
  // The pre-v9 world is reproducible: the v7-era index compared UNFOLDED paths,
  // so these two rows could coexist. The current (folded) index would reject
  // them, so the index is swapped back to v7's shape first — that is exactly the
  // state an upgraded database is in before its first v9 boot, and it is what
  // lets the pair be inserted at all.
  //
  // Cleanup and index restore live in `finally`: the pool is the SHARED scratch
  // database every later spec file runs against, so a failing assertion midway
  // must not leave the pre-D-4 index (or the colliding rows) behind.
  const pool = getPool();
  const COLLIDE_IDS = "('prj_matrix_identity_collide_a', 'prj_matrix_identity_collide_b')";

  try {
    await pool.query(`DROP INDEX IF EXISTS uq_bmad_projects_workspace`);
    await pool.query(`
      CREATE UNIQUE INDEX uq_bmad_projects_workspace ON bmad_projects ((
        CASE WHEN btrim(workspace_path) ~ '^/+$' THEN '/'
             ELSE regexp_replace(btrim(workspace_path), '/+$', '') END
      )) WHERE git_remote_url IS NULL AND workspace_path IS NOT NULL
    `);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path) VALUES
         ('prj_matrix_identity_collide_a', $1, NULL, '/tmp/Matrix-BMad-Identity-Collide/Work'),
         ('prj_matrix_identity_collide_b', $2, NULL, '/TMP/matrix-bmad-identity-collide/work')
       RETURNING id`,
      [fixtureName("Collide A"), fixtureName("Collide B")],
    );
    expect(rows).toHaveLength(2);

    const before = await pool.query<{ id: string; workspace_path: string }>(
      `SELECT id, workspace_path FROM bmad_projects WHERE id IN ${COLLIDE_IDS} ORDER BY id`,
    );

    await withScratchDatabaseUrl(async () => {
      vi.resetModules();
      const db = await import("@/lib/db");
      // Boot fails loudly rather than merging: the error names BOTH projects so
      // an operator can decide which one keeps the path.
      await expect(db.ensureSchema()).rejects.toThrow(
        /schema v9 cannot run[\s\S]*prj_matrix_identity_collide_a[\s\S]*prj_matrix_identity_collide_b/,
      );
      await db.pool.end();
    });

    // Nothing was merged, deleted, or rewritten: the failure is a rollback.
    expect(
      (
        await pool.query<{ id: string; workspace_path: string }>(
          `SELECT id, workspace_path FROM bmad_projects WHERE id IN ${COLLIDE_IDS} ORDER BY id`,
        )
      ).rows,
    ).toEqual(before.rows);
  } finally {
    // Remove the fixture rows, then replay the migration so the folded index
    // exists again for every later spec in this shared database.
    await pool.query(`DELETE FROM bmad_projects WHERE id IN ${COLLIDE_IDS}`);
    await withScratchDatabaseUrl(async () => {
      vi.resetModules();
      const db = await import("@/lib/db");
      await db.ensureSchema();
      await db.pool.end();
    });
  }

  const { rows: indexes } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'bmad_projects'
        AND indexname = 'uq_bmad_projects_workspace'`,
  );
  expect(indexes).toEqual([{ indexname: "uq_bmad_projects_workspace" }]);
});

test("a remote carrying a token is a 400 on create and resolve, and no row is written", async () => {
  const before = await projectCount();

  for (const endpoint of ["/api/projects", "/api/projects/resolve"]) {
    const rejected = expectStatus(
      await api(endpoint, {
        method: "POST",
        cookie,
        body: {
          name: fixtureName("Credential Rejected"),
          gitRemoteUrl: "https://user:token@github.com/fatmuh/matrix-bmad-hardening-credential.git",
        },
      }),
      400,
    );
    expect(rejected.body).toMatchObject({ error: expect.stringContaining("credentials") });
  }
  expect(await projectCount()).toBe(before);
});

test("the credential check trims all whitespace, so a tab-prefixed remote is still a 400", async () => {
  // The identity keys use the space-only btrim because they mirror PostgreSQL's
  // btrim; the credential check must NOT, or `"\thttps://user:token@host/r"`
  // would slip through here while the Go client (strings.TrimSpace) rejects it.
  const before = await projectCount();
  for (const endpoint of ["/api/projects", "/api/projects/resolve"]) {
    const rejected = expectStatus(
      await api(endpoint, {
        method: "POST",
        cookie,
        body: {
          name: fixtureName("Credential Tab"),
          gitRemoteUrl: "\thttps://user:token@github.com/fatmuh/matrix-bmad-hardening-tab.git",
        },
      }),
      400,
    );
    expect(rejected.body).toMatchObject({ error: expect.stringContaining("credentials") });
  }
  expect(await projectCount()).toBe(before);
});

test("a bare username is not a credential: ssh://git@ and scp-like remotes are accepted", async () => {
  const ssh = await createProject({
    name: fixtureName("Credential Ssh"),
    gitRemoteUrl: "ssh://git@github.com/fatmuh/matrix-bmad-hardening-ssh.git",
  });
  // The raw remote is stored as the display form; it simply carries no secret.
  expect(ssh.gitRemoteUrl).toBe("ssh://git@github.com/fatmuh/matrix-bmad-hardening-ssh.git");

  const scp = await createProject({
    name: fixtureName("Credential Scp"),
    gitRemoteUrl: "git@github.com:fatmuh/matrix-bmad-hardening-scp.git",
  });
  expect(scp.gitRemoteUrl).toBe("git@github.com:fatmuh/matrix-bmad-hardening-scp.git");
});

test("a legacy row whose remote has leading whitespace is redacted too, not served verbatim", async () => {
  // Redaction must operate on the trimmed value: an `^`-anchored match against
  // the untrimmed string would detect nothing and echo the secret back.
  const secret = "ghp_matrixleadingspacetoken123";
  const remote = `  https://x-access-token:${secret}@github.com/fatmuh/matrix-bmad-hardening-space.git`;
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
     VALUES ('prj_matrix_identity_space', $1, $2, NULL)
     RETURNING id`,
    [fixtureName("Credential Leading Space"), remote],
  );
  const spaceId = rows[0].id;

  const listing = expectStatus(await api("/api/projects", { cookie }), 200);
  const listed = (listing.body as ProjectBody[]).find((project) => project.id === spaceId);
  expect(listed?.gitRemoteUrl).toBe(
    "https://github.com/fatmuh/matrix-bmad-hardening-space.git",
  );
  expect(JSON.stringify(listing.body)).not.toContain(secret);

  const resolved = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: {
        name: "cocok",
        gitRemoteUrl: "https://github.com/fatmuh/matrix-bmad-hardening-space.git",
      },
    }),
    200,
  );
  expect(resolved.body).toMatchObject({ id: spaceId, created: false });
  expect(JSON.stringify(resolved.body)).not.toContain(secret);

  // The column itself is untouched (no automatic write to legacy rows).
  expect((await storedProject(spaceId)).git_remote_url).toBe(remote);
});

test("a legacy row holding a token is still matched, but its userinfo never reaches any response", async () => {
  // A row only an older release could have written: the current input path
  // rejects this remote, so it goes in directly. The exact secret string below
  // must be absent from every response body — that is the assertion.
  const secret = "ghp_matrixlegacytoken1234567890";
  const remote = `https://x-access-token:${secret}@github.com/fatmuh/matrix-bmad-hardening-legacy.git`;
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
     VALUES ('prj_matrix_identity_secret', $1, $2, NULL)
     RETURNING id`,
    [fixtureName("Credential Legacy"), remote],
  );
  const legacyId = rows[0].id;

  // 1. The listing must not leak it.
  const listing = expectStatus(await api("/api/projects", { cookie }), 200);
  const listed = (listing.body as ProjectBody[]).find((project) => project.id === legacyId);
  expect(listed).toBeDefined();
  expect(listed?.gitRemoteUrl).toBe("https://github.com/fatmuh/matrix-bmad-hardening-legacy.git");
  expect(JSON.stringify(listing.body)).not.toContain(secret);

  // 2. Resolve matches the row (its identity still works) and hides the token.
  const resolved = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: {
        name: "cocok",
        gitRemoteUrl: "https://github.com/fatmuh/matrix-bmad-hardening-legacy.git",
      },
    }),
    200,
  );
  expect(resolved.body).toMatchObject({ id: legacyId, created: false });
  expect(JSON.stringify(resolved.body)).not.toContain(secret);
  expect((resolved.body as ProjectBody).gitRemoteUrl).toBe(
    "https://github.com/fatmuh/matrix-bmad-hardening-legacy.git",
  );

  // 3. Reading never rewrote the row: the column still carries the original
  //    value (no automatic write to legacy rows), and the API is the only
  //    place the secret is removed.
  expect((await storedProject(legacyId)).git_remote_url).toBe(remote);
});
