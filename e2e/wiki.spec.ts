import { expect, test } from "@playwright/test";
import {
  cleanupE2EFixtures,
  closeDbPool,
  login,
  seedUser,
} from "./helpers";

/**
 * Wiki round-trip at the browser altitude (the wiki initiative's story 3.3
 * follow-up): an admin creates a page, a label, writes a paragraph, saves and
 * comments; a member then finds the page, reads it, and is offered none of the
 * edit affordances — the UI hides what the API would 403.
 *
 * No S3 exists in this harness, so the unconfigured-storage contract is
 * asserted AS the happy path: the upload buttons render disabled with the
 * storage hint, the attachments panel explains why, and the page still saves.
 */

const ADMIN_EMAIL = "wiki-admin@e2e.test";
const MEMBER_EMAIL = "wiki-member@e2e.test";

// Unique per run — the scratch DB dies with the run, but titles from a
// retried test must not collide with a previous attempt's rows.
const STAMP = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const PAGE_TITLE = `E2E Runbook ${STAMP}`;
const PARAGRAPH = `The runbook lives here. Written by the e2e suite (${STAMP}).`;
const LABEL_NAME = `e2e-label-${STAMP}`;
const COMMENT_BODY = `First remark from the admin suite (${STAMP}).`;

/** /wiki/<uuid> of the page the admin test creates — the member test reads it. */
let createdPagePath = "";

