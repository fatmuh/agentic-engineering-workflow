import { expect, test, type Page } from "@playwright/test";
import {
  cleanupE2EFixtures,
  closeDbPool,
  getPool,
  login,
  seedUser,
} from "./helpers";

/**
 * Agent Board state separation and race safety at the browser altitude
 * (spec-bmad-hardening story 5, CAP-7).
 *
 * The board loads two independent requests (`tasks` and `agent-tree`) and a
 * mutation adds a load on top of the 5 s poll. These specs pin what the user
 * actually sees:
 *
 *   1. a failed `agent-tree` never marks the task list failed, and its copy
 *      appears only in the Worktree tab;
 *   2. a failed `tasks` never marks the tree failed — including when the tree
 *      is EMPTY, which is the case that flips under the old shared state;
 *   3. a response from a superseded load never wins, and never touches the
 *      sync indicator.
 *
 * Fixtures are seeded straight into the scratch database and the active
 * project is pinned through `localStorage` (the key `project-context.tsx`
 * reads), so nothing here depends on the `prj_default` demo seed that runs in
 * the background at server start — nor on which project the list returns
 * first. Every id is derived from `test.info().retry`, so a Playwright retry
 * in a reused worker gets fresh rows instead of silently colliding through
 * `ON CONFLICT DO NOTHING`.
 */

const ADMIN_EMAIL = "board-states-admin@e2e.test";

/** The key `project-context.tsx` persists the active project id under. */
const ACTIVE_PROJECT_KEY = "bmad-monitor.active-project-id";

const TASKS_ERROR = "Gagal memuat task workspace ini. Periksa koneksi database lalu tekan Refresh.";
const TREE_ERROR = "Gagal memuat pohon agen workspace ini.";
const TREE_EMPTY = (name: string) => `Belum ada pohon agen di workspace ${name}.`;

interface Fixture {
  projectId: string;
  projectName: string;
  stamp: string;
}

/** Per-attempt fixture ids: `retry` is 0 on the first run, so a retried test
 *  never reuses the previous attempt's project/task/node ids. */
function fixtureFor(retry: number, label: string): Fixture {
  const stamp = `${Date.now().toString(36)}-${process.pid.toString(36)}-${retry}`;
  return {
    stamp,
    projectId: `prj_e2e_board_${label}_${stamp}`,
    projectName: `E2E Board ${label} ${retry}`,
  };
}

const seeded: Fixture[] = [];

/**
 * Seed one project, one task, and — when `withTree` — one agent node.
 * `workspace_path` is unique per fixture: v9 put a unique index on it, so two
 * fixtures must never share a path.
 */
