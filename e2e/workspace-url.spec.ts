import { expect, test, type Page } from "@playwright/test";
import { closeDbPool, getPool, login, seedUser } from "./helpers";

/**
 * Workspace URLs, search and the project id (follow-up to the create dialog).
 *
 *   - `/agent-board/<slug>` names the workspace: opening it selects that
 *     workspace, switching on the board changes the URL, Back walks it, and
 *     plain `/agent-board` moves to the active workspace's URL.
 *   - A board tab keeps the workspace its URL names when another tab switches.
 *   - The switcher scrolls past five rows and offers search there.
 *   - The active project id can be copied from the switcher and the board.
 *
 * Rows are inserted with their slug directly; ids and slugs carry a per-run
 * stamp so retries and parallel workers never collide.
 */

const ADMIN_EMAIL = "workspace-url-admin@e2e.test";
const ACTIVE_PROJECT_KEY = "bmad-monitor.active-project-id";

interface Fixture {
  id: string;
  name: string;
  slug: string;
}

const seeded: string[] = [];

function fixtures(label: string, count: number, retry: number): Fixture[] {
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}${retry}`;
  return Array.from({ length: count }, (_, i) => ({
    id: `prj_e2e_url_${label}_${stamp}_${i + 1}`,
    name: `E2E URL ${label} ${stamp} ${i + 1}`,
    slug: `e2e-url-${label}-${stamp}-${i + 1}`,
  }));
}

async function seed(rows: Fixture[]): Promise<void> {
  for (const row of rows) {
    await getPool().query(
      `INSERT INTO bmad_projects (id, name, workspace_path, slug) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.name, `/tmp/${row.slug}`, row.slug],
    );
    seeded.push(row.id);
  }
}

/** Answer `/api/projects` with exactly these rows, slug included. */
async function routeList(page: Page, rows: Fixture[]): Promise<void> {
  await page.route("**/api/projects", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows.map(row => ({ id: row.id, name: row.name, slug: row.slug, gitRemoteUrl: null, workspacePath: `/tmp/${row.slug}` }))),
    }),
  );
}

async function pin(page: Page, id: string): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [ACTIVE_PROJECT_KEY, id]);
}

const trigger = (page: Page) => page.getByRole("button", { name: /switch workspace/i });
const storedId = (page: Page) => page.evaluate(key => window.localStorage.getItem(key), ACTIVE_PROJECT_KEY);

test.beforeAll(async () => {
  await seedUser({ name: "Workspace URL Admin", email: ADMIN_EMAIL, role: "Admin" });
});

test.afterAll(async () => {
  try {
    if (seeded.length > 0) {
      await getPool().query(`DELETE FROM bmad_projects WHERE id = ANY($1::text[])`, [seeded]);
    }
  } finally {
    await closeDbPool();
  }
});

test("the Agent Board URL names the workspace, follows a switch and walks Back", async ({ page }, testInfo) => {
  const [first, second] = fixtures("nav", 2, testInfo.retry);
  await seed([first, second]);
  await routeList(page, [first, second]);
  await pin(page, first.id);
  await login(page, ADMIN_EMAIL);

  // Plain /agent-board moves to the active workspace's URL.
  await page.goto("/agent-board");
  await expect(page).toHaveURL(new RegExp(`/agent-board/${first.slug}$`));
  await expect(trigger(page)).toHaveText(first.name);

  // Switching on the board changes the URL and the board's requests.
  const tasksForSecond = page.waitForRequest(request => request.url().includes(`/api/projects/${second.id}/tasks`));
  await trigger(page).click();
  await page.getByRole("menuitemradio", { name: new RegExp(second.name) }).click();
  await expect(page).toHaveURL(new RegExp(`/agent-board/${second.slug}$`));
  await expect(trigger(page)).toHaveText(second.name);
  await tasksForSecond;
  // Remembered, which is what opens it next time.
  expect(await storedId(page)).toBe(second.id);

  // Back is a workspace switch too.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/agent-board/${first.slug}$`));
  await expect(trigger(page)).toHaveText(first.name);
});

