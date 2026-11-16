import { expect, test, type Page } from "@playwright/test";
import {
  closeDbPool,
  getPool,
  login,
  seedUser,
} from "./helpers";
import { WORKSPACE_LIST_FAILED } from "../src/components/dashboard/workspace-switcher-state";

/**
 * Workspace Switcher completeness and the Worktree sample label
 * (spec-bmad-hardening story 6: D-9 and D-6).
 *
 * The switcher has to say where its list stands instead of rendering an empty
 * chip, and a workspace switch has to reach the Agent Board's existing
 * `role="status"` live region — the toast alone is invisible to a screen
 * reader. The Worktree tab's static sample must never be the default, and when
 * it is chosen the page has to say in visible text that it is sample data.
 *
 * None of it depends on the `prj_default` demo seed: `/api/projects` is either
 * intercepted outright (loading/error/empty) or answered from per-test rows,
 * and the active project is pinned through `localStorage` — the same key
 * `project-context.tsx` reads. Fixture ids carry `test.info().retry` so a
 * Playwright retry in a reused worker gets fresh rows.
 */

const ADMIN_EMAIL = "workspace-switcher-admin@e2e.test";

/** The key `project-context.tsx` persists the active project id under. */
const ACTIVE_PROJECT_KEY = "bmad-monitor.active-project-id";

const TRIGGER_LOADING = "Memuat workspace…";
const TRIGGER_ERROR = "Gagal memuat workspace";
const TRIGGER_EMPTY = "Belum ada workspace";
const MENU_LOADING = "Memuat daftar workspace…";
/** The switcher's failure note and the board's notice are one shared sentence. */
const MENU_ERROR = WORKSPACE_LIST_FAILED;
const MENU_EMPTY = "Belum ada workspace terdaftar.";
/** The state clause is appended to the visible text (WCAG 2.5.3), so every
 *  accessible-name assertion below pins the pair, not just the clause. */
const labelFor = (visible: string, clause: string) => `${visible} — ${clause}`;

interface ProjectFixture {
  id: string;
  name: string;
  path: string;
}

function projectFixture(retry: number, label: string, index: number): ProjectFixture {
  const stamp = `${Date.now().toString(36)}-${process.pid.toString(36)}-${retry}-${index}`;
  return {
    id: `prj_e2e_switcher_${label}_${stamp}`,
    name: `E2E Switcher ${label} ${retry} ${index}`,
    path: `/tmp/e2e-switcher-${label}-${stamp}`,
  };
}

const seededProjects: ProjectFixture[] = [];

