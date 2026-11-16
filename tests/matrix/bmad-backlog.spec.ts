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
 * Backlog flow regression matrix (spec-bmad-hardening story 2) — one test per
 * row of the story's I/O matrix, plus the acceptance criteria that need
 * database-level proof (idempotent promote, promoted ⇒ task exists).
 *
 * The flow under test is the one the four awm_backlog_* MCP tools drive:
 *
 *   POST /backlogs (draft) → POST impact (analyzed) → POST promote (Kanban task)
 *
 * with GET /backlogs listing what exists. Every behaviour goes through the
 * real booted app via api(); getPool() is used only for what no HTTP response
 * can prove — row contents, catalog shape, and FK enforcement.
 *
 * Fixtures follow bmad-scoping.spec.ts: every project this file creates
 * carries the name prefix below and is cleaned up by it, nothing depends on
 * the `prj_default` demo seed, and the pool is the scratch database's.
 */

const FIXTURE_NAME_PREFIX = "Matrix BMad Backlog";

let cookie: string;

interface ProjectBody {
  id: string;
  name: string;
}

interface BacklogBody {
  id: string;
  projectId: string;
  title: string;
  rawDescription: string;
  source: string;
  createdBy: string;
  status: string;
  impactAnalysis?: unknown;
  promotedToTaskId?: string;
  promotedBy?: string;
  promotedAt?: string;
}

interface TaskBody {
  id: string;
  projectId: string;
  title: string;
  description: string;
  stage: string;
}

/** Assert the status first: a 500 body is an error object, and reading it as a
 *  list would surface as a TypeError instead of the behaviour that broke. */
