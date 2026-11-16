#!/usr/bin/env node
/**
 * Playwright `webServer.command` target — boots the production server against
 * this run's scratch database.
 *
 * Why this script (and not globalSetup) creates the database: playwright starts
 * the webServer BEFORE globalSetup, and the app's `query()` runs
 * `ensureSchema()` (which seeds the roles) on the first request — a database
 * created later is too late. Creation therefore happens here, inside the boot
 * path, before `next start` accepts any request. The harness only creates and
 * drops the database; the app's own boot path does all schema/seed work.
 *
 * Everything the run needs arrives via env from playwright.config.ts, where the
 * scratch name is derived ONCE for the whole run (never re-derived here):
 *   E2E_SCRATCH_DB_NAME    bare scratch database name
 *   DATABASE_URL           connection string already rewritten to the scratch db
 *   E2E_BASE_DATABASE_URL  the base string — admin target for CREATE/DROP
 *   E2E_PORT               harness port (default 4311; 3010/3011 are dev servers)
 *
 * Usage: started by playwright (webServer.command) — or `npm run test:e2e` /
 * `npm run verify`, which chain the required production build first.
 *
 * All harness logging goes to stderr: playwright swallows webServer stdout on
 * successful runs, so stderr is the only stream that is always visible.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createScratchDb, dropScratchDb } from "./test-db.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.E2E_PORT || 4311);
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

const scratchName = process.env.E2E_SCRATCH_DB_NAME;
const scratchUrl = process.env.DATABASE_URL;
const baseUrl = process.env.E2E_BASE_DATABASE_URL;

function fail(message) {
  console.error(`[e2e-server] ${message}`);
  process.exit(1);
}

if (!scratchName || !scratchUrl || !baseUrl) {
  fail(
    "missing E2E_SCRATCH_DB_NAME / DATABASE_URL / E2E_BASE_DATABASE_URL — " +
      "start through playwright's webServer (`npm run test:e2e` or `npm run verify`)"
  );
}
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  fail(`invalid E2E_PORT: ${process.env.E2E_PORT}`);
}
if (!existsSync(".next/BUILD_ID")) {
  fail("no production build found (.next/BUILD_ID) — run `npm run build` first, or use `npm run verify`");
}

// 0. Best-effort port pre-check BEFORE touching the database layer. With
//    reuseExistingServer: false, a taken port means this run is doomed to
//    EADDRINUSE — and reaching createScratchDb first would run the
//    stale-database sweep, FORCE-dropping a still-LIVE run's database (e.g. a
//    debug session sitting on page.pause() that has aged past the sweep
//    threshold) before this run dies. Any HTTP answer (any status) means the
//    port is serving; connection refused / timeout means free — proceed.
async function portIsFree() {
  try {
    await fetch(`http://${HOST}:${PORT}/login`, { signal: AbortSignal.timeout(2_000) });
    return false;
  } catch {
    return true;
  }
}
if (!(await portIsFree())) {
  fail(
    `http://${HOST}:${PORT} is already serving — an orphaned or live server holds the port. ` +
      "Kill it (or set E2E_PORT) before starting another run; refusing to touch the database layer."
  );
}

// 1. The database exists before the server accepts its first request.
//    DROP IF EXISTS inside createScratchDb reclaims the name if a prior run
//    died before its teardown.
await createScratchDb({ name: scratchName, base: baseUrl });
console.error(`[e2e-server] scratch database "${scratchName}" created (dev database untouched)`);

// 2. Spawn the production server. Per the fork's docs (node_modules/next/dist/
//    docs .../06-cli/next.md): `next start` takes the port via --port/-p or the
//    PORT env var — which "cannot be set in .env" because the HTTP server boots
//    before env files load — so the port travels as a real flag/env var here.
//    DATABASE_URL is already the scratch string in this process env, and Next
//    never lets .env.local override an existing process variable, so the app
//    cannot fall back to the dev database.
const nextBin = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
const server = spawn(
  process.execPath,
  [nextBin, "start", "--port", String(PORT), "--hostname", HOST],
  { stdio: ["ignore", "inherit", "inherit"], env: process.env }
);

server.on("error", (error) => fail(`failed to start next: ${error.message}`));

// 3. Readiness = /login answers AND a login POST reaches query() — proving the
//    boot's own DB chain (server up, scratch db reachable, ensureSchema() ran:
//    schema created, roles seeded) before this script declares the server
//    usable. Unknown email + well-formed body → 401, which can only happen
//    after the database chain worked; a 500 would mean the scratch db is
//    unreachable or bootstrap failed.
//
//    Note playwright does NOT wait for this probe: it starts tests on its own
//    GET /login url poll. That is safe because every DB-touching request awaits
//    the memoized ensureSchema (src/lib/db.ts `schemaReady` guard), so no
//    request can observe a half-migrated database regardless of when the probe
//    completes. The demo board seed is NOT part of that chain any more: it runs
//    in the background from src/instrumentation.ts at boot, so an e2e test that
//    asserts on seeded demo rows must not assume the seed finished before the
//    first request returns.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isReady() {
  const page = await fetch(`http://${HOST}:${PORT}/login`, { signal: AbortSignal.timeout(5_000) });
  if (!page.ok) return false;
  const probe = await fetch(`http://${HOST}:${PORT}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "e2e-harness@onyx.dev", password: "harness-readiness-probe" }),
    signal: AbortSignal.timeout(10_000),
  });
  return probe.status === 401;
}

let ready = false;
const startedAt = Date.now();
while (Date.now() - startedAt < READY_TIMEOUT_MS) {
  if (server.exitCode !== null) {
    fail(`next exited during boot (code ${server.exitCode}) — see its output above`);
  }
  try {
    if (await isReady()) {
      ready = true;
      break;
    }
  } catch {
    // server not listening yet — keep polling
  }
  await sleep(POLL_MS);
}
if (!ready) {
  server.kill("SIGTERM");
  fail(`server not ready on http://${HOST}:${PORT} within ${READY_TIMEOUT_MS / 1000}s`);
}
console.error(
  `[e2e-server] ready on http://${HOST}:${PORT} — login probe reached the scratch database "${scratchName}" (schema + roles seeded)`
);

// 4. Stay alive as the webServer process; forward signals and the exit code so
//    playwright's teardown of this command also stops `next start`.
let stopping = false;
let exiting = false;
const forward = (signal) => {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGHUP", () => forward("SIGHUP"));

server.on("exit", (code) => {
  if (exiting) return;
  exiting = true;
  // Safety net: if the run was interrupted before globalTeardown could drop
  // the scratch database, drop it here — the server is gone, so its pool no
  // longer holds connections. When teardown already dropped it, this is a
  // silent IF EXISTS no-op. A hard SIGKILL of this script itself is the one
  // path that can still leave an orphan; the next run's boot reaps it once it
  // ages past reapStaleScratchDbs' threshold.
  dropScratchDb({ name: scratchName, base: baseUrl, quiet: true })
    .catch(() => {})
    .finally(() => process.exit(code ?? (stopping ? 0 : 1)));
});

// Keep the event loop alive until the server exits (the interval only holds
// the loop open; process.exit in the exit handler above ends this process).
setInterval(() => {}, 1 << 30);