async function seedFixture(fixture: Fixture, options: { withTree: boolean }): Promise<string> {
  const db = getPool();
  const taskTitle = `E2E board task ${fixture.stamp}`;
  await db.query(
    `INSERT INTO bmad_projects (id, name, workspace_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [fixture.projectId, fixture.projectName, `/tmp/e2e-board-${fixture.stamp}`],
  );
  await db.query(
    `INSERT INTO bmad_tasks (id, project_id, title, description, stage, approval_status, assigned_agent)
     VALUES ($1, $2, $3, $4, 'ready_for_review', 'pending', 'e2e-agent')
     ON CONFLICT (project_id, id) DO NOTHING`,
    [`TASK-E2E-${fixture.stamp}`, fixture.projectId, taskTitle, "Seeded by the e2e board-states suite."],
  );
  if (options.withTree) {
    await db.query(
      `INSERT INTO bmad_agent_nodes (id, project_id, name, role, status, model_used)
       VALUES ($1, $2, $3, 'orchestrator', 'running', $4::jsonb)
       ON CONFLICT (project_id, id) DO NOTHING`,
      [
        `node-e2e-${fixture.stamp}`,
        fixture.projectId,
        `E2E board agent ${fixture.stamp}`,
        JSON.stringify({ provider: "Anthropic", modelId: "claude-sonnet-5-5" }),
      ],
    );
  }
  seeded.push(fixture);
  return taskTitle;
}

test.beforeAll(async () => {
  await seedUser({ name: "Board States Admin", email: ADMIN_EMAIL, role: "Admin" });
});

test.afterAll(async () => {
  try {
    if (seeded.length > 0) {
      // Children FIRST, then the parent — deliberately not a bare cascade.
      //
      // A `DELETE FROM bmad_projects` takes ROW EXCLUSIVE on the parent and
      // only then on each child, while the app's own requests (and the boot
      // seed) insert the children and reference the parent in the opposite
      // order. That lock-order inversion deadlocks for real — reproduced
      // against the live server about half the time — and the tips in this
      // file cannot prevent it because the seed and the deletes are separate
      // statements. Deleting the children in the same order the app touches
      // them removes the inversion, so no retry is needed.
      const ids = seeded.map(fixture => fixture.projectId);
      await getPool().query(`DELETE FROM bmad_agent_nodes WHERE project_id = ANY($1::text[])`, [ids]);
      await getPool().query(`DELETE FROM bmad_tasks WHERE project_id = ANY($1::text[])`, [ids]);
      await getPool().query(`DELETE FROM bmad_projects WHERE id = ANY($1::text[])`, [ids]);
    }
    await cleanupE2EFixtures({ emails: [ADMIN_EMAIL] });
  } finally {
    await closeDbPool();
  }
});

/** Pin the active project before any app script runs, so the board's first
 *  load is bound to this fixture instead of whatever the list returns first. */
async function openBoardOnProject(page: Page, projectId: string): Promise<void> {
  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key, id),
    [ACTIVE_PROJECT_KEY, projectId],
  );
  await page.goto("/agent-board");
  await expect(page.getByRole("heading", { name: "Agent Board" })).toBeAttached();
}

const treeFailure = (page: Page) => page.getByText(TREE_ERROR, { exact: true });

test("a failing agent-tree leaves the task list intact and reports the failure only in the Worktree tab", async ({ page }, testInfo) => {
  const fixture = fixtureFor(testInfo.retry, "treefail");
  const taskTitle = await seedFixture(fixture, { withTree: true });

  await login(page, ADMIN_EMAIL);
  // Registered before navigation: the board's very first load must hit it too.
  await page.route(`**/api/projects/${fixture.projectId}/agent-tree`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
  );
  await openBoardOnProject(page, fixture.projectId);

  // The half that succeeded still renders, and is never reported as failed.
  await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(TASKS_ERROR, { exact: true })).toHaveCount(0);

  // The failure belongs to the tree, so the Worktree tab is where it appears.
  await page.getByRole("tab", { name: "Worktree" }).click();
  await expect(treeFailure(page)).toBeVisible();
  // ...and the tree's failure must not leak into the board's copy either.
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.getByText(TASKS_ERROR, { exact: true })).toHaveCount(0);
  await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();
});

test("a failing tasks request leaves an EMPTY agent tree reported as empty, not failed", async ({ page }, testInfo) => {
  // No agent node: the tree is empty, and the Worktree tab must say so. Under
  // the old shared `loadState` this case showed the tree-failure copy instead,
  // so this assertion is what actually pins the split.
  const fixture = fixtureFor(testInfo.retry, "taskfail");
  await seedFixture(fixture, { withTree: false });

  await login(page, ADMIN_EMAIL);
  await page.route(`**/api/projects/${fixture.projectId}/tasks`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
  );
  await openBoardOnProject(page, fixture.projectId);

  // The board reports its own failure.
  await expect(page.getByText(TASKS_ERROR, { exact: true })).toBeVisible();

  // The tree loaded (empty), so its tab says "no tree here" — never "failed".
  await page.getByRole("tab", { name: "Worktree" }).click();
  await expect(page.getByText(TREE_EMPTY(fixture.projectName), { exact: true })).toBeVisible();
  await expect(treeFailure(page)).toHaveCount(0);
});

test("a superseded load never overwrites the newer one, and never moves the sync indicator", async ({ page }, testInfo) => {
  // The story's dev note asks for an artificially delayed fetch. Load #1 is
  // held; Refresh starts load #2 whose `tasks` response is ALSO held, then the
  // stale #1 is released WHILE #2 is still in flight. That ordering is what
  // makes both guards observable:
  //   - without the token, #1's body overwrites the board (title assertion);
  //   - without `isCurrent(token)` around the indicator clear, #1's settle
  //     drops the dot to "idle" while #2 is still running (indicator assertion).
  // Releasing #1 only after #2 finished would make both guards unobservable.
  const fixture = fixtureFor(testInfo.retry, "race");
  await seedFixture(fixture, { withTree: false });
  const freshTitle = `E2E board task ${fixture.stamp}`;
  const staleTitle = `E2E stale task ${fixture.stamp}`;

  await login(page, ADMIN_EMAIL);

  let calls = 0;
  let releaseStale: (() => void) | undefined;
  let releaseFresh: (() => void) | undefined;
  const staleHeld = new Promise<void>(resolve => { releaseStale = resolve; });
  const freshHeld = new Promise<void>(resolve => { releaseFresh = resolve; });

  await page.route(`**/api/projects/${fixture.projectId}/tasks`, async (route) => {
    calls += 1;
    const call = calls;
    if (call === 1) {
      await staleHeld;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([staleTask(fixture, staleTitle)]) });
      return;
    }
    if (call === 2) {
      await freshHeld;
      await route.continue();
      return;
    }
    await route.continue();
  });

  await openBoardOnProject(page, fixture.projectId);

  const indicator = page.locator("[data-sync-state]");
  await expect(indicator).toHaveAttribute("data-sync-state", "syncing");

  // Start the newer load while #1 is still held, then let #2's request go out.
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => calls).toBeGreaterThanOrEqual(2);

  // Release the STALE response first, while the newer load is still running.
  // The settle is asynchronous (network → json → runLoad → React render), so
  // wait on the response event AND a bounded settle before asserting, rather
  // than racing the 300 ms window in which the buggy build still looks correct.
  const staleResponse = page.waitForResponse(
    response => response.url().includes("/tasks") && response.status() === 200,
  );
  releaseStale?.();
  await staleResponse;
  await page.waitForTimeout(1_000);

  // It must be discarded: the stale title never reaches the board...
  await expect(page.getByText(staleTitle, { exact: true })).toHaveCount(0);
  // ...and, crucially, its settle must not clear the indicator for load #2.
  await expect(indicator).toHaveAttribute("data-sync-state", "syncing");

  // The newer load lands last: its data wins and it clears its own indicator.
  releaseFresh?.();
  await expect(page.getByText(freshTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(staleTitle, { exact: true })).toHaveCount(0);
  await expect(indicator).toHaveAttribute("data-sync-state", "idle");
});

/** A `/tasks` row shaped like the API's, so it passes the strict parser. */
function staleTask(fixture: Fixture, title: string) {
  return {
    id: `TASK-STALE-${fixture.stamp}`,
    projectId: fixture.projectId,
    title,
    description: "Should never reach the board.",
    stage: "ready_for_review",
    priority: "medium",
    approvalStatus: "pending",
    assignedAgent: "e2e-agent",
    contextFiles: [],
    checklists: [],
    steps: [],
    sources: 0,
    toolCalls: 0,
    duration: "0s",
  };
}