function expectStatus(response: ApiResult, status: number): ApiResult {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

async function createProject(label: string): Promise<ProjectBody> {
  const response = expectStatus(
    await api("/api/projects", {
      method: "POST",
      cookie,
      body: {
        name: `${FIXTURE_NAME_PREFIX} ${label}`,
        workspacePath: `/tmp/matrix-bmad-backlog-${label.toLowerCase().replace(/\s+/g, "-")}`,
      },
    }),
    201,
  );
  return response.body as ProjectBody;
}

function backlogsBase(projectId: string): string {
  return `/api/projects/${projectId}/backlogs`;
}

function createBacklog(projectId: string, body: Record<string, unknown>): Promise<ApiResult> {
  return api(backlogsBase(projectId), { method: "POST", cookie, body });
}

function reportImpact(
  projectId: string,
  backlogId: string,
  analysis: unknown,
): Promise<ApiResult> {
  return api(`${backlogsBase(projectId)}/${backlogId}/impact`, {
    method: "POST",
    cookie,
    body: analysis,
  });
}

function promote(
  projectId: string,
  backlogId: string,
  body: Record<string, unknown> = {},
): Promise<ApiResult> {
  return api(`${backlogsBase(projectId)}/${backlogId}/promote`, {
    method: "POST",
    cookie,
    body,
  });
}

/**
 * A complete CodeImpactAnalysis in the exact camelCase shape the Go client
 * marshals — the route must store and return it verbatim, so the fixture stays
 * messy on purpose (nested strategy, omitempty fields genuinely absent). No
 * empty breakingChangeDetails: Go's omitempty never sends one.
 */
function analysisFixture(overrides: Record<string, unknown> = {}) {
  return {
    analyzedAt: "2026-11-06T09:15:00.000Z",
    analyzerAgent: "bmad-agent-analyst",
    affectedFiles: [
      { path: "src/lib/db.ts", changeType: "modify", description: "schema v8 block" },
      { path: "src/lib/backlogs.ts", changeType: "create", description: "backlog lib" },
    ],
    riskLevel: "medium",
    breakingChange: false,
    handlingStrategy: {
      architecturalApproach: "one guarded schema block, idempotent",
      backwardCompatibility: "ADD COLUMN IF NOT EXISTS only",
      rollbackPlan: "drop the three promotion columns",
    },
    suggestedChecklists: [
      { title: "Run the matrix suite", estimatedEffort: "quick" },
      { title: "Verify with the Go binary", estimatedEffort: "moderate" },
    ],
    tokenUsage: { inputTokens: 18450, outputTokens: 3200, totalTokens: 21650 },
    ...overrides,
  };
}

/** The raw row as pg returns it, for byte-exact "no mutation" comparisons. */
async function backlogRow(projectId: string, backlogId: string) {
  const { rows } = await getPool().query(
    `SELECT id, status, impact_analysis, promoted_to_task_id, promoted_by, promoted_at, updated_at
       FROM bmad_backlogs WHERE project_id = $1 AND id = $2`,
    [projectId, backlogId],
  );
  return rows[0];
}

async function taskCount(projectId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM bmad_tasks WHERE project_id = $1`,
    [projectId],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  await seedFixtureUsers();
  cookie = await login(FIXTURE_EMAILS.admin, FIXTURE_PASSWORD);
});

afterAll(async () => {
  const pool = getPool();
  try {
    // Tasks and backlogs cascade from the project. The v8 backlog→task FK is
    // ON DELETE NO ACTION, which Postgres checks only after the cascade has
    // removed the referencing rows too — so this one delete still cleans every
    // table this file wrote, while a direct task delete stays rejected (pinned
    // in the FK test below).
    await pool.query(`DELETE FROM bmad_projects WHERE name LIKE $1`, [`${FIXTURE_NAME_PREFIX}%`]);
  } finally {
    await closeDbPool();
  }
});

test("create: generated ids are sequential per project and the item starts as a draft; empty title is a 400", async () => {
  const project = await createProject("Sequential");

  const first = expectStatus(
    await createBacklog(project.id, {
      title: "Ide pertama",
      rawDescription: "deskripsi awal",
      source: "t3_code",
    }),
    201,
  ).body as BacklogBody;
  expect(first).toMatchObject({
    id: "BKL-001", // fresh project: MAX(n)+1 starts at 1, zero-padded to 3
    projectId: project.id,
    title: "Ide pertama",
    rawDescription: "deskripsi awal",
    source: "t3_code",
    status: "draft",
  });

  const second = expectStatus(
    await createBacklog(project.id, { title: "Ide kedua" }),
    201,
  ).body as BacklogBody;
  expect(Number(second.id.slice(4))).toBe(Number(first.id.slice(4)) + 1);
  expect(second.source).toBe("t3_code"); // omitted → the tool contract's default

  // A 10-digit explicit id overflows int4; the generator must ignore it, not
  // let it poison every later generated create in the project.
  expectStatus(
    await createBacklog(project.id, { id: "BKL-9999999999", title: "Terlalu besar" }),
    201,
  );
  const afterOverflow = expectStatus(
    await createBacklog(project.id, { title: "Masih jalan" }),
    201,
  ).body as BacklogBody;
  expect(afterOverflow.id).toBe("BKL-003");

  expectStatus(await createBacklog(project.id, { title: "   " }), 400);
  // A stale client project id is a clean 404, not a raw FK 500.
  expectStatus(
    await createBacklog("prj_matrix_backlog_tidak_ada", { title: "Project hilang" }),
    404,
  );
});

test("explicit id: the same BKL-001 creates and promotes independently in two projects", async () => {
  const projectA = await createProject("Eksplisit A");
  const projectB = await createProject("Eksplisit B");

  for (const project of [projectA, projectB]) {
    const created = expectStatus(
      await createBacklog(project.id, {
        id: "BKL-001",
        title: `Ide milik ${project.id}`,
        rawDescription: "id eksplisit",
      }),
      201,
    ).body as BacklogBody;
    expect(created).toMatchObject({ id: "BKL-001", projectId: project.id, status: "draft" });

    expectStatus(await reportImpact(project.id, "BKL-001", analysisFixture()), 200);
    const task = expectStatus(await promote(project.id, "BKL-001"), 201).body as TaskBody;
    expect(task).toMatchObject({
      projectId: project.id,
      title: `Ide milik ${project.id}`,
      description: "id eksplisit",
      stage: "ready_for_review",
    });
    expect(task.id).toMatch(/^TASK-/);
  }

  // Two promoted backlogs, two tasks — each backlog pointing at a task that
  // exists in its OWN project (composite-key scoping, end to end). Scoped to
  // these two projects: another fixture's fresh project also owns a generated
  // BKL-001, which is precisely the behaviour this test exists to pin.
  const { rows: backlogs } = await getPool().query<{
    project_id: string;
    status: string;
    promoted_to_task_id: string;
  }>(
    `SELECT project_id, status, promoted_to_task_id FROM bmad_backlogs
      WHERE id = 'BKL-001' AND project_id = ANY($1) ORDER BY project_id`,
    [[projectA.id, projectB.id]],
  );
  expect(backlogs).toHaveLength(2);

  // Two task ROWS — not two distinct id strings: both fresh projects mint
  // their own "TASK-001", which is exactly what per-project scoping means.
  // Each backlog must point at the task of its OWN project (the composite FK
  // shape), never at the other project's same-named task.
  const { rows: tasks } = await getPool().query<{ id: string; project_id: string }>(
    `SELECT t.id, t.project_id
       FROM bmad_tasks t
       JOIN bmad_backlogs b
         ON b.project_id = t.project_id AND b.promoted_to_task_id = t.id
      WHERE b.id = 'BKL-001' AND b.project_id = ANY($1)`,
    [[projectA.id, projectB.id]],
  );
  expect(tasks).toHaveLength(2);
  for (const backlog of backlogs) {
    expect(backlog.status).toBe("promoted");
    expect(
      tasks.find(
        (task) =>
          task.project_id === backlog.project_id && task.id === backlog.promoted_to_task_id,
      ),
    ).toBeDefined();
  }
});

test("list: only this project's backlogs, in creation order; an unknown project answers []", async () => {
  const project = await createProject("Daftar");
  const other = await createProject("Daftar Lain");

  const titles = ["Ide satu", "Ide dua", "Ide tiga"];
  for (const title of titles) {
    expectStatus(await createBacklog(project.id, { title }), 201);
  }
  expectStatus(await createBacklog(other.id, { title: "Milik project lain" }), 201);

  const list = expectStatus(await api(backlogsBase(project.id), { cookie }), 200)
    .body as BacklogBody[];
  expect(list.map((item) => item.title)).toEqual(titles); // created_at order, no leakage
  expect(list.every((item) => item.projectId === project.id)).toBe(true);

  const unknown = expectStatus(
    await api(backlogsBase("prj_matrix_backlog_tidak_ada"), { cookie }),
    200,
  ).body;
  expect(unknown).toEqual([]);
});

test("list filter: ?status= returns only that status", async () => {
  const project = await createProject("Filter");
  const draft = expectStatus(
    await createBacklog(project.id, { title: "Tetap draft" }),
    201,
  ).body as BacklogBody;
  const analyzed = expectStatus(
    await createBacklog(project.id, { title: "Sudah dianalisis" }),
    201,
  ).body as BacklogBody;
  expectStatus(await reportImpact(project.id, analyzed.id, analysisFixture()), 200);

  const analyzedOnly = expectStatus(
    await api(`${backlogsBase(project.id)}?status=analyzed`, { cookie }),
    200,
  ).body as BacklogBody[];
  expect(analyzedOnly.map((item) => item.id)).toEqual([analyzed.id]);

  const draftOnly = expectStatus(
    await api(`${backlogsBase(project.id)}?status=draft`, { cookie }),
    200,
  ).body as BacklogBody[];
  expect(draftOnly.map((item) => item.id)).toEqual([draft.id]);

  // A typo'd filter is a 400, never a silent [] that reads as "empty board".
  expectStatus(await api(`${backlogsBase(project.id)}?status=analyzied`, { cookie }), 400);
});

test("impact: the analysis is stored and returned verbatim, and the status becomes analyzed", async () => {
  const project = await createProject("Impact");
  const created = expectStatus(
    await createBacklog(project.id, { title: "Akan dianalisis" }),
    201,
  ).body as BacklogBody;
  expect(created.impactAnalysis).toBeUndefined(); // a draft has none yet

  const analysis = analysisFixture({ riskLevel: "high", breakingChange: true });
  const updated = expectStatus(
    await reportImpact(project.id, created.id, analysis),
    200,
  ).body as BacklogBody;
  expect(updated).toMatchObject({ id: created.id, status: "analyzed" });
  expect(updated.impactAnalysis).toEqual(analysis); // verbatim — no reshaping
});

test("impact error paths: unknown id 404, invalid riskLevel 400, promoted 409 — none mutate the row", async () => {
  const project = await createProject("Impact Error");

  const backlog = expectStatus(
    await createBacklog(project.id, { title: "Target mutasi" }),
    201,
  ).body as BacklogBody;
  const before = await backlogRow(project.id, backlog.id);

  expectStatus(await reportImpact(project.id, "BKL-9999", analysisFixture()), 404);
  expectStatus(
    await reportImpact(project.id, backlog.id, analysisFixture({ riskLevel: "extreme" })),
    400,
  );
  expect(await backlogRow(project.id, backlog.id)).toEqual(before); // untouched by both

  // A promoted backlog is closed for further analysis — and stays exactly as
  // the promote left it.
  expectStatus(await reportImpact(project.id, backlog.id, analysisFixture()), 200);
  expectStatus(await promote(project.id, backlog.id), 201);
  const promotedRow = await backlogRow(project.id, backlog.id);
  expectStatus(
    await reportImpact(project.id, backlog.id, analysisFixture({ riskLevel: "low" })),
    409,
  );
  expect(await backlogRow(project.id, backlog.id)).toEqual(promotedRow);
});

test("promote: first call creates the task (201); a repeat is 200 with the same task and no new row", async () => {
  const project = await createProject("Promote");
  const created = expectStatus(
    await createBacklog(project.id, { title: "Siap naik", rawDescription: "Deskripsi task" }),
    201,
  ).body as BacklogBody;
  expectStatus(await reportImpact(project.id, created.id, analysisFixture()), 200);

  const task = expectStatus(await promote(project.id, created.id), 201).body as TaskBody;
  expect(task.id).toMatch(/^TASK-/);
  expect(task).toMatchObject({
    projectId: project.id,
    title: "Siap naik",
    description: "Deskripsi task",
    stage: "ready_for_review",
  });

  const row = await backlogRow(project.id, created.id);
  expect(row.status).toBe("promoted");
  expect(row.promoted_to_task_id).toBe(task.id);
  expect(row.promoted_by).toBe("bmad-agent"); // body omitted it — the documented default
  expect(row.promoted_at).not.toBeNull();

  // The same trio through an HTTP body, not only the raw row — this is the
  // toBacklogItem mapping a client actually reads, so a mapping regression
  // (wrong key, dropped field) fails here rather than in production.
  const listBody = expectStatus(
    await api(`${backlogsBase(project.id)}?status=promoted`, { cookie }),
    200,
  ).body as BacklogBody[];
  const listed = listBody.find((item) => item.id === created.id);
  expect(listed).toMatchObject({
    promotedToTaskId: task.id,
    promotedBy: "bmad-agent",
  });
  expect(listed?.promotedAt).toEqual(expect.any(String));

  // Idempotence, at the row level: same task id, not one row more.
  const tasksBefore = await taskCount(project.id);
  const repeat = expectStatus(await promote(project.id, created.id), 200).body as TaskBody;
  expect(repeat.id).toBe(task.id);
  expect(await taskCount(project.id)).toBe(tasksBefore);

  // A repeat with a DIFFERENT targetStage still returns the same task with its
  // ORIGINAL stage — the first promote wins; the stage is never re-targeted.
  const restaged = expectStatus(
    await promote(project.id, created.id, { targetStage: "backlog" }),
    200,
  ).body as TaskBody;
  expect(restaged).toMatchObject({ id: task.id, stage: "ready_for_review" });

  // An explicit targetStage lands on the created task.
  const staged = expectStatus(
    await createBacklog(project.id, { title: "Stage lain" }),
    201,
  ).body as BacklogBody;
  expectStatus(await reportImpact(project.id, staged.id, analysisFixture()), 200);
  const stagedTask = expectStatus(
    await promote(project.id, staged.id, { targetStage: "analysis" }),
    201,
  ).body as TaskBody;
  expect(stagedTask.stage).toBe("analysis");
});

test("promote guards: draft/analyzing 409 naming the impact step, unknown 404, invalid targetStage 400", async () => {
  const project = await createProject("Promote Guard");

  const draft = expectStatus(
    await createBacklog(project.id, { title: "Masih draft" }),
    201,
  ).body as BacklogBody;
  const draftRejected = expectStatus(await promote(project.id, draft.id), 409);
  expect(draftRejected.body).toMatchObject({ error: expect.stringContaining("impact analysis") });
  expect((await backlogRow(project.id, draft.id)).status).toBe("draft");

  // 'analyzing' can only exist by direct write today — the API has no route
  // for it — so set it where the server would have.
  await getPool().query(
    `UPDATE bmad_backlogs SET status = 'analyzing' WHERE project_id = $1 AND id = $2`,
    [project.id, draft.id],
  );
  expectStatus(await promote(project.id, draft.id), 409);

  expectStatus(await promote(project.id, "BKL-9999"), 404);

  const analyzed = expectStatus(
    await createBacklog(project.id, { title: "Stage tolak" }),
    201,
  ).body as BacklogBody;
  expectStatus(await reportImpact(project.id, analyzed.id, analysisFixture()), 200);
  const before = await backlogRow(project.id, analyzed.id);
  expectStatus(await promote(project.id, analyzed.id, { targetStage: "done" }), 400);
  expect(await backlogRow(project.id, analyzed.id)).toEqual(before); // no promotion…
  expect(await taskCount(project.id)).toBe(0); // …and no orphan task either
});

test("every backlog route is gated: no session is a 401", async () => {
  const projectId = "prj_matrix_backlog_unauth";
  expectStatus(await api(backlogsBase(projectId)), 401);
  expectStatus(
    await api(backlogsBase(projectId), { method: "POST", body: { title: "tidak boleh" } }),
    401,
  );
  expectStatus(
    await api(`${backlogsBase(projectId)}/BKL-001/impact`, {
      method: "POST",
      body: analysisFixture(),
    }),
    401,
  );
  expectStatus(
    await api(`${backlogsBase(projectId)}/BKL-001/promote`, { method: "POST", body: {} }),
    401,
  );
});

test("promoted ⇒ task exists: deleting the task is rejected, and the catalog carries the NO ACTION FK", async () => {
  const project = await createProject("Invarian FK");
  const created = expectStatus(
    await createBacklog(project.id, { title: "Invarian FK" }),
    201,
  ).body as BacklogBody;
  expectStatus(await reportImpact(project.id, created.id, analysisFixture()), 200);
  const task = expectStatus(await promote(project.id, created.id), 201).body as TaskBody;

  // The behaviour: no SQL path may leave status='promoted' pointing nowhere.
  await expect(
    getPool().query(`DELETE FROM bmad_tasks WHERE project_id = $1 AND id = $2`, [
      project.id,
      task.id,
    ]),
  ).rejects.toThrow();

  // And the shape, straight from the catalog: the composite FK v8 installs,
  // ON DELETE NO ACTION ('a') — the rule that produced the reject above.
  const { rows: fk } = await getPool().query<{ confdeltype: string }>(
    `SELECT c.confdeltype
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'bmad_backlogs'::regclass
        AND c.confrelid = 'bmad_tasks'::regclass
        AND c.contype = 'f'
        AND a.attname = 'promoted_to_task_id'`,
  );
  expect(fk).toHaveLength(1);
  expect(fk[0].confdeltype).toBe("a");

  expect((await backlogRow(project.id, created.id)).status).toBe("promoted");
});

test("duplicate explicit id in the same project is a 409, not a second row", async () => {
  const project = await createProject("Duplikat");
  expectStatus(await createBacklog(project.id, { id: "BKL-777", title: "Asli" }), 201);

  const duplicate = expectStatus(
    await createBacklog(project.id, { id: "BKL-777", title: "Salinan" }),
    409,
  );
  expect(duplicate.body).toMatchObject({ error: expect.stringContaining("already exists") });

  const { rows } = await getPool().query<{ title: string }>(
    `SELECT title FROM bmad_backlogs WHERE project_id = $1 AND id = 'BKL-777'`,
    [project.id],
  );
  expect(rows).toHaveLength(1); // exactly the original row…
  expect(rows[0].title).toBe("Asli"); // …never overwritten by the loser
});

test("cross-project addressing: A's backlog id under B's project is a 404 and A stays untouched", async () => {
  const projectA = await createProject("Lintas A");
  const projectB = await createProject("Lintas B");
  expectStatus(await createBacklog(projectA.id, { id: "BKL-001", title: "Milik A" }), 201);
  expectStatus(await reportImpact(projectA.id, "BKL-001", analysisFixture()), 200);
  const rowBefore = await backlogRow(projectA.id, "BKL-001");

  // B has no BKL-001; a row existing in A must not make B's request find it,
  // mutate it, or promote anything in B.
  expectStatus(await reportImpact(projectB.id, "BKL-001", analysisFixture()), 404);
  expectStatus(await promote(projectB.id, "BKL-001"), 404);
  expect(await backlogRow(projectA.id, "BKL-001")).toEqual(rowBefore);
  expect(await taskCount(projectB.id)).toBe(0);
});

test("concurrency: parallel promotes converge on one task; parallel creates keep both rows", async () => {
  const project = await createProject("Konkurensi");
  const created = expectStatus(
    await createBacklog(project.id, { title: "Dua tangan" }),
    201,
  ).body as BacklogBody;
  expectStatus(await reportImpact(project.id, created.id, analysisFixture()), 200);

  // FOR UPDATE + the idempotent read must settle two simultaneous promotes of
  // one backlog: one creator (201), one reader of the same task (200), and a
  // single bmad_tasks row.
  const [first, second] = await Promise.all([
    promote(project.id, created.id),
    promote(project.id, created.id),
  ]);
  expect(new Set([first.status, second.status])).toEqual(new Set([200, 201]));
  expect((second.body as TaskBody).id).toBe((first.body as TaskBody).id);
  expect(await taskCount(project.id)).toBe(1);

  // Two simultaneous creates race on MAX(n)+1: the unique-index loser retries
  // and converges — two rows, two distinct ids, neither call 500s.
  const creates = await Promise.all([
    createBacklog(project.id, { title: "Create satu" }),
    createBacklog(project.id, { title: "Create dua" }),
  ]);
  for (const response of creates) expectStatus(response, 201);
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM bmad_backlogs WHERE project_id = $1 AND title LIKE 'Create %'`,
    [project.id],
  );
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
});

