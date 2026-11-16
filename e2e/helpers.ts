import bcrypt from "bcryptjs";
import pg, { type Pool } from "pg";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  baseConnectionString,
  scratchConnectionString,
} from "../scripts/test-db.mjs";

/**
 * Shared test helpers for E2E specs (epic 3 story 3).
 *
 * All database operations go directly to this run's scratch database derived by
 * playwright.config.ts and created by scripts/e2e-server.mjs. The dev database
 * is never touched.
 */

export const E2E_PASSWORD = "password123";

/**
 * Reconstruct the run's scratch database URL. Fails loudly if E2E_SCRATCH_DB_NAME
 * is unset so tests never accidentally fall back to the dev database.
 */
export function scratchUrl(): string {
  const name = process.env.E2E_SCRATCH_DB_NAME;
  if (!name) {
    throw new Error(
      "E2E_SCRATCH_DB_NAME is not set — e2e specs must run through `npm run test:e2e` with a derived scratch DB"
    );
  }
  return scratchConnectionString(baseConnectionString(), name);
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    // max: 1 — seeds and fixture cleanups are sequential per worker.
    pool = new pg.Pool({ connectionString: scratchUrl(), max: 1 });
  }
  return pool;
}

export async function closeDbPool(): Promise<void> {
  const closing = pool;
  pool = null;
  if (closing) {
    await closing.end().catch(() => {});
  }
}

export interface SeedUserInput {
  name: string;
  email: string;
  role: string;
}

/**
 * Seed a user directly into the scratch database with bcrypt cost 10.
 * Idempotent: ON CONFLICT (email) DO NOTHING.
 */
export async function seedUser(user: SeedUserInput): Promise<void> {
  const passwordHash = bcrypt.hashSync(E2E_PASSWORD, 10);
  await getPool().query(
    `INSERT INTO users (name, email, password_hash, role, team, status)
     VALUES ($1, $2, $3, $4, 'General', 'Active')
     ON CONFLICT (email) DO NOTHING`,
    [user.name, user.email, passwordHash, user.role]
  );
}

/**
 * Log in as a user via the UI and wait until redirected to the root dashboard.
 *
 * A login that silently stays on `/login` makes every downstream assertion
 * report "element(s) not found", which reads like a product bug in whatever
 * the test was actually about. When the redirect does not happen, the message
 * therefore carries the final URL and the visible error text, so the cause is
 * in the failure rather than in a later locator timeout.
 */
export async function login(
  page: Page,
  email: string,
  password = E2E_PASSWORD
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await expect(page).toHaveURL(/\/$/)
  } catch {
    // Best-effort context: whatever the page says about why it is still here.
    const visible = await page
      .locator("body")
      .innerText()
      .then(text => text.replace(/\s+/g, " ").trim().slice(0, 300))
      .catch(() => "<body unavailable>")
    throw new Error(
      `E2E login failed for ${email}: still at ${page.url()}, expected /. ` +
        `Visible page text: ${visible}`,
    )
  }
}

/**
 * Clean up suite fixtures from the scratch database.
 * Deletes users first, then roles, respecting the users_role_fkey constraint.
 */
export async function cleanupE2EFixtures(options: {
  emails?: readonly string[];
  roleKeys?: readonly string[];
}): Promise<{ deletedUsers: number; deletedRoles: number }> {
  const db = getPool();
  let deletedUsers = 0;
  let deletedRoles = 0;

  if (options.emails && options.emails.length > 0) {
    const res = await db.query(
      `DELETE FROM users WHERE email = ANY($1)`,
      [options.emails]
    );
    deletedUsers = res.rowCount ?? 0;
  }

  if (options.roleKeys && options.roleKeys.length > 0) {
    const res = await db.query(
      `DELETE FROM roles WHERE key = ANY($1)`,
      [options.roleKeys]
    );
    deletedRoles = res.rowCount ?? 0;
  }

  return { deletedUsers, deletedRoles };
}
