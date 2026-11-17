import { expect, test, type Page } from "@playwright/test";
import { closeDbPool, getPool, login, seedUser } from "./helpers";

/**
 * The Worktree lists Claude Code sessions (one root per session) and shows one
 * at a time: a live session first, otherwise the most recently active one,
 * with a status badge, and any other session can be picked from the list.
 */

const ADMIN_EMAIL = "worktree-sessions-admin@e2e.test";
const ACTIVE_PROJECT_KEY = "bmad-monitor.active-project-id";
const seededProjects: string[] = [];

interface Node {
  id: string;
  parent?: string;
  name: string;
  status: string;
  tokens: number;
  minutesAgo: number;
  durationMs?: number;
}

async function seedProject(retry: number, nodes: Node[]): Promise<string> {
  const id = `prj_e2e_sessions_${Date.now().toString(36)}${process.pid.toString(36)}${retry}`;
  await getPool().query(`INSERT INTO bmad_projects (id, name, workspace_path, slug) VALUES ($1, $2, $3, $4)`,
    [id, `E2E Sessions ${id}`, `/tmp/${id}`, id.replace(/_/g, "-")]);
  seededProjects.push(id);
  for (const node of nodes) {
    await getPool().query(
      `INSERT INTO bmad_agent_nodes (id, project_id, parent_id, name, role, status, action, duration_ms, token_usage, model_used, timestamp)
       VALUES ($1, $2, $3, $4, 'orchestrator', $5, '', $6, $7::jsonb, '{"provider":"Anthropic","modelId":"claude-opus-5-5"}'::jsonb,
               now() - make_interval(mins => $8))`,
      [node.id, id, node.parent ?? null, node.name, node.status, node.durationMs ?? 0,
        JSON.stringify({ inputTokens: node.tokens, outputTokens: 0, totalTokens: node.tokens }), node.minutesAgo],
    );
  }
  return id;
}

async function openWorktree(page: Page, projectId: string): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [ACTIVE_PROJECT_KEY, projectId]);
  await login(page, ADMIN_EMAIL);
  await page.goto("/agent-board");
  await page.getByRole("tab", { name: "Worktree" }).click();
}

const picker = (page: Page) => page.getByRole("button", { name: /^Session:/ });

test.beforeAll(async () => {
  await seedUser({ name: "Worktree Sessions Admin", email: ADMIN_EMAIL, role: "Admin" });
});

test.afterAll(async () => {
  try {
    if (seededProjects.length) await getPool().query(`DELETE FROM bmad_projects WHERE id = ANY($1::text[])`, [seededProjects]);
  } finally {
    await closeDbPool();
  }
});

test("an idle workspace shows its latest session, labelled, and any older one can be picked", async ({ page }, testInfo) => {
  const projectId = await seedProject(testInfo.retry, [
    { id: "cc-older", name: "Claude Code older", status: "completed", tokens: 500, minutesAgo: 120 },
    { id: "cc-older-ag", parent: "cc-older", name: "Subagent Plan", status: "completed", tokens: 40, minutesAgo: 121 },
    { id: "cc-latest", name: "Claude Code latest", status: "idle", tokens: 3300, minutesAgo: 5, durationMs: 600_000 },
    { id: "cc-latest-task-f-01", parent: "cc-latest", name: "Task f-01", status: "completed", tokens: 2200, minutesAgo: 6 },
  ]);
  await openWorktree(page, projectId);

  // Latest activity wins; its tokens do not double-count the task node.
  await expect(picker(page)).toContainText("Claude Code latest · idle since");
  await expect(picker(page)).toContainText("3.3k tokens");
  await expect(page.locator("[data-session-status]")).toHaveAttribute("data-session-status", "idle");
  await expect(page.getByText("Task f-01", { exact: true })).toBeVisible();

  await picker(page).click();
  const options = page.getByRole("menuitemradio");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText("Claude Code latest");
  await page.getByRole("menuitemradio", { name: /Claude Code older/ }).click();

  await expect(picker(page)).toContainText("Claude Code older · ended");
  await expect(page.locator("[data-session-status]")).toHaveAttribute("data-session-status", "ended");
  await expect(page.getByText("Subagent Plan", { exact: true })).toBeVisible();
  await expect(page.getByText("Task f-01", { exact: true })).toHaveCount(0);

  // The pick holds across the 5 s poll.
  await page.waitForTimeout(6000);
  await expect(picker(page)).toContainText("Claude Code older");
});

test("a running session is shown first and marked live", async ({ page }, testInfo) => {
  const projectId = await seedProject(testInfo.retry, [
    { id: "cc-recent-idle", name: "Claude Code recent", status: "idle", tokens: 100, minutesAgo: 1 },
    { id: "cc-busy", name: "Claude Code busy", status: "running", tokens: 900, minutesAgo: 3 },
  ]);
  await openWorktree(page, projectId);
  await expect(picker(page)).toContainText("Claude Code busy · live since");
  await expect(page.locator("[data-session-status]")).toHaveAttribute("data-session-status", "live");
});