test("schema v8 bootstrap is re-entrant: ensureSchema() on the migrated database adds nothing", async () => {
  // Every harness boot is a fresh database, so the hasCompositeForeignKey
  // skip path never runs in a normal suite. resetModules + a dynamic import
  // replays a server restart against the ALREADY-migrated scratch database:
  // a fresh module-level schemaReady, the whole v1→v8 chain, and the FK guard
  // reading "already there". DATABASE_URL must be swapped BEFORE the import —
  // db.ts binds it at import time, which is also why importing @/lib/db here
  // is safe: its pool is the scratch database's, never dev's.
  const previousDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.MATRIX_DB_URL;
  try {
    vi.resetModules();
    const db = await import("@/lib/db");
    await expect(db.ensureSchema()).resolves.toBeUndefined();
    await db.pool.end();
  } finally {
    process.env.DATABASE_URL = previousDbUrl;
  }

  // Re-entrancy proven at the catalog: exactly one promoted-to-task FK, not a
  // duplicate per boot.
  const { rows } = await getPool().query<{ conname: string }>(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'bmad_backlogs'::regclass
        AND c.contype = 'f'
        AND a.attname = 'promoted_to_task_id'`,
  );
  expect(rows).toEqual([{ conname: "bmad_backlogs_promoted_to_task_id_fkey" }]);
});
