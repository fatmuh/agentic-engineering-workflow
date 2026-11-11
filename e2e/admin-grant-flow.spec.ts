import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  cleanupE2EFixtures,
  closeDbPool,
  E2E_PASSWORD,
  login,
  seedUser,
} from "./helpers";

/**
 * End-to-end admin grant and revocation flow (epic 3 story 3).
 *
 * Verifies the full administrative loop across two isolated browser contexts:
 *   1. Admin creates custom role "E2E Reviewer" (metadata sheet), then grants
 *      [View Home, View users] for it on /permissions
 *   2. Admin adds a second user assigned to "E2E Reviewer" via the UI
 *   3. Second user logs in (Context B) and accesses /users successfully
 *   4. Admin toggles an additional grant ("View Watching") on /permissions
 *   5. The grant persists: /permissions still shows it checked, /roles the user
 *   6. Admin revokes "View users" from the role on /permissions
 *   7. Second user's next /api/users request immediately answers 403 (fresh
 *      server-side resolution) while their client state remains stale
 *   8. Second user catches up upon window focus (PermissionProvider me-refetch):
 *      Users sidebar link vanishes and /users flips to ForbiddenView
 *
 * Teardown deletes suite-created users and roles via SQL (≥1 user and ≥1 role).
 */

test.describe.configure({ mode: "serial" });

const ADMIN_EMAIL = "admin-flow@e2e.test";
const SECOND_USER_EMAIL = "reviewer-flow@e2e.test";
const ROLE_KEY = "e2e-reviewer";

let contextA: BrowserContext;
let pageA: Page;
let contextB: BrowserContext;
let pageB: Page;