async function seedProjects(projects: ProjectFixture[]): Promise<void> {
  for (const project of projects) {
    await getPool().query(
      `INSERT INTO bmad_projects (id, name, workspace_path)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [project.id, project.name, project.path],
    );
    seededProjects.push(project);
  }
}

/** The shape `GET /api/projects` returns for these rows. */
function projectsPayload(projects: ProjectFixture[]) {
  return projects.map(project => ({
    id: project.id,
    name: project.name,
    gitRemoteUrl: null,
    workspacePath: project.path,
  }));
}

/** Answer `/api/projects` with a fixed payload. */
async function routeProjects(page: Page, projects: ProjectFixture[]): Promise<void> {
  await page.route("**/api/projects", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(projectsPayload(projects)),
    }),
  );
}

/**
 * Fail EVERY `/api/projects` until `release()` is called, then answer.
 *
 * A one-shot counter is load-dependent: `login()` lands on `/`, which mounts
 * ProjectProvider and issues the first request, and the test's own `goto`
 * mounts it again — so "fail the first request" can be consumed by the login
 * page and the page under test never sees a failure. A latch that only the
 * retry click flips is immune to how many navigations happened before.
 *
 * `requests` lets a test prove the retry actually issued a NEW request, rather
 * than the page merely re-rendering from a request that was already in flight.
 */
function failProjectsUntilReleased(page: Page, projects: ProjectFixture[]) {
  let open = false;
  let requests = 0;
  const release = () => { open = true; };
  // Counting from zero again after the click: a request that starts between
  // reading the baseline and clicking would otherwise make the poll wait for a
  // number that can never grow, which is a race in the test, not the app.
  const reset = () => { requests = 0; };
  const install = page.route("**/api/projects", route => {
    requests += 1;
    if (!open) {
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(projectsPayload(projects)),
    });
  });
  return { install, release, reset, count: () => requests };
}

/** Pin the active project before any app script runs. */
async function pinActiveProject(page: Page, projectId: string): Promise<void> {
  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key, id),
    [ACTIVE_PROJECT_KEY, projectId],
  );
}

// Case-insensitive: the state names start with their visible text, so they do
// not all begin with "Ganti".
const switcherTrigger = (page: Page) => page.getByRole("button", { name: /ganti workspace/i });
const switcherMenu = (page: Page) => page.locator('[data-slot="dropdown-menu-content"]');
/** Sonner's toast card, matched by the sentence it shows. */
const toastWith = (page: Page, text: string) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text });
/** The shell's single `sr-only` live region, mounted on every route since the
 *  sidebar can switch workspace from any page. */
const liveRegion = (page: Page) => page.locator('body > p[role="status"]');

test.beforeAll(async () => {
  await seedUser({ name: "Workspace Switcher Admin", email: ADMIN_EMAIL, role: "Admin" });
});

test.afterAll(async () => {
  try {
    if (seededProjects.length > 0) {
      // Children first, then the parent — the same lock order the app uses
      // (see board-states.spec.ts: the inverse order deadlocks against the
      // boot seed's inserts).
      const ids = seededProjects.map(project => project.id);
      await getPool().query(`DELETE FROM bmad_agent_nodes WHERE project_id = ANY($1::text[])`, [ids]);
      await getPool().query(`DELETE FROM bmad_tasks WHERE project_id = ANY($1::text[])`, [ids]);
      await getPool().query(`DELETE FROM bmad_projects WHERE id = ANY($1::text[])`, [ids]);
    }
    // The admin account is deliberately NOT deleted here.
    //
    // `afterAll` runs per file per worker, but `--repeat-each` and parallel
    // workers run the SAME file more than once against ONE scratch database.
    // Whichever worker finishes first then deletes a user the others are still
    // logging in with, and the next `login()` fails with "Invalid email or
    // password" — which downstream locators report as "element(s) not found",
    // pointing at whatever the test was about rather than at the teardown.
    // The account is a fixture `seedUser` already inserts idempotently, and
    // the whole scratch database is dropped at run end, so leaving it costs
    // nothing and removes the race.
  } finally {
    await closeDbPool();
  }
});

test("a failed project list is reported by the trigger and by the menu, and the menu still opens", async ({ page }) => {
  await page.route("**/api/projects", route =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
  );
  await login(page, ADMIN_EMAIL);
  await page.goto("/");

  // The trigger states the failure instead of rendering an empty chip, and the
  // accessible name is that visible text plus the state clause.
  await expect(switcherTrigger(page)).toHaveText(TRIGGER_ERROR);
  await expect(switcherTrigger(page)).toHaveAttribute(
    "aria-label",
    labelFor(TRIGGER_ERROR, "ganti workspace; daftar workspace gagal dimuat"),
  );

  // The menu is still usable: it opens and explains the same failure.
  await switcherTrigger(page).click();
  await expect(switcherMenu(page)).toBeVisible();
  await expect(switcherMenu(page)).toContainText(MENU_ERROR);
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  // Recovery is offered here, not only by reloading the page.
  await expect(page.getByRole("menuitem", { name: "Coba lagi" })).toBeEnabled();
});

test("a pending project list shows loading copy and never blocks the menu", async ({ page }) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/projects", async route => {
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await login(page, ADMIN_EMAIL);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(switcherTrigger(page)).toHaveText(TRIGGER_LOADING);
  await expect(switcherTrigger(page)).toHaveAttribute(
    "aria-label",
    labelFor(TRIGGER_LOADING, "ganti workspace; daftar workspace sedang dimuat"),
  );
  await expect(switcherTrigger(page)).toBeEnabled();

  // The menu opens from a click handler that only exists after hydration, and
  // "the trigger is enabled" is true before that. Clicking once and asserting
  // is a race the whole suite can lose under load — retry the click until the
  // menu is actually open instead.
  await expect
    .poll(async () => {
      await switcherTrigger(page).click({ timeout: 2_000 }).catch(() => {});
      return switcherMenu(page).isVisible().catch(() => false);
    }, { timeout: 15_000 })
    .toBe(true);
  await expect(switcherMenu(page)).toContainText(MENU_LOADING);

  // Let the held request finish and show the empty state, so no route is left
  // pending when the test ends.
  release?.();
  await expect(switcherTrigger(page)).toHaveText(TRIGGER_EMPTY);
});

test("an empty project list says so instead of showing an empty trigger", async ({ page }) => {
  await routeProjects(page, []);
  await login(page, ADMIN_EMAIL);
  await page.goto("/");

  await expect(switcherTrigger(page)).toHaveText(TRIGGER_EMPTY);
  await expect(switcherTrigger(page)).toHaveAttribute(
    "aria-label",
    labelFor(TRIGGER_EMPTY, "ganti workspace; belum ada workspace terdaftar"),
  );
  await switcherTrigger(page).click();
  await expect(switcherMenu(page)).toContainText(MENU_EMPTY);
  // "Buat workspace" stays present and disabled — the only affordance left.
  await expect(page.getByRole("menuitem", { name: /Buat workspace/ })).toBeDisabled();
});

test("switching workspace toasts in Indonesian and announces the new name to the shell's live region", async ({ page }, testInfo) => {
  const [first, second] = [1, 2].map(index => projectFixture(testInfo.retry, "switch", index));
  await seedProjects([first, second]);
  await routeProjects(page, [first, second]);
  await pinActiveProject(page, first.id);

  // Collect every board fetch so "a switch actually refetches" and "a no-op
  // re-pick issues no request" are both observable instead of inferred.
  const taskRequests: string[] = [];
  const boardRequests = (uid: string) => `**/api/projects/${uid}/tasks`;
  await page.route(boardRequests(first.id), route => route.continue());
  await page.route(boardRequests(second.id), route => {
    taskRequests.push(second.id);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });

  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await expect(page.getByRole("heading", { name: "Agent Board" })).toBeAttached();
  await expect(switcherTrigger(page)).toHaveText(first.name);
  await expect(switcherTrigger(page)).toHaveAttribute("aria-label", labelFor(first.name, "ganti workspace"));

  // Everything that leaves the page, so the no-op assertion below can count.
  const outgoing: string[] = [];
  page.on("request", request => outgoing.push(request.url()));

  // Re-picking the active workspace is a no-op: no toast, no announcement, and
  // no request — not even a refetch.
  await switcherTrigger(page).click();
  await page.getByRole("menuitemradio", { name: new RegExp(first.name) }).click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(liveRegion(page)).toHaveText("");
  expect(outgoing.filter(url => url.includes("/api/projects/"))).toEqual([]);

  // A real switch says so twice: visible toast, and the live region a screen
  // reader actually hears.
  await switcherTrigger(page).click();
  await page.getByRole("menuitemradio", { name: new RegExp(second.name) }).click();
  await expect(toastWith(page, `Beralih ke workspace ${second.name}`)).toBeVisible();
  await expect(liveRegion(page)).toHaveText(`Beralih ke workspace ${second.name}.`);
  await expect(switcherTrigger(page)).toHaveText(second.name);

  // The board is bound to the new workspace: its own tasks endpoint is what it
  // asks for now.
  await expect.poll(() => taskRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
});

test("a live region mounted in the shell does not replay an old announcement after a remount", async ({ page }, testInfo) => {
  const [first, second] = [1, 2].map(index => projectFixture(testInfo.retry, "remount", index));
  await seedProjects([first, second]);
  await routeProjects(page, [first, second]);
  await pinActiveProject(page, first.id);

  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await expect(switcherTrigger(page)).toHaveText(first.name);

  await switcherTrigger(page).click();
  await page.getByRole("menuitemradio", { name: new RegExp(second.name) }).click();
  await expect(liveRegion(page)).toHaveText(`Beralih ke workspace ${second.name}.`);

  // Client-side navigation away and back: the region lives in the shell, so it
  // survives — the board remounting must show nothing rather than replay.
  await page.getByRole("link", { name: "Wiki", exact: true }).first().click();
  await expect(page).toHaveURL(/\/wiki$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Agent Board" })).toBeAttached();
  // Immediate check: the remount does not replay the sentence, and the board
  // keeps no copy of it either.
  await expect(liveRegion(page)).toHaveText("");
  // ...and it is cleared after the read window, so the next page never
  // inherits it at all.
  await expect(liveRegion(page)).toHaveText("", { timeout: 20_000 });
});

test("the collapsed sidebar carries the state in the accessible name alone", async ({ page }, testInfo) => {
  const [first] = [1].map(index => projectFixture(testInfo.retry, "collapsed", index));
  await seedProjects([first]);
  await pinActiveProject(page, first.id);

  // Fail the list from the very first request. The latch is only released by
  // the retry, so the error state survives every navigation in between — the
  // older one-shot counter could be consumed by the login page's own mount.
  const projects = failProjectsUntilReleased(page, [first]);
  await projects.install;

  await login(page, ADMIN_EMAIL);
  await page.goto("/");
  await expect(switcherTrigger(page)).toHaveText(TRIGGER_ERROR, { timeout: 15_000 });

  // Collapse WHILE in the error state: the sidebar's open state is in-memory
  // (its cookie is written but never read back), so a reload would return to
  // the expanded branch and this icon-only branch would never render.
  await page.getByRole("button", { name: "Collapse sidebar (Cmd+B)" }).click();
  const collapsedError = page.locator("aside").getByRole("button", { name: /ganti workspace/ });
  await expect(collapsedError).toHaveText("");
  await expect(collapsedError).toHaveAttribute(
    "aria-label",
    labelFor(TRIGGER_ERROR, "ganti workspace; daftar workspace gagal dimuat"),
  );

  // Collapsed, the icon-only recovery is the ONLY place the failure is
  // visible — its accessible name has to carry both the sentence and the
  // action, since a bare icon says neither.
  const collapsedRecovery = page.locator("aside").getByRole("button", { name: "Daftar workspace gagal dimuat. Coba lagi" });
  await expect(collapsedRecovery).toBeVisible();

  // Count from the click, not from a baseline sample: see `reset`'s comment.
  projects.release();
  projects.reset();
  await collapsedRecovery.click();

  await expect.poll(() => projects.count(), { timeout: 15_000 }).toBeGreaterThan(0);
  // The icon-only recovery did its job: the list arrived, and the state is
  // back in the collapsed trigger's accessible name alone.
  await expect(collapsedError).toHaveAttribute(
    "aria-label",
    labelFor(first.name, "ganti workspace"),
    { timeout: 15_000 },
  );
  await expect(collapsedRecovery).toHaveCount(0);
});

test("the sidebar's failure row announces itself once through a status region", async ({ page }, testInfo) => {
  const [first] = [1].map(index => projectFixture(testInfo.retry, "sidebar-status", index));
  await seedProjects([first]);

  const projects = failProjectsUntilReleased(page, [first]);
  await projects.install;
  await pinActiveProject(page, first.id);

  await login(page, ADMIN_EMAIL);
  await page.goto("/");

  // The news is announced, and the button that acts on it is OUTSIDE the live
  // region: a focusable control inside `role="status"` re-announces the
  // sentence every time it takes focus.
  const statusRegion = page.locator("aside").locator('[role="status"]');
  await expect(statusRegion).toHaveCount(1);
  await expect(statusRegion).toHaveText(WORKSPACE_LIST_FAILED);
  await expect(statusRegion.getByRole("button")).toHaveCount(0);

  const retry = page.locator("aside").getByRole("button", { name: "Coba lagi" });
  const requestsBeforeRetry = projects.count();
  projects.release();
  await retry.click();
  await expect.poll(() => projects.count(), { timeout: 15_000 }).toBeGreaterThan(requestsBeforeRetry);
  await expect(statusRegion).toHaveCount(0);
});

test("the Worktree tab opens on the database tree, and the sample tree is labelled when chosen", async ({ page }, testInfo) => {
  const project = projectFixture(testInfo.retry, "worktree", 1);
  await seedProjects([project]);
  await routeProjects(page, [project]);
  await pinActiveProject(page, project.id);

  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await expect(page.getByRole("heading", { name: "Agent Board" })).toBeAttached();

  // No agent node seeded: the database tree is empty, and the tab must say so
  // rather than fall back to the sample fixture.
  await page.getByRole("tab", { name: "Worktree" }).click();
  await expect(page.getByText(`Belum ada pohon agen di workspace ${project.name}.`, { exact: true })).toBeVisible();
  await expect(page.getByText("Launch the new pricing page by Friday", { exact: true })).toHaveCount(0);

  // The LIVE half is named in Indonesian before anything is opened: only the
  // sample label is asserted later otherwise, and this is the half that could
  // silently regress to English.
  const sourceTrigger = page.getByRole("button", { name: "Sumber pohon Worktree" });
  await expect(sourceTrigger).toContainText("Pohon BMad langsung · database");
  await sourceTrigger.click();
  await expect(page.getByRole("radio", { name: "Pohon BMad langsung · database", exact: true }))
    .toHaveAttribute("aria-checked", "true");

  // Choose the sample: the tree appears, and a visible line says it is sample
  // data — not just an attribute. The tree's container describes itself with
  // that line, so a screen reader reading the tree meets it too.
  await page.getByRole("radio", { name: /Contoh · Halaman harga/ }).click();
  await page.keyboard.press("Escape");

  const sampleNote = page.locator("#worktree-sample-note");
  await expect(sampleNote).toContainText("Data contoh, bukan data database.");
  await expect(page.locator('section[aria-label="Pohon contoh"]')).toHaveAttribute(
    "aria-describedby",
    "worktree-sample-note",
  );
  await expect(page.getByText("Launch the new pricing page by Friday", { exact: true })).toBeVisible();
  // The trigger now names the sample too, so the state is readable after the
  // popover closes.
  await expect(sourceTrigger).toContainText("Contoh · Halaman harga · 3 cabang");
});

test("the sample-data caveat has its own sentence when no workspace is active", async ({ page }) => {
  await routeProjects(page, []);
  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await expect(switcherTrigger(page)).toHaveText(TRIGGER_EMPTY);

  await page.getByRole("tab", { name: "Worktree" }).click();
  await page.getByRole("button", { name: "Sumber pohon Worktree" }).click();
  await page.getByRole("radio", { name: /Contoh · Halaman harga/ }).click();
  await page.keyboard.press("Escape");

  // The workspace-name fallback used to read "... tidak berasal dari workspace
  // ini", which parses wrong; with no project it gets a complete sentence.
  const note = page.locator("#worktree-sample-note");
  await expect(note).toContainText("belum ada workspace aktif");
  await expect(note).not.toContainText("tidak berasal dari workspace");
});

/**
 * D-8b: a failed project list is recoverable in place.
 *
 * `/api/projects` fails until the retry flips the latch, so the page under
 * test is guaranteed to SEE the failure no matter how many navigations the
 * login flow took first. The recovery affordance must be visible (board AND
 * sidebar, not only inside the switcher's menu), must call the context's own
 * `reload()` rather than navigating, and must leave the user on the page they
 * started on — the sentence the board used to show told them to reload the
 * whole page, which is the hole this story closes.
 */
test("a failed project list is recoverable from the board without a page reload", async ({ page }, testInfo) => {
  const [first, second] = [1, 2].map(index => projectFixture(testInfo.retry, "recover", index));
  await seedProjects([first, second]);

  const projects = failProjectsUntilReleased(page, [first, second]);
  await projects.install;
  await pinActiveProject(page, first.id);

  // Count navigations, so "without a page reload" is measured rather than
  // inferred from the URL staying put. Only the DELTA across the retry is
  // asserted: the login flow's own redirects make an absolute count brittle,
  // and the claim is that the retry itself never navigates.
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations += 1; });

  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Agent Board" })).toBeAttached();

  const boardNotice = page.locator('[data-board-notice="status"]').filter({ hasText: WORKSPACE_LIST_FAILED });
  await expect(boardNotice).toBeVisible();
  // The list is genuinely absent here, so the copy must say so and must not
  // claim anything is stale.
  await expect(boardNotice).toContainText(WORKSPACE_LIST_FAILED);
  await expect(boardNotice).not.toContainText("mungkin sudah tidak terbaru");
  // One notice, not one per panel: the failure is project-level, and two
  // copies plus the sidebar row made three statements of one fact.
  await expect(page.locator('[data-board-notice="status"]')).toHaveCount(1);
  // The panel's own empty-state copy must not repeat the same news.
  await expect(page.getByText("Memuat workspace…", { exact: true })).toHaveCount(0);
  // The old guidance sent the user to a full page reload. Scoped to the
  // notice, so unrelated future copy cannot make this pass or fail by accident.
  await expect(boardNotice).not.toContainText(/muat ulang halaman/i);

  // The sidebar carries the same recovery next to the switcher, so the way out
  // is visible without opening the menu.
  const sidebarRecovery = page.locator("aside").getByRole("button", { name: "Coba lagi" });
  await expect(sidebarRecovery).toBeVisible();

  const requestsBeforeRetry = projects.count();
  const navigationsBeforeRetry = navigations;
  projects.release();
  await boardNotice.getByRole("button", { name: "Coba lagi" }).click();

  // "The retry worked" must be distinguishable from "the login page consumed
  // the failure": the click has to issue a NEW request.
  await expect.poll(() => projects.count(), { timeout: 15_000 }).toBeGreaterThan(requestsBeforeRetry);
  await expect(switcherTrigger(page)).toHaveText(first.name, { timeout: 15_000 });
  await expect(boardNotice).toHaveCount(0);
  await expect(sidebarRecovery).toHaveCount(0);
  expect(navigations).toBe(navigationsBeforeRetry);
});

test("the sidebar's recovery affordance is the same reload path", async ({ page }, testInfo) => {
  const [first] = [1].map(index => projectFixture(testInfo.retry, "sidebar-recover", index));
  await seedProjects([first]);

  const projects = failProjectsUntilReleased(page, [first]);
  await projects.install;
  await pinActiveProject(page, first.id);

  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations += 1; });

  await login(page, ADMIN_EMAIL);
  await page.goto("/");
  await expect(switcherTrigger(page)).toHaveText(TRIGGER_ERROR);

  const sidebarRecovery = page.locator("aside").getByRole("button", { name: "Coba lagi" });
  await expect(sidebarRecovery).toBeVisible();

  const requestsBeforeRetry = projects.count();
  const navigationsBeforeRetry = navigations;
  projects.release();
  await sidebarRecovery.click();

  await expect.poll(() => projects.count(), { timeout: 15_000 }).toBeGreaterThan(requestsBeforeRetry);
  await expect(switcherTrigger(page)).toHaveText(first.name, { timeout: 15_000 });
  await expect(sidebarRecovery).toHaveCount(0);
  expect(navigations).toBe(navigationsBeforeRetry);
});

/**
 * D-8a: two tabs share one selection.
 *
 * A second page in the same Playwright browser context shares `localStorage`,
 * which is what makes this the realistic reproduction: it is the same storage
 * area, and Chrome delivers `storage` events to the other page only. The test
 * asserts both halves of the contract — the other tab follows without a
 * reload, and it does not write the value back.
 */
test("a second tab follows the workspace chosen in the first, without reloading or writing back", async ({ page, context }, testInfo) => {
  const [first, second] = [1, 2].map(index => projectFixture(testInfo.retry, "twotab", index));
  await seedProjects([first, second]);
  await routeProjects(page, [first, second]);
  await pinActiveProject(page, first.id);

  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await expect(page.getByRole("heading", { name: "Agent Board" })).toBeAttached();
  await expect(switcherTrigger(page)).toHaveText(first.name);

  // The second tab: same context, so the same `localStorage`. It logs in on its
  // own route (the session cookie is shared), and it must open on the SAME
  // workspace before anything is switched.
  const other = await context.newPage();
  try {
    await routeProjects(other, [first, second]);
    let otherNavigations = 0;
    other.on("framenavigated", frame => { if (frame === other.mainFrame()) otherNavigations += 1; });
    await other.goto("/agent-board");
    await expect(switcherTrigger(other)).toHaveText(first.name);
    const otherNavigationsBefore = otherNavigations;

    // Count every write the second tab makes to the key. The listener must
    // adopt the value without persisting it back.
    await other.evaluate(key => {
      const proto = Object.getPrototypeOf(window.localStorage) as Storage;
      const original = proto.setItem;
      (window as unknown as { __selectionWrites: string[] }).__selectionWrites = [];
      proto.setItem = function (this: Storage, k: string, v: string) {
        if (k === key) (window as unknown as { __selectionWrites: string[] }).__selectionWrites.push(v);
        return original.call(this, k, v);
      };
    }, ACTIVE_PROJECT_KEY);

    // Switch in the first tab.
    await switcherTrigger(page).click();
    await page.getByRole("menuitemradio", { name: new RegExp(second.name) }).click();
    await expect(switcherTrigger(page)).toHaveText(second.name);

    // The other tab follows on its own — no reload, no navigation.
    await expect(switcherTrigger(other)).toHaveText(second.name, { timeout: 15_000 });
    expect(otherNavigations).toBe(otherNavigationsBefore);
    // And it says so: adopting is a workspace switch, so the shell's live
    // region carries the same sentence a click in this tab would produce.
    // Without this, a screen-reader user's board changes under them silently.
    await expect(liveRegion(other)).toHaveText(`Beralih ke workspace ${second.name}.`);

    // And it wrote nothing: adopting is not a selection.
    const writes = await other.evaluate(() => (window as unknown as { __selectionWrites: string[] }).__selectionWrites);
    expect(writes).toEqual([]);

    // Give a naive ping-pong time to show up, then assert it did not happen.
    await page.waitForTimeout(500);
    const writesLater = await other.evaluate(() => (window as unknown as { __selectionWrites: string[] }).__selectionWrites);
    expect(writesLater).toEqual([]);
  } finally {
    await other.close();
  }
});

test("a workspace id this tab does not know is ignored rather than clearing the selection", async ({ page }, testInfo) => {
  const [first] = [1].map(index => projectFixture(testInfo.retry, "unknown-id", index));
  await seedProjects([first]);
  // Only the first project is returned by the list; the other id exists only
  // in the other tab's storage, exactly as a selection from a newer list would.
  await routeProjects(page, [first]);
  await pinActiveProject(page, first.id);

  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await expect(switcherTrigger(page)).toHaveText(first.name);

  // Write an id outside this tab's list into the shared storage, and deliver
  // it the way a browser delivers another tab's write.
  await page.evaluate(key => {
    // The area is passed explicitly: the real listener rejects an event whose
    // storageArea is some other area, and a hand-built event with none would
    // pass that check for the wrong reason.
    window.localStorage.setItem(key, "prj_e2e_switcher_unknown_id");
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      newValue: "prj_e2e_switcher_unknown_id",
      storageArea: window.localStorage,
    }));
  }, ACTIVE_PROJECT_KEY);

  // The selection did not move, and nothing replaced it with an empty one.
  await expect(switcherTrigger(page)).toHaveText(first.name);
  await page.waitForTimeout(500);
  await expect(switcherTrigger(page)).toHaveText(first.name);
  // Nothing was adopted, so nothing was announced either.
  await expect(liveRegion(page)).toHaveText("");
});

test("a same-key sessionStorage write does not switch the workspace", async ({ page }, testInfo) => {
  const [first, second] = [1, 2].map(index => projectFixture(testInfo.retry, "session-area", index));
  await seedProjects([first, second]);
  await routeProjects(page, [first, second]);
  await pinActiveProject(page, first.id);

  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await expect(switcherTrigger(page)).toHaveText(first.name);

  // A valid id, under the right key, but from the WRONG storage area — what a
  // same-origin iframe writing sessionStorage would produce.
  await page.evaluate(([key, id]) => {
    window.sessionStorage.setItem(key, id);
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      newValue: id,
      storageArea: window.sessionStorage,
    }));
  }, [ACTIVE_PROJECT_KEY, second.id]);

  await page.waitForTimeout(500);
  await expect(switcherTrigger(page)).toHaveText(first.name);
  await expect(liveRegion(page)).toHaveText("");
});