test("opening a workspace URL selects it, and an unknown one falls back with a message", async ({ page }, testInfo) => {
  const [first, second] = fixtures("open", 2, testInfo.retry);
  await seed([first, second]);
  await routeList(page, [first, second]);
  await pin(page, first.id);
  await login(page, ADMIN_EMAIL);

  // The URL wins over the remembered selection.
  await page.goto(`/agent-board/${second.slug}`);
  await expect(trigger(page)).toHaveText(second.name);
  expect(await storedId(page)).toBe(second.id);

  // A workspace's id works as well as its slug.
  await page.goto(`/agent-board/${second.id}`);
  await expect(trigger(page)).toHaveText(second.name);

  await page.goto("/agent-board/no-such-workspace");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: 'Workspace "no-such-workspace" not found.' })).toBeVisible();
  // Back to the remembered workspace (the init script pinned the first again).
  await expect(page).toHaveURL(new RegExp(`/agent-board/${first.slug}$`));
});

test("a board tab keeps the workspace its URL names when another tab switches", async ({ page, context }, testInfo) => {
  const [first, second] = fixtures("tabs", 2, testInfo.retry);
  await seed([first, second]);
  await routeList(page, [first, second]);
  await login(page, ADMIN_EMAIL);
  await page.goto(`/agent-board/${first.slug}`);
  await expect(trigger(page)).toHaveText(first.name);

  const other = await context.newPage();
  try {
    await routeList(other, [first, second]);
    await other.goto(`/agent-board/${first.slug}`);
    await expect(trigger(other)).toHaveText(first.name);

    await trigger(page).click();
    await page.getByRole("menuitemradio", { name: new RegExp(second.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/agent-board/${second.slug}$`));

    // Give a follow time to happen, then assert it did not.
    await other.waitForTimeout(800);
    await expect(trigger(other)).toHaveText(first.name);
    await expect(other).toHaveURL(new RegExp(`/agent-board/${first.slug}$`));
  } finally {
    await other.close();
  }
});

test("the switcher scrolls past five workspaces and filters them by search", async ({ page }, testInfo) => {
  const rows = fixtures("search", 7, testInfo.retry);
  await seed(rows);
  await routeList(page, rows);
  await pin(page, rows[0].id);
  await login(page, ADMIN_EMAIL);
  await page.goto("/");

  await trigger(page).click();
  const list = page.locator(".workspace-switcher-list");
  await expect(page.getByRole("menuitemradio")).toHaveCount(7);
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);

  const search = page.getByLabel("Search workspaces");
  await search.fill(rows[4].name);
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
  await expect(page.getByRole("menuitemradio")).toContainText(rows[4].name);
  await page.keyboard.press("Enter");
  await expect(trigger(page)).toHaveText(rows[4].name);

  await trigger(page).click();
  await page.getByLabel("Search workspaces").fill("zzz-nothing-matches");
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await expect(page.getByText("No matching workspaces.")).toBeVisible();
});

test("five workspaces or fewer show no search field", async ({ page }, testInfo) => {
  const rows = fixtures("few", 2, testInfo.retry);
  await seed(rows);
  await routeList(page, rows);
  await login(page, ADMIN_EMAIL);
  await page.goto("/");
  await trigger(page).click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await expect(page.getByLabel("Search workspaces")).toHaveCount(0);
});

test("the active project id can be copied from the switcher and from the board", async ({ page, context }, testInfo) => {
  const [first] = fixtures("copy", 1, testInfo.retry);
  await seed([first]);
  await routeList(page, [first]);
  await pin(page, first.id);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, ADMIN_EMAIL);
  await page.goto(`/agent-board/${first.slug}`);
  await expect(trigger(page)).toHaveText(first.name);

  await trigger(page).click();
  await page.getByRole("menuitem", { name: /Copy project ID/ }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Project ID copied" }).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first.id);

  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.getByRole("button", { name: `Copy project ID ${first.id}` }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first.id);
});