test.describe("Admin role lifecycle and grant revocation flow", () => {
  test.beforeAll(async ({ browser }) => {
    await seedUser({
      name: "Admin Flow User",
      email: ADMIN_EMAIL,
      role: "Admin",
    });
    contextA = await browser.newContext();
    pageA = await contextA.newPage();
    await login(pageA, ADMIN_EMAIL);
  });

  test.afterAll(async () => {
    await contextB?.close().catch(() => {});
    await contextA?.close().catch(() => {});

    try {
      const { deletedUsers, deletedRoles } = await cleanupE2EFixtures({
        emails: [SECOND_USER_EMAIL, ADMIN_EMAIL],
        roleKeys: [ROLE_KEY],
      });

      expect(deletedUsers).toBeGreaterThanOrEqual(1);
      expect(deletedRoles).toBeGreaterThanOrEqual(1);
    } finally {
      await closeDbPool();
    }
  });

  test("1. Admin creates custom role 'E2E Reviewer', then grants View Home and View users", async () => {
    await pageA.goto("/roles");

    // The create sheet collects metadata only — grants are managed on /permissions.
    await pageA.getByRole("button", { name: "New role" }).click();
    await expect(pageA.getByRole("heading", { name: "Create a role" })).toBeVisible();

    const createSheet = pageA.getByRole("dialog");
    await createSheet.getByLabel("Name", { exact: true }).fill("E2E Reviewer");
    await createSheet.getByLabel("Description", { exact: true }).fill("Custom reviewer role for E2E tests");

    await pageA.getByRole("button", { name: "Create role" }).click();
    await expect(pageA.getByText(/Created E2E Reviewer/i)).toBeVisible();

    const roleRow = pageA.getByRole("row").filter({ hasText: ROLE_KEY });
    await expect(roleRow).toBeVisible();
    await expect(roleRow.getByRole("cell").nth(3)).toHaveText("0");

    // Grant the starting set on /permissions (deep-linked to the new role).
    await pageA.goto(`/permissions?role=${ROLE_KEY}`);
    const homeCheckbox = pageA.getByRole("checkbox", { name: "View Home for E2E Reviewer", exact: true });
    await homeCheckbox.click();
    await expect(homeCheckbox).toBeChecked();

    const usersCheckbox = pageA.getByRole("checkbox", { name: "View users for E2E Reviewer", exact: true });
    await usersCheckbox.click();
    await expect(usersCheckbox).toBeChecked();

    const saveButton = pageA.getByRole("button", { name: "Save permissions" });
    await saveButton.click();
    await expect(pageA.getByText("Permissions updated for E2E Reviewer")).toBeVisible();
    await expect(saveButton).toBeDisabled();
  });

  test("2. Admin creates second user assigned to that role via /users UI", async () => {
    await pageA.goto("/users");

    await pageA.getByRole("button", { name: "Add user" }).click();
    await expect(pageA.getByRole("heading", { name: "Add user" })).toBeVisible();

    await pageA.locator("#add-user-name").fill("Second Reviewer");
    await pageA.locator("#add-user-email").fill(SECOND_USER_EMAIL);
    await pageA.locator("#add-user-password").fill(E2E_PASSWORD);

    // Open role Select and pick E2E Reviewer
    await pageA.locator('[aria-labelledby="add-user-role-label"]').click();
    const roleOption = pageA.getByRole("option", { name: /E2E Reviewer/ });
    await expect(roleOption).toBeVisible();
    await roleOption.click();

    await pageA.getByRole("button", { name: "Add user", exact: true }).click();

    const userRow = pageA.getByRole("row").filter({ hasText: SECOND_USER_EMAIL });
    await expect(userRow).toBeVisible();
  });

  test("3. Second user logs in (Context B) and accesses /users successfully", async ({ browser }) => {
    contextB = await browser.newContext();
    pageB = await contextB.newPage();

    await login(pageB, SECOND_USER_EMAIL);

    const usersLink = pageB.locator("aside").getByRole("link", { name: "Users", exact: true });
    await expect(usersLink).toBeVisible();

    await usersLink.click();
    await expect(pageB.getByRole("heading", { name: "Users directory" })).toBeVisible();
  });

  test("4. Admin adds 'View Watching' grant to role on /permissions", async () => {
    await pageA.goto("/permissions");

    await pageA.getByRole("button", { name: "Filter by role" }).click();
    await pageA.getByRole("dialog", { name: "Filter permissions by role" })
      .getByRole("checkbox", { name: "E2E Reviewer", exact: true }).click();
    await pageA.keyboard.press("Escape");

    await expect(pageA.getByRole("columnheader", { name: /E2E Reviewer/ })).toBeVisible();
    await expect(pageA.getByText("Custom role", { exact: true })).toBeVisible();

    const watchingCheckbox = pageA.getByRole("checkbox", { name: "View Watching for E2E Reviewer", exact: true });
    await watchingCheckbox.click();
    await expect(watchingCheckbox).toBeChecked();

    const saveButton = pageA.getByRole("button", { name: "Save permissions" });
    await saveButton.click();

    await expect(pageA.getByText("Permissions updated for E2E Reviewer")).toBeVisible();
    await expect(watchingCheckbox).toBeChecked();
    await expect(saveButton).toBeDisabled();
  });

  test("5. Grant persists: /permissions keeps it checked and /roles shows the assigned user", async () => {
    await pageA.goto(`/permissions?role=${ROLE_KEY}`);
    await expect(
      pageA.getByRole("checkbox", { name: "View Watching for E2E Reviewer", exact: true })
    ).toBeChecked();

    await pageA.goto("/roles");
    const roleRow = pageA.getByRole("row").filter({ hasText: ROLE_KEY });
    await expect(roleRow).toBeVisible();
    await expect(roleRow.getByRole("cell").nth(3)).toHaveText("1");
  });

  test("6. Admin revokes 'View users' from role on /permissions", async () => {
    await pageA.goto("/permissions");

    await pageA.getByRole("button", { name: "Filter by role" }).click();
    await pageA.getByRole("dialog", { name: "Filter permissions by role" })
      .getByRole("checkbox", { name: "E2E Reviewer", exact: true }).click();
    await pageA.keyboard.press("Escape");

    const usersCheckbox = pageA.getByRole("checkbox", { name: "View users for E2E Reviewer", exact: true });
    await expect(usersCheckbox).toBeChecked();
    await usersCheckbox.click();
    await expect(usersCheckbox).not.toBeChecked();

    const saveButton = pageA.getByRole("button", { name: "Save permissions" });
    await saveButton.click();

    await expect(pageA.getByText("Permissions updated for E2E Reviewer")).toBeVisible();
    await expect(usersCheckbox).not.toBeChecked();
    await expect(saveButton).toBeDisabled();

    // The revoked grant stays revoked on a fresh load.
    await pageA.goto(`/permissions?role=${ROLE_KEY}`);
    await expect(
      pageA.getByRole("checkbox", { name: "View users for E2E Reviewer", exact: true })
    ).not.toBeChecked();
  });

  test("7. Second user gets immediate 403 on /api/users while client UI remains stale", async () => {
    // Context B is untouched and unfocused on /users.
    // Server resolves permissions fresh per request -> 403 on next fetch.
    await expect
      .poll(async () =>
        pageB.evaluate(async () => {
          const res = await fetch("/api/users");
          return res.status;
        })
      )
      .toBe(403);

    // Stale client state: Users link and Users directory heading still visible
    await expect(pageB.locator("aside").getByRole("link", { name: "Users", exact: true })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "Users directory" })).toBeVisible();
  });

  test("8. Second user catches up on window focus: Users link gone, /users flips to 403", async () => {
    // Dispatch synthetic focus event (PermissionProvider me-refetch trigger)
    await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));

    // Users link disappears from sidebar
    await expect(pageB.locator("aside").getByRole("link", { name: "Users", exact: true })).toHaveCount(0);

    // /users view flips to ForbiddenView
    await expect(
      pageB.getByRole("heading", { name: "You don't have access to this page" })
    ).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "Users directory" })).toHaveCount(0);
  });
});
