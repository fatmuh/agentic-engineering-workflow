import { expect, test, type Page } from "@playwright/test";
import {
  cleanupE2EFixtures,
  closeDbPool,
  login,
  seedUser,
} from "./helpers";

/**
 * Sidebar and command palette exactness matrix (epic 3 story 3, extended by
 * the wiki initiative: Wiki joins the workspace group for every role holding
 * wiki.view, Storage joins the admin group for Admin only).
 *
 * Verifies that each seeded role (Admin, Editor, Member) sees exactly its
 * permitted navigation links, admin section structure, watching section, and
 * command palette item set — asserting both presence of granted entries and
 * total absence (count 0) of ungranted ones.
 */

const ADMIN_EMAIL = "admin-sidebar@e2e.test";
const EDITOR_EMAIL = "editor-sidebar@e2e.test";
const MEMBER_EMAIL = "member-sidebar@e2e.test";

const EXPECTED_ITEMS = {
  member: [
    "Agent Board",
    "Ask AI",
    "Byteforge",
    "Canguard",
    "Home",
    "OmniCorp",
    "Segnalio",
    "Toggle Sidebar",
    "Watching",
    "Wiki",
  ],
  editor: [
    "Agent Board",
    "Ask AI",
    "Byteforge",
    "Canguard",
    "Home",
    "LLM Providers",
    "OmniCorp",
    "Segnalio",
    "Toggle Sidebar",
    "Users",
    "Watching",
    "Wiki",
  ],
  admin: [
    "Agent Board",
    "Ask AI",
    "Byteforge",
    "Canguard",
    "Home",
    "LLM Providers",
    "OmniCorp",
    "Permissions",
    "Roles",
    "Segnalio",
    "Storage",
    "Toggle Sidebar",
    "Users",
    "Watching",
    "Wiki",
  ],
} as const;

async function assertWatchingSection(page: Page): Promise<void> {
  const sidebar = page.locator("aside");
  await expect(sidebar.getByRole("link", { name: "Canguard", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Segnalio", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Byteforge", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "OmniCorp", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Show all", exact: true })).toBeVisible();
}

async function assertCommandPalette(page: Page, expected: readonly string[]): Promise<void> {
  await page.getByRole("button", { name: /Search/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await expect(page.locator("[cmdk-item]")).toHaveCount(expected.length);

  const items = await page.locator("[cmdk-item]").evaluateAll((els) =>
    els.map((el) => {
      const span =
        el.querySelector("span:not([data-slot='command-shortcut'])") ??
        el.querySelector("span");
      return (span?.textContent ?? el.textContent ?? "").trim();
    })
  );
  items.sort();
  expect(items).toEqual([...expected].sort());

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test.afterAll(async () => {
  try {
    await cleanupE2EFixtures({
      emails: [ADMIN_EMAIL, EDITOR_EMAIL, MEMBER_EMAIL],
    });
  } finally {
    await closeDbPool();
  }
});

test.describe("Admin role sidebar and command palette", () => {
  test.beforeAll(async () => {
    await seedUser({
      name: "Sidebar Admin",
      email: ADMIN_EMAIL,
      role: "Admin",
    });
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN_EMAIL);
  });

  test("renders all 9 workspace and admin links and full admin nav", async ({ page }) => {
    const sidebar = page.locator("aside");
    // Workspace + admin links, exact presence
    await expect(sidebar.getByRole("link", { name: "Home", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Ask AI", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Agent Board", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Wiki", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Users", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Roles", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Permissions", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Storage", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "LLM Providers", exact: true })).toBeVisible();

    // Admin nav structure: visible with exactly 5 links (Users, Roles,
    // Permissions, Storage, LLM Providers)
    const adminNav = page.locator("aside nav[aria-label='Admin']");
    await expect(adminNav).toBeVisible();
    await expect(adminNav.getByRole("link")).toHaveCount(5);
    await expect(adminNav.getByRole("link", { name: "Users", exact: true })).toBeVisible();
    await expect(adminNav.getByRole("link", { name: "Roles", exact: true })).toBeVisible();
    await expect(adminNav.getByRole("link", { name: "Permissions", exact: true })).toBeVisible();
    await expect(adminNav.getByRole("link", { name: "Storage", exact: true })).toBeVisible();

    // Watching section
    await assertWatchingSection(page);
  });

  test("command palette contains exact admin item set (15 items)", async ({ page }) => {
    await assertCommandPalette(page, EXPECTED_ITEMS.admin);
  });
});

test.describe("Editor role sidebar and command palette", () => {
  test.beforeAll(async () => {
    await seedUser({
      name: "Sidebar Editor",
      email: EDITOR_EMAIL,
      role: "Editor",
    });
  });

  test.beforeEach(async ({ page }) => {
    await login(page, EDITOR_EMAIL);
  });

  test("renders workspace links + Users and Providers links, but zero Roles, Permissions or Storage links", async ({ page }) => {
    const sidebar = page.locator("aside");
    // Workspace links visible (Wiki included — editor holds wiki.view)
    await expect(sidebar.getByRole("link", { name: "Home", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Ask AI", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Agent Board", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Wiki", exact: true })).toBeVisible();

    // Users link visible, Roles/Permissions/Storage absent
    await expect(sidebar.getByRole("link", { name: "Users", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Roles", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Permissions", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Storage", exact: true })).toHaveCount(0);
    // Editor holds providers.view (seed), so it sees the registry but NOT the
    // Roles/Permissions/Storage admin pages.
    await expect(sidebar.getByRole("link", { name: "LLM Providers", exact: true })).toBeVisible();

    // Admin nav structure: exactly 2 links (Users, LLM Providers) plus the label
    const adminNav = page.locator("aside nav[aria-label='Admin']");
    await expect(adminNav).toBeVisible();
    await expect(adminNav.getByRole("link")).toHaveCount(2);
    await expect(adminNav.getByRole("link", { name: "Users", exact: true })).toBeVisible();
    await expect(adminNav).toContainText("Admin");

    // Watching section
    await assertWatchingSection(page);
  });

  test("command palette contains exact editor item set (12 items)", async ({ page }) => {
    await assertCommandPalette(page, EXPECTED_ITEMS.editor);
  });
});

test.describe("Member role sidebar and command palette", () => {
  test.beforeAll(async () => {
    await seedUser({
      name: "Sidebar Member",
      email: MEMBER_EMAIL,
      role: "Member",
    });
  });

  test.beforeEach(async ({ page }) => {
    await login(page, MEMBER_EMAIL);
  });

  test("renders workspace links only, with no Admin nav section or admin links", async ({ page }) => {
    const sidebar = page.locator("aside");
    // Workspace links visible (Wiki included — member holds wiki.view)
    await expect(sidebar.getByRole("link", { name: "Home", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Ask AI", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Agent Board", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Wiki", exact: true })).toBeVisible();

    // Admin links completely absent
    await expect(sidebar.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Roles", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Permissions", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Storage", exact: true })).toHaveCount(0);

    // Admin nav section has count 0 entirely
    await expect(page.locator("aside nav[aria-label='Admin']")).toHaveCount(0);

    // Watching section
    await assertWatchingSection(page);
  });

  test("command palette contains exact member item set (10 items)", async ({ page }) => {
    await assertCommandPalette(page, EXPECTED_ITEMS.member);
  });
});
