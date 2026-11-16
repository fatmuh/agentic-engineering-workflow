import { afterAll, beforeAll, expect, test } from "vitest";
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
 * BMad board scoping regression matrix (CAP-3, spec-bmad-hardening story 1).
 *
 * These five behaviours are the only things standing between two projects on
 * one database and silent cross-project data loss, and until this file existed
 * every one of them was verified by hand and then forgotten:
 *
 *   1. composite `(project_id, id)` keys          — same task id, two projects
 *   2. ON DELETE CASCADE on node.task_id          — deleting a task takes its nodes
 *   3. duplicate-identity rejection               — POST /api/projects 409s on
 *                                                   both the remote and path index
 *   4. get-or-create identity resolution          — /resolve matches, never adopts
 *   5. board isolation                            — list/tree never cross projects
 *
 * Everything runs over the harness the other matrix specs use: real HTTP
 * through api() against the booted app, and getPool() for the catalog and row
 * assertions that HTTP cannot reach. The pool is bound to the scratch database
 * (MATRIX_DB_URL), never the dev database.
 *
 * Every fixture is a project this file owns — nothing here depends on the
 * `prj_default` demo seed, so changing that seed cannot make this file fail
 * away from its cause. Cleanup runs by fixture name, which is independent of
 * which identity column a fixture happened to use.
 */

/** Every project this file creates carries this name prefix, and only then
 *  is it cleaned up — `prj_default`'s name does not match. */
const FIXTURE_NAME_PREFIX = "Matrix BMad Scoping";

let cookie: string;

interface ProjectBody {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  workspacePath: string | null;
  created?: boolean;
}

/** Assert the status first: a 500 body is an error object, and reading it as a
 *  list would surface as a TypeError instead of the behaviour that broke. */