test.describe("admin: create page, label, paragraph, comment", () => {
  test.beforeAll(async () => {
    await seedUser({ name: "Wiki Admin", email: ADMIN_EMAIL, role: "Admin" });
  });

  test.afterAll(async () => {
    // Admin only — the member describe below seeds and cleans its own user
    // (a describe's afterAll runs before the next describe's tests).
    try {
      await cleanupE2EFixtures({ emails: [ADMIN_EMAIL] });
    } finally {
      await closeDbPool();
    }
  });

  test("creates an Untitled page immediately without a title dialog", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/wiki");

    await expect(page.getByRole("heading", { name: "Wiki pages" })).toBeVisible();

    await page.getByRole("button", { name: "New page" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect(page).toHaveURL(new RegExp(`/wiki/[0-9a-f-]{36}\\?edit=true$`));
    createdPagePath = new URL(page.url()).pathname;
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue("Untitled");
    await expect(page.getByRole("group", { name: "Formatting", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "All pages" })).toHaveCount(0);
    for (const name of ["Save", "Cancel", "Preview", "Copy link", "Delete"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
  });

  test("edit mode: uploads disabled with a hint while the page stays editable", async ({ page }) => {
    test.skip(!createdPagePath, "previous test did not run");
    await login(page, ADMIN_EMAIL);
    await page.goto(createdPagePath);

    // Existing pages open directly in edit mode for users with update permission.
    await expect(page.getByLabel("Page title", { exact: true })).toBeVisible();

    // The unconfigured-storage contract: buttons disabled, reason visible —
    // and crucially the editor itself is NOT disabled.
    const toolbar = page.getByRole("group", { name: "Selection formatting", exact: true });
    await expect(toolbar).not.toBeVisible();
    await page.locator(".ProseMirror").fill(PARAGRAPH);
    await page.keyboard.press("ControlOrMeta+a");
    await expect(toolbar).toBeVisible();
    await page.keyboard.press("Alt+F10");
    await expect(toolbar.getByLabel("Text style", { exact: true })).toBeFocused();
    await toolbar.getByLabel("More formatting options", { exact: true }).click();
    await expect(toolbar.getByRole("button", { name: "Insert image (storage not configured)" })).toBeDisabled();
    await expect(toolbar.getByRole("button", { name: "Attach file (storage not configured)" })).toBeDisabled();
    await expect(toolbar.getByRole("button", { name: "Insert image (storage not configured)" }))
      .toHaveAttribute("title", "Storage is not configured, so uploads are disabled");
    await toolbar.getByLabel("More formatting options", { exact: true }).click();
    await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
    await expect(page.locator(".ProseMirror strong")).toContainText(PARAGRAPH);

    // Rename the default title in the editor; creation never asks for it.
    await page.getByLabel("Page title", { exact: true }).fill(PAGE_TITLE);

    // Storage being absent never blocks writing.
    await page.locator(".ProseMirror").fill(PARAGRAPH);

    // Slash menu: "/todo" filters the block options, Enter inserts a to-do
    // list with a real checkbox the keystrokes then fill in.
    await page.keyboard.press("Enter");
    await page.keyboard.type("/todo");
    await expect(page.getByRole("option").filter({ hasText: "To-do list" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator('.ProseMirror input[type="checkbox"]')).toHaveCount(1);
    await page.keyboard.type("Ship the runbook");

    // The reference starts with the details pane closed.
    await page.getByRole("button", { name: "Show details panel", exact: true }).click();
    // Label taxonomy lives in the right pane's Info tab.
    await page.getByRole("tab", { name: "Info", exact: true }).click();
    await page.getByLabel("New label name").fill(LABEL_NAME);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(LABEL_NAME).first()).toBeVisible();

    // Poll persistence, not a transient toast: title, body, and labels all autosave.
    await expect.poll(async () => {
      const response = await page.request.get(`/api/wiki/pages/${createdPagePath.split("/").pop()}`);
      const { page: saved } = await response.json();
      return saved.title === PAGE_TITLE && JSON.stringify(saved.content).includes("Ship the runbook")
        && saved.labels.some((label: { name: string }) => label.name === LABEL_NAME);
    }).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(PAGE_TITLE);
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
    await page.getByRole("tab", { name: "Info", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: `Label ${LABEL_NAME}`, exact: true })).toBeChecked();

    // Reload retains the saved document and leaves it editable.
    await expect(page.locator(".wiki-prose")).toContainText(PARAGRAPH);
    // Attachments live behind the pane's Assets tab.
    await page.getByRole("tab", { name: "Assets", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Attachments" })).toBeVisible();
    await expect(
      page.getByText(
        "No files attached. Uploads are disabled until an administrator configures storage."
      )
    ).toBeVisible();
  });

  test("comments: the admin remark appears with the session's author", async ({ page }) => {
    test.skip(!createdPagePath, "previous test did not run");
    await login(page, ADMIN_EMAIL);
    await page.goto(createdPagePath);

    // Comments live behind the pane's Comments tab.
    await page.getByRole("button", { name: "Show details panel", exact: true }).click();
    await page.getByRole("tab", { name: /Comments/ }).click();
    await page.getByLabel("Write a comment").fill(COMMENT_BODY);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
    // Scope to the row: a bare getByText("Wiki Admin") also matches the
    // sidebar's hidden user chip.
    const row = page.locator("li", { hasText: COMMENT_BODY });
    await expect(row).toBeVisible();
    await expect(row.getByText("Wiki Admin")).toBeVisible();
  });
});

test.describe("member: reads the page, offered none of the edit affordances", () => {
  test.beforeAll(async () => {
    await seedUser({ name: "Wiki Member", email: MEMBER_EMAIL, role: "Member" });
  });

  test.afterAll(async () => {
    try {
      await cleanupE2EFixtures({ emails: [MEMBER_EMAIL] });
    } finally {
      // No-op if the admin describe's afterAll already closed the shared pool.
      await closeDbPool();
    }
  });

  test("finds the page in the list and opens it", async ({ page }) => {
    test.skip(!createdPagePath, "admin suite did not create the page");
    await login(page, MEMBER_EMAIL);
    await page.goto("/wiki");

    // Search narrows the flat list to the created page (collapsed → expand).
    await page.getByRole("button", { name: "Search pages" }).click();
    await page.getByLabel("Search pages by title").fill(`E2E Runbook ${STAMP}`);
    const row = page.getByRole("link", { name: PAGE_TITLE, exact: true });
    await expect(row).toBeVisible();
    await row.click();

    await expect(page).toHaveURL(createdPagePath);
    // The member can read everything the admin wrote.
    await expect(page.locator(".wiki-prose")).toContainText(PARAGRAPH);
    await page.getByRole("button", { name: "Show details panel", exact: true }).click();
    await page.getByRole("tab", { name: "Info", exact: true }).click();
    await expect(page.getByText(LABEL_NAME).first()).toBeVisible();
    await page.getByRole("tab", { name: /Comments/ }).click();
    await expect(page.getByText(COMMENT_BODY)).toBeVisible();
  });

  test("no edit, delete, toolbar, comment box, or moderation controls render", async ({ page }) => {
    test.skip(!createdPagePath, "admin suite did not create the page");
    await login(page, MEMBER_EMAIL);
    await page.goto(createdPagePath);

    await expect(page.locator(".wiki-prose")).toContainText(PARAGRAPH);

    // Everything the API would 403 is absent, not merely hidden.
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Formatting" })).toHaveCount(0);
    await expect(page.getByLabel("Write a comment")).toHaveCount(0);
    // Someone else's comment: no author retraction, no moderation button.
    await expect(
      page.getByRole("button", { name: "Delete comment by Wiki Admin" })
    ).toHaveCount(0);
  });

  test("deep link to /storage renders the in-app 403", async ({ page }) => {
    await login(page, MEMBER_EMAIL);

    const storageHits: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/storage")) storageHits.push(request.url());
    });

    await page.goto("/storage");
    await expect(
      page.getByRole("heading", { name: "You don't have access to this page" })
    ).toBeVisible();
    // Scoped to main: during the streamed hydration the 403 view can exist in
    // both the static shell and the streamed body for a frame.
    await expect(page.getByRole("main").getByText("403", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText(/View storage settings/)).toBeVisible();

    // The server gate ran before any settings read: nothing left the browser.
    expect(storageHits).toHaveLength(0);
  });
});
