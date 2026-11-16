import { defineConfig, devices } from "@playwright/test";
import {
  baseConnectionString,
  deriveScratchDbName,
  scratchConnectionString,
} from "./scripts/test-db.mjs";

/**
 * E2E harness config (epic 3 story 1).
 *
 * The scratch database name is derived ONCE here, at config-evaluation scope —
 * the single source of truth for the whole run. Every other consumer reads the
 * derivation through env, never by deriving again in another process:
 *
 *   - the webServer boot script (scripts/e2e-server.mjs) receives it via
 *     webServer.env and creates the database BEFORE `next start` accepts
 *     requests (playwright starts the webServer before globalSetup, and the
 *     app's query() → ensureSchema() seeds roles on the first request);
 *   - globalTeardown (e2e/global-teardown.ts) reads it from process.env, which
 *     this module sets below — config and globalTeardown run in the same
 *     playwright runner process.
 *
 * DATABASE_URL is rewritten to the scratch database by swapping only the
 * database segment of the base string, so the dev database is never a target.
 */
const PORT = Number(process.env.E2E_PORT || 4311); // 3010/3011 are dev servers
const baseURL = `http://127.0.0.1:${PORT}`;

const base = baseConnectionString();
const scratchDbName = process.env.E2E_SCRATCH_DB_NAME || deriveScratchDbName();
const scratchUrl = scratchConnectionString(base, scratchDbName);

// One derivation, published to every consumer in this process (globalTeardown).
process.env.E2E_SCRATCH_DB_NAME = scratchDbName;

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  // Waits until the schema bootstrap has COMMITTED (it is one transaction since
  // D-1, so nothing is visible to the specs' own pool until then). Playwright's
  // webServer readiness is only GET /login, which does not touch the database.
  globalSetup: "./e2e/global-setup.ts",
  reporter: [["list"]],
  use: { baseURL },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `${baseURL}/login`,
    timeout: 180_000,
    // Never reuse: a leftover server on the port (e.g. an orphaned `next start`
    // from a hard-killed run) would silently serve a dead run's stale scratch
    // database — skipping the boot script means no fresh per-run database, and
    // the next sweep FORCE-drops that database under the live orphan. Failing
    // loudly (EADDRINUSE → "next exited during boot") beats a silently stale
    // run, and matches the CI semantics this config already assumes.
    reuseExistingServer: false,
    env: {
      ...process.env,
      DATABASE_URL: scratchUrl,
      E2E_BASE_DATABASE_URL: base,
      E2E_SCRATCH_DB_NAME: scratchDbName,
      E2E_PORT: String(PORT),
    },
  },
});