function expectStatus(response: ApiResult, status: number): ApiResult {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

async function createProject(body: Record<string, unknown>): Promise<ProjectBody> {
  const response = expectStatus(
    await api("/api/projects", { method: "POST", cookie, body }),
    201,
  );
  return response.body as ProjectBody;
}

function fixtureName(label: string): string {
  return `${FIXTURE_NAME_PREFIX} ${label}`;
}

async function projectCount(): Promise<number> {
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM bmad_projects`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Primary-key columns, in key order — the shape v7 installs. */
async function primaryKeyColumns(table: string): Promise<string[]> {
  const { rows } = await getPool().query<{ column_name: string }>(
    `SELECT a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_attribute a
         ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = $1::regclass AND c.contype = 'p'
      ORDER BY array_position(c.conkey, a.attnum)`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

beforeAll(async () => {
  await seedFixtureUsers();
  cookie = await login(FIXTURE_EMAILS.admin, FIXTURE_PASSWORD);
});

afterAll(async () => {
  const pool = getPool();
  try {
    // Tasks and agent nodes cascade from the project, so one delete cleans all
    // three tables. Keyed by fixture name: a remote-only fixture never wrote a
    // workspace_path, and deleting by that column would leak it — and its slot
    // in `uq_bmad_projects_remote` — into the next run.
    await pool.query(`DELETE FROM bmad_projects WHERE name LIKE $1`, [`${FIXTURE_NAME_PREFIX}%`]);
  } finally {
    await closeDbPool();
  }
});

test("composite key: the same task id lives independently in two projects", async () => {
  // TASK-101 is deliberately NOT used: `bmad.ts` seeds it into `prj_default`,
  // and a shared id would make the row-count assertion depend on that seed.
  const projectA = await createProject({
    name: fixtureName("Composite A"),
    workspacePath: "/tmp/matrix-bmad-scoping-composite-a",
  });
  const projectB = await createProject({
    name: fixtureName("Composite B"),
    workspacePath: "/tmp/matrix-bmad-scoping-composite-b",
  });

  const writeTask = (projectId: string, title: string) =>
    api(`/api/projects/${projectId}/tasks/batch`, {
      method: "POST",
      cookie,
      body: [{ id: "MX-COMPOSITE-1", title, description: "matrix fixture" }],
    });

  expectStatus(await writeTask(projectA.id, "Judul milik A"), 201);
  expectStatus(await writeTask(projectB.id, "Judul milik B"), 201);

  const { rows } = await getPool().query<{ project_id: string; title: string }>(
    `SELECT project_id, title FROM bmad_tasks WHERE id = 'MX-COMPOSITE-1' ORDER BY project_id`,
  );
  expect(rows).toHaveLength(2);
  const byProject = new Map(rows.map((row) => [row.project_id, row.title]));
  // The second write must not have clobbered the first project's row — that is
  // exactly what a global `ON CONFLICT (id)` did before v7.
  expect(byProject.get(projectA.id)).toBe("Judul milik A");
  expect(byProject.get(projectB.id)).toBe("Judul milik B");

  // The behaviour a user sees, not only the row: the read API must agree.
  const listA = expectStatus(await api(`/api/projects/${projectA.id}/tasks`, { cookie }), 200);
  const listB = expectStatus(await api(`/api/projects/${projectB.id}/tasks`, { cookie }), 200);
  expect((listA.body as { title: string }[])[0]?.title).toBe("Judul milik A");
  expect((listB.body as { title: string }[])[0]?.title).toBe("Judul milik B");

  // And the key itself is composite on every table v7 rewrites, so a partial
  // migration — one table left on the global key — cannot pass.
  for (const table of ["bmad_tasks", "bmad_agent_nodes", "bmad_backlogs"]) {
    expect(await primaryKeyColumns(table), table).toEqual(["project_id", "id"]);
  }
});

test("batch: tasks sent without an id each get their own row", async () => {
  const project = await createProject({
    name: fixtureName("Batch Ids"),
    workspacePath: "/tmp/matrix-bmad-scoping-batch-ids",
  });
  // The MCP client sends tasks without ids and lets the server assign them,
  // and several agents can post at once. An id built from the clock alone
  // repeats within one millisecond, and the upsert then overwrites the earlier
  // task with the later one, while both requests answer 201.
  const titles = Array.from({ length: 20 }, (_, i) => `Batch task ${i + 1}`);
  const responses = await Promise.all(
    titles.map((title) =>
      api(`/api/projects/${project.id}/tasks/batch`, { method: "POST", cookie, body: [{ title }] }),
    ),
  );
  const ids = responses.map((response) => (expectStatus(response, 201).body as { id: string }[])[0]?.id);

  expect(new Set(ids).size).toBe(titles.length);
  const list = expectStatus(await api(`/api/projects/${project.id}/tasks`, { cookie }), 200)
    .body as { title: string }[];
  expect(list.map((task) => task.title).sort()).toEqual([...titles].sort());
});

test("cascade: deleting a task deletes its own project's nodes and nobody else's", async () => {
  const projectA = await createProject({
    name: fixtureName("Cascade A"),
    workspacePath: "/tmp/matrix-bmad-scoping-cascade-a",
  });
  const projectB = await createProject({
    name: fixtureName("Cascade B"),
    workspacePath: "/tmp/matrix-bmad-scoping-cascade-b",
  });

  for (const [projectId, nodeId] of [
    [projectA.id, "MX-CASCADE-NODE-A"],
    [projectB.id, "MX-CASCADE-NODE-B"],
  ] as const) {
    expectStatus(
      await api(`/api/projects/${projectId}/tasks/batch`, {
        method: "POST",
        cookie,
        body: [{ id: "MX-CASCADE-1", title: "Task untuk cascade" }],
      }),
      201,
    );
    const node = expectStatus(
      await api(`/api/projects/${projectId}/agent-tree/step`, {
        method: "POST",
        cookie,
        body: { id: nodeId, taskId: "MX-CASCADE-1", name: `Node ${nodeId}` },
      }),
      200,
    );
    // The link the cascade depends on, asserted where it is created rather
    // than assumed by the delete below.
    expect(node.body).toMatchObject({ id: nodeId, project_id: projectId, task_id: "MX-CASCADE-1" });
  }

  // Behaviour first: deleting A's task must take A's node and leave B's alive.
  await getPool().query(`DELETE FROM bmad_tasks WHERE project_id = $1 AND id = 'MX-CASCADE-1'`, [
    projectA.id,
  ]);

  const { rows } = await getPool().query<{ project_id: string; id: string }>(
    `SELECT project_id, id FROM bmad_agent_nodes
      WHERE id IN ('MX-CASCADE-NODE-A', 'MX-CASCADE-NODE-B')
      ORDER BY id`,
  );
  expect(rows).toEqual([{ project_id: projectB.id, id: "MX-CASCADE-NODE-B" }]);

  // Then the shape, read straight from the catalog: this is the pin that names
  // the rule and the referenced table, not merely "some FK on task_id".
  const { rows: fkRows } = await getPool().query<{ confdeltype: string }>(
    `SELECT c.confdeltype
       FROM pg_constraint c
      WHERE c.conrelid = 'bmad_agent_nodes'::regclass
        AND c.confrelid = 'bmad_tasks'::regclass
        AND c.contype = 'f'
        AND c.confdeltype = 'c'
        AND array_length(c.conkey, 1) = 2
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.conrelid
             AND a.attnum = ANY (c.conkey)
             AND a.attname = 'task_id'
        )`,
  );
  expect(fkRows).toHaveLength(1);
});

test("agent-tree/step rejects a task that belongs to another project", async () => {
  const projectA = await createProject({
    name: fixtureName("Step Guard A"),
    workspacePath: "/tmp/matrix-bmad-scoping-step-a",
  });
  const projectB = await createProject({
    name: fixtureName("Step Guard B"),
    workspacePath: "/tmp/matrix-bmad-scoping-step-b",
  });

  expectStatus(
    await api(`/api/projects/${projectB.id}/tasks/batch`, {
      method: "POST",
      cookie,
      body: [{ id: "MX-STEP-1", title: "Milik B" }],
    }),
    201,
  );

  // A 400 naming the field, not a raw composite-FK 500 — the pre-check in the
  // route is what makes this reachable, and this is its only pin.
  const crossProject = expectStatus(
    await api(`/api/projects/${projectA.id}/agent-tree/step`, {
      method: "POST",
      cookie,
      body: { id: "MX-STEP-NODE-A", taskId: "MX-STEP-1", name: "Node lintas project" },
    }),
    400,
  );
  expect(crossProject.body).toMatchObject({ error: expect.stringContaining("MX-STEP-1") });
});

test("duplicate remote: a second project for the same remote is rejected", async () => {
  const original = await createProject({
    name: fixtureName("Remote Original"),
    gitRemoteUrl: "git@github.com:fatmuh/matrix-bmad-hardening-remote.git",
  });
  const before = await projectCount();

  // Same identity, different spelling: scheme, userinfo and `.git` may differ.
  for (const spelling of [
    "https://github.com/fatmuh/matrix-bmad-hardening-remote",
    "https://github.com/fatmuh/matrix-bmad-hardening-remote.git",
    "ssh://git@github.com/fatmuh/matrix-bmad-hardening-remote.git",
  ]) {
    const response = expectStatus(
      await api("/api/projects", {
        method: "POST",
        cookie,
        body: { name: fixtureName("Remote Duplikat"), gitRemoteUrl: spelling },
      }),
      409,
    );
    expect(response.body).toMatchObject({ conflict: "git remote" });
  }
  expect(await projectCount()).toBe(before);

  // The existing project is still reachable, unchanged.
  const resolve = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: { name: "x", gitRemoteUrl: "https://github.com/fatmuh/matrix-bmad-hardening-remote" },
    }),
    200,
  );
  expect(resolve.body).toMatchObject({ id: original.id, created: false });
});

test("duplicate workspace path: a second remote-less project for the same path is rejected", async () => {
  await createProject({
    name: fixtureName("Path Original"),
    workspacePath: "/tmp/matrix-bmad-scoping-path-original",
  });
  const before = await projectCount();

  // `uq_bmad_projects_workspace` is the other half of the identity contract;
  // the trailing slash makes this a normalisation case, not just a literal one.
  for (const spelling of [
    "/tmp/matrix-bmad-scoping-path-original",
    "/tmp/matrix-bmad-scoping-path-original/",
  ]) {
    const response = expectStatus(
      await api("/api/projects", {
        method: "POST",
        cookie,
        body: { name: fixtureName("Path Duplikat"), workspacePath: spelling },
      }),
      409,
    );
    expect(response.body).toMatchObject({ conflict: "workspace path" });
  }
  expect(await projectCount()).toBe(before);
});

test("identity resolution: get-or-create matches, and never adopts a remote-backed project", async () => {
  const owned = await createProject({
    name: fixtureName("Resolve Owned"),
    workspacePath: "/tmp/matrix-bmad-scoping-resolve",
  });

  const again = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: { name: "Nama lain", workspacePath: "/tmp/matrix-bmad-scoping-resolve" },
    }),
    200,
  );
  expect(again.body).toMatchObject({ id: owned.id, created: false });
  // The resolver must not rename an existing row either.
  expect((again.body as ProjectBody).name).toBe(fixtureName("Resolve Owned"));

  // A trailing slash is the same workspace; a second project here would mean
  // the index and the resolver disagree about the key.
  const trailing = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: { name: fixtureName("Resolve Owned"), workspacePath: "/tmp/matrix-bmad-scoping-resolve/" },
    }),
    200,
  );
  expect(trailing.body).toMatchObject({ id: owned.id, created: false });

  // A project that owns BOTH a remote and a path is reachable by its remote...
  const remoteBacked = await createProject({
    name: fixtureName("Resolve Remote Backed"),
    gitRemoteUrl: "https://github.com/fatmuh/matrix-bmad-hardening-backed.git",
    workspacePath: "/tmp/matrix-bmad-scoping-remote-backed",
  });
  const byRemote = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: { name: "x", gitRemoteUrl: "git@github.com:fatmuh/matrix-bmad-hardening-backed.git" },
    }),
    200,
  );
  expect(byRemote.body).toMatchObject({ id: remoteBacked.id, created: false });

  // ...but a remote-less caller that merely shares the directory must create
  // its own project instead of claiming the remote-backed one.
  const byPathOnly = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: {
        name: fixtureName("Resolve Path Only"),
        workspacePath: "/tmp/matrix-bmad-scoping-remote-backed",
      },
    }),
    201,
  );
  expect((byPathOnly.body as ProjectBody).created).toBe(true);
  expect((byPathOnly.body as ProjectBody).id).not.toBe(remoteBacked.id);

  // The explicit-projectId compatibility path reads and never creates.
  const byId = expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: { projectId: owned.id },
    }),
    200,
  );
  expect(byId.body).toMatchObject({ id: owned.id, created: false });
  expectStatus(
    await api("/api/projects/resolve", {
      method: "POST",
      cookie,
      body: { projectId: "prj_matrix_tidak_ada" },
    }),
    404,
  );
});

test("identity input the normaliser refuses is a 400, on both create and resolve", async () => {
  const before = await projectCount();

  // `path.resolve("src")` would anchor to the SERVER's cwd, so a relative path
  // is refused rather than silently keyed to the wrong directory.
  for (const path of ["/api/projects", "/api/projects/resolve"]) {
    const response = expectStatus(
      await api(path, {
        method: "POST",
        cookie,
        body: { name: fixtureName("Relatif"), workspacePath: "src" },
      }),
      400,
    );
    expect(response.body).toMatchObject({
      error: expect.stringContaining("absolute"),
    });
  }
  expect(await projectCount()).toBe(before);
});

test("board isolation: task list and agent tree never cross projects", async () => {
  const projectA = await createProject({
    name: fixtureName("Isolasi A"),
    workspacePath: "/tmp/matrix-bmad-scoping-isolasi-a",
  });
  const projectB = await createProject({
    name: fixtureName("Isolasi B"),
    workspacePath: "/tmp/matrix-bmad-scoping-isolasi-b",
  });

  for (const [projectId, marker] of [
    [projectA.id, "A"],
    [projectB.id, "B"],
  ] as const) {
    expectStatus(
      await api(`/api/projects/${projectId}/tasks/batch`, {
        method: "POST",
        cookie,
        body: [{ id: `MX-ISOLASI-${marker}`, title: `Task ${marker}` }],
      }),
      201,
    );
    // Both projects get a node, so each tree has content that the other's tree
    // must not contain — a one-sided fixture would only prove B is empty.
    expectStatus(
      await api(`/api/projects/${projectId}/agent-tree/step`, {
        method: "POST",
        cookie,
        body: { id: `MX-ISOLASI-NODE-${marker}`, name: `Node ${marker}` },
      }),
      200,
    );
  }

  const listA = expectStatus(await api(`/api/projects/${projectA.id}/tasks`, { cookie }), 200);
  const idsA = (listA.body as { id: string }[]).map((task) => task.id);
  expect(idsA).toContain("MX-ISOLASI-A");
  expect(idsA).not.toContain("MX-ISOLASI-B");

  const listB = expectStatus(await api(`/api/projects/${projectB.id}/tasks`, { cookie }), 200);
  const idsB = (listB.body as { id: string }[]).map((task) => task.id);
  expect(idsB).toEqual(["MX-ISOLASI-B"]);

  const treeA = expectStatus(await api(`/api/projects/${projectA.id}/agent-tree`, { cookie }), 200);
  expect(treeA.body).toMatchObject({ id: "MX-ISOLASI-NODE-A", projectId: projectA.id });
  expect(JSON.stringify(treeA.body)).not.toContain("MX-ISOLASI-NODE-B");

  const treeB = expectStatus(await api(`/api/projects/${projectB.id}/agent-tree`, { cookie }), 200);
  expect(treeB.body).toMatchObject({ id: "MX-ISOLASI-NODE-B", projectId: projectB.id });
  expect(JSON.stringify(treeB.body)).not.toContain("MX-ISOLASI-NODE-A");
});

test("every BMad route is gated: no session is a 401", async () => {
  // No other matrix spec touches `bmad_*`, so without this a guard dropped from
  // one route would be silent across the whole suite.
  for (const path of [
    "/api/projects",
    "/api/projects/prj_default/tasks",
    "/api/projects/prj_default/agent-tree",
  ]) {
    expectStatus(await api(path), 401);
  }
  expectStatus(
    await api("/api/projects/prj_default/tasks/batch", {
      method: "POST",
      body: [{ id: "MX-UNAUTH-1", title: "tidak boleh masuk" }],
    }),
    401,
  );
  expectStatus(
    await api("/api/projects/prj_default/agent-tree/step", {
      method: "POST",
      body: { id: "MX-UNAUTH-NODE" },
    }),
    401,
  );
});
