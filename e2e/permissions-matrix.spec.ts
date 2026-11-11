import { expect, test } from "@playwright/test";
import { cleanupE2EFixtures, closeDbPool, getPool, login, seedUser } from "./helpers";

const ADMIN = "matrix-admin-ui@e2e.test";
const READER = "matrix-reader-ui@e2e.test";
const ROLE = "e2e-matrix-designer";
const READER_ROLE = "e2e-matrix-reader";
const ROLE_NAME = "Matrix Designer";

test.beforeAll(async () => {
  const db = getPool();
  await db.query(
    `INSERT INTO roles (key, name, description, permissions, is_system)
     VALUES ($1, $2, '', $3::jsonb, false), ($4, 'Matrix Reader', '', '["roles.view"]'::jsonb, false)
     ON CONFLICT (key) DO NOTHING`,
    [ROLE, ROLE_NAME, JSON.stringify(["home.view", "wiki.*"]), READER_ROLE]
  );
  await seedUser({ name: "Matrix UI Admin", email: ADMIN, role: "Admin" });
  await seedUser({ name: "Matrix UI Reader", email: READER, role: READER_ROLE });
});

test.afterAll(async () => {
  try {
    await cleanupE2EFixtures({ emails: [ADMIN, READER], roleKeys: [ROLE, READER_ROLE] });
  } finally {
    await closeDbPool();
  }
});

test("compares roles in columns with resource groups and read-only own-role states", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/permissions");
  await expect(page.getByRole("heading", { name: "Team & permissions" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Team administration" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter by role" })).toHaveText("All roles");
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: /Matrix Designer/ })).toBeVisible();
  const adminCell = table.locator('[data-permission="wiki.view"] td[data-role-key="Admin"]');
  await expect(adminCell).toContainText("Allowed. Your role");
  await expect(adminCell.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "View Wiki for Matrix Designer", exact: true })).toBeChecked();
  await page.getByRole("searchbox", { name: "Search permissions" }).fill("no-such-permission");
  await expect(page.getByRole("heading", { name: /No permissions match/ })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("checkbox", { name: "View Wiki for Matrix Designer", exact: true })).toBeVisible();
});

test("keeps drafts across filters and discards without saving", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto(`/permissions?role=${ROLE}`);
  const checkbox = page.getByRole("checkbox", { name: "View Watching for Matrix Designer", exact: true });
  await expect(checkbox).not.toBeChecked();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(page.getByText("Unsaved changes in 1 role", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Filter by role" }).click();
  const filter = page.getByRole("dialog", { name: "Filter permissions by role" });
  await filter.getByRole("checkbox", { name: ROLE_NAME, exact: true }).click();
  await filter.getByRole("checkbox", { name: "Member", exact: true }).click();
  await expect(checkbox).toHaveCount(0);
  await filter.getByRole("checkbox", { name: "Member", exact: true }).click();
  await filter.getByRole("checkbox", { name: ROLE_NAME, exact: true }).click();
  await filter.getByRole("checkbox", { name: "Member", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: /Matrix Designer/ })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /^Member\b/ })).toBeVisible();
  await filter.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Filter by role" })).toHaveText("All roles");
  await expect(checkbox).toBeChecked();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Save permissions" })).toBeDisabled();
});

test("network failure preserves the draft and offers a retry", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto(`/permissions?role=${ROLE}`);
  await page.route(`**/api/roles/${ROLE}/permissions`, (route) => route.abort("failed"));
  const checkbox = page.getByRole("checkbox", { name: "View Watching for Matrix Designer", exact: true });
  await checkbox.check();
  await page.getByRole("button", { name: "Save permissions" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not save permissions" })).toContainText("Unsaved changes are kept");
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole("button", { name: "Save permissions" })).toBeEnabled();
});

test("view-only role can compare but cannot change permissions", async ({ page }) => {
  await login(page, READER);
  await page.goto("/permissions");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText(/Ask someone with Manage roles/)).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save permissions" })).toHaveCount(0);
});

test("fits 320px and keeps the wide comparison inside its scroll region", async ({ page }) => {
  await login(page, ADMIN);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/permissions");
  await expect(page.getByRole("heading", { name: "Team & permissions" })).toBeVisible();
  const region = page.getByRole("region", { name: "Role permissions comparison" });
  await expect(region).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(page.getByText("Scroll horizontally to compare all roles ↔")).toBeVisible();
  await page.screenshot({ path: "/tmp/permissions-matrix-mobile.png", fullPage: true });
});

test("keeps row and column context visible while scrolling and mirrors in RTL", async ({ page }) => {
  await login(page, ADMIN);
  await page.setViewportSize({ width: 640, height: 500 });
  await page.goto("/permissions");
  const region = page.getByRole("region", { name: "Role permissions comparison" });
  await region.evaluate((el) => { el.scrollTop = 500; });
  const header = region.locator("thead");
  const bounds = await region.boundingBox();
  const headerBounds = await header.boundingBox();
  expect(headerBounds!.y).toBeGreaterThanOrEqual(bounds!.y);
  expect(headerBounds!.y).toBeLessThan(bounds!.y + 5);
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  expect(await region.locator(".permissions-name-column").first().evaluate((el) => getComputedStyle(el).right)).not.toBe("auto");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("renders light and dark themes with keyboard focus and sufficient secondary-text contrast", async ({ page }) => {
  await login(page, ADMIN);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/permissions");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    const checkbox = page.getByRole("checkbox", { name: "View Watching for Matrix Designer", exact: true });
    await checkbox.focus();
    const focus = await checkbox.evaluate((el) => getComputedStyle(el.closest("label")!).outlineStyle);
    expect(focus).not.toBe("none");
    await page.getByRole("region", { name: "Role permissions comparison" }).evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/permissions-matrix-${theme}.png`, fullPage: true });
    // Convert modern color-mix values to sRGB through the canvas to measure
    // the actual composited foreground/background, not guessed token values.
    const ratio = await page.locator(".permissions-group-row th").first().evaluate((el) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      const rgb = (value: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      const luminance = (value: string) => rgb(value).reduce((sum, channel, i) => {
        const c = channel / 255;
        return sum + [0.2126, 0.7152, 0.0722][i] * (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
      }, 0);
      const style = getComputedStyle(el);
      const a = luminance(style.color);
      const b = luminance(style.backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});
