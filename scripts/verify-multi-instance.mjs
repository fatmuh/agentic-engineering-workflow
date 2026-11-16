#!/usr/bin/env node
/**
 * Multi-instance bootstrap proof (spec-bmad-hardening story 4 / CAP-1).
 *
 * The failure this verifies is not reachable through one process: it needs
 * several processes calling `ensureSchema()` against ONE empty database at the
 * same moment. Before D-1 that raced inside `CREATE TABLE IF NOT EXISTS` and
 * one boot in eight died on `duplicate key ... pg_type_typname_nsp_index`.
 *
 * What this does:
 *   1. creates TWO empty scratch databases via the shared helpers in
 *      scripts/test-db.mjs (one for the concurrent run, one for the reference);
 *   2. boots the reference database with ONE process;
 *   3. spawns N (default 8, `--processes=N`) child processes that each import
 *      src/lib/db.ts and call `ensureSchema()` against the SAME database, at
 *      the same time — the exact condition D-1 was found in;
 *   4. compares the full schema (columns, constraints, indexes) AND the seed row
 *      counts of the two databases, so "all boots succeeded" cannot be true
 *      merely because they all failed to create the same things, and a seed row
 *      lost or duplicated under concurrency is visible;
 *   5. prints one line per process and exits non-zero if any process failed,
 *      timed out, or produced a different schema or seed state.
 *
 * Why a child process and not an in-process call: `schemaReady` memoizes the
 * bootstrap per module instance, so N calls in one process would run ONE
 * bootstrap. Separate processes are the only way to reproduce the condition.
 * Each child is this same file run with `--worker <url>`, so there is one
 * script to keep correct rather than two that can drift.
 *
 * The child imports the TypeScript source directly, which needs Node's built-in
 * type stripping (default from 22.18/23.6; available behind a flag earlier).
 * That requirement is checked up front with a message that says so — never a
 * half-run.
 *
 * Every run drops both databases, including a failing one and one interrupted
 * with Ctrl-C: `fail()` throws rather than exiting, so the `finally` that drops
 * them always runs, and signal handlers do the same for an interrupt.
 *
 * Usage:
 *   node scripts/verify-multi-instance.mjs            # 8 concurrent boots
 *   node scripts/verify-multi-instance.mjs --processes=4
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MIN_CATALOG_ROWS,
  diffCatalogShapes,
  readCatalogShape,
  readRelationRowCounts,
} from "./catalog-shape.mjs";
import {
  baseConnectionString,
  createScratchDb,
  deriveScratchDbName,
  dropScratchDb,
  loadTestEnv,
  scratchConnectionString,
} from "./test-db.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_MODULE = resolve(repoRoot, "src", "lib", "db.ts");
const DEFAULT_PROCESSES = 8;
/** A typo must not fork hundreds of Node processes. */
const MAX_PROCESSES = 64;
/** The story's minimum: below 4 the check proves nothing it was written for. */
const MIN_PROCESSES = 4;
/** Per-child deadline. A wedged worker must fail the check, not hang it. */
const WORKER_TIMEOUT_MS = 120_000;
/**
 * Relations the bootstrap seeds. Only their ROW COUNTS are compared: a schema
 * dump cannot see a demo project inserted twice, or the three system roles
 * lost, under concurrent starts.
 */
const SEEDED_RELATIONS = ["bmad_projects", "roles"];

// --- worker mode ------------------------------------------------------------
//
// Runs BEFORE the parent code so the child never parses `--processes` and never
// creates databases. It sets DATABASE_URL before the dynamic import because
// db.ts binds the URL at import time (the same constraint the matrix specs
// document), then bootstraps and reports a single JSON line.

const workerIndex = process.argv.indexOf("--worker");
if (workerIndex !== -1) {
  const workerUrl = process.argv[workerIndex + 1];
  if (!workerUrl) {
    // Printing the result line and setting the code is what the parent reads;
    // without a URL there is nothing to dial, so do not attempt one.
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        ms: 0,
        error: "--worker requires a database connection string",
      })}\n`
    );
    process.exitCode = 1;
  } else {
    process.env.DATABASE_URL = workerUrl;
    const startedAt = Date.now();
    let pool = null;
    try {
      const db = await import(pathToFileURL(DB_MODULE).href);
      pool = db.pool;
      await db.ensureSchema();
      process.stdout.write(
        `${JSON.stringify({ ok: true, ms: Date.now() - startedAt })}\n`
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })}\n`
      );
      process.exitCode = 1;
    } finally {
      // Ended on BOTH paths. On success the pool would otherwise hold the
      // process open until its idle timeout; on failure it is worse — the
      // parent waits out that timeout for a process that already answered.
      if (pool) await pool.end().catch(() => {});
    }
  }
}

// --- parent mode ------------------------------------------------------------

if (workerIndex === -1) {
  // `fail()` throws so the cleanup in run()'s `finally` runs; catching it here
  // turns that unwind into an exit status instead of a stack trace. The message
  // itself was already printed by `fail()`, so a usage mistake reads as one
  // line, not a crash.
  await run().catch((error) => {
    if (process.exitCode !== 1) {
      // Not a `fail()` — an unexpected error, whose stack is worth seeing.
      console.error(error);
      process.exitCode = 1;
    }
  });
}

async function run() {
  loadTestEnv();

  if (!process.features.typescript) {
    fail(
      "this script imports src/lib/db.ts directly, which needs Node's built-in " +
        "TypeScript support (default in 22.18+/23.6+). Upgrade Node, or run this " +
        "check on a Node version that has it."
    );
  }

  const processes = parseProcesses(process.argv.slice(2));
  const base = baseConnectionString();
  const concurrentName = deriveScratchDbName();
  const referenceName = siblingScratchName(concurrentName);
  const concurrentUrl = scratchConnectionString(base, concurrentName);
  const referenceUrl = scratchConnectionString(base, referenceName);

  console.log(
    `[multi-instance] ${processes} concurrent boot(s) against "${concurrentName}", ` +
      `reference boot against "${referenceName}"`
  );

  // Registered before any database exists, so a Ctrl-C during setup still ends
  // cleanly. Every child is tracked so an interrupt cannot leave orphans
  // hammering a database that is being dropped underneath them.
  const children = new Set();
  let interrupted = false;
  const onSignal = async (signal) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`[multi-instance] ${signal} received — stopping children and dropping databases`);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await dropAll(base, [concurrentName, referenceName]);
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await createScratchDb({ name: concurrentName, base });
    await createScratchDb({ name: referenceName, base });

    // Reference first and alone: it defines what "the schema" is for this
    // comparison, so it must never share the database with the concurrent run.
    const reference = await bootOnce(referenceUrl, children);
    if (!reference.ok) {
      fail(`reference boot failed: ${reference.error}`);
    }
    console.log(`[multi-instance] reference boot ok in ${reference.ms} ms`);
    const referenceSchema = await readCatalogShape(referenceUrl);
    const referenceCounts = await readRelationRowCounts(referenceUrl, SEEDED_RELATIONS);
    assertNotEmpty(referenceSchema, "reference database");

    // All children are spawned in one tick, so their first `pool.connect()`
    // and their first DDL race for real. `Promise.all` keeps the parent
    // waiting for every one of them, so one failure does not hide another.
    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: processes }, () => bootOnce(concurrentUrl, children))
    );
    const elapsed = Date.now() - startedAt;

    results.forEach((result, index) => {
      const label = `process ${index + 1}/${processes}`;
      if (result.ok) {
        console.log(`[multi-instance] ${label}: ok in ${result.ms} ms`);
      } else {
        console.error(`[multi-instance] ${label}: FAILED after ${result.ms} ms`);
        console.error(`[multi-instance] ${indent(result.error)}`);
      }
    });

    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      fail(
        `${failures.length} of ${processes} concurrent boot(s) failed ` +
          `(wall clock ${elapsed} ms)`
      );
    }

    // Identical schema, not merely "everyone exited 0": a boot that silently
    // skipped every block would also exit 0.
    const concurrentSchema = await readCatalogShape(concurrentUrl);
    assertNotEmpty(concurrentSchema, "concurrently booted database");
    const diff = diffCatalogShapes(referenceSchema, concurrentSchema);
    if (diff.length > 0) {
      console.error("[multi-instance] schema differs from the single boot:");
      for (const line of diff) console.error(`[multi-instance]   ${line}`);
      fail("concurrent boots produced a different schema");
    }

    // Seeded rows survive N concurrent starts exactly once. A duplicated demo
    // project or a lost set of system roles is invisible to a schema dump.
    const concurrentCounts = await readRelationRowCounts(concurrentUrl, SEEDED_RELATIONS);
    if (JSON.stringify(referenceCounts) !== JSON.stringify(concurrentCounts)) {
      console.error(
        `[multi-instance] seed rows differ: reference ${JSON.stringify(referenceCounts)}, ` +
          `concurrent ${JSON.stringify(concurrentCounts)}`
      );
      fail("concurrent boots produced a different seed state");
    }

    console.log(
      `[multi-instance] all ${processes} concurrent boots succeeded in ${elapsed} ms; ` +
        `schema identical to the single boot (${referenceSchema.length} catalog rows) ` +
        `and seed rows identical (${JSON.stringify(referenceCounts)})`
    );
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await dropAll(base, [concurrentName, referenceName]);
  }
}

/** Drop every database named here. Tolerant — a failing run must still clean up. */
async function dropAll(base, names) {
  for (const name of names) {
    await dropScratchDb({ name, base, quiet: true });
  }
}

/** A dump that captured nothing must never be compared to another such dump. */
function assertNotEmpty(shape, label) {
  if (shape.length < MIN_CATALOG_ROWS) {
    fail(
      `${label} has only ${shape.length} catalog rows (expected at least ` +
        `${MIN_CATALOG_ROWS}) — the comparison would be vacuous`
    );
  }
}

/** `--processes=N` or `--processes N`, bounded on both ends. */
function parseProcesses(argv) {
  let value = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--processes=")) {
      value = arg.slice("--processes=".length);
    } else if (arg === "--processes") {
      value = argv[index + 1];
      index += 1;
    }
  }
  if (value === null) return DEFAULT_PROCESSES;
  const processes = Number(value);
  if (!Number.isInteger(processes) || processes < MIN_PROCESSES) {
    fail(`--processes must be an integer >= ${MIN_PROCESSES} (the story's N ≥ 4); got ${value}`);
  }
  if (processes > MAX_PROCESSES) {
    fail(`--processes must not exceed ${MAX_PROCESSES}; got ${value}`);
  }
  return processes;
}

/**
 * A second scratch name that still matches test-db.mjs's reaper pattern
 * (`rbac_test_<pid>_<epoch-ms>`): deriveScratchDbName() is millisecond-based, so
 * two calls in the same tick collide — bump the timestamp instead of inventing
 * a suffix the reaper would never reclaim.
 */
function siblingScratchName(name) {
  return name.replace(/_(\d+)$/, (_match, stamp) => `_${Number(stamp) + 1}`);
}

/**
 * Spawn one worker process and resolve with its single JSON result line.
 *
 * Every exit path clears the deadline: a wedged worker (a blocked bootstrap,
 * a hung pool) is SIGKILLed and reported as a timeout, because a check whose
 * whole job is bounded failure must not hang the CI job it runs in.
 */
function bootOnce(url, children) {
  return new Promise((resolveBoot) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--worker", url],
      {
        cwd: repoRoot,
        // DATABASE_URL is rewritten for a reader that opens this script later;
        // the worker itself reads it from argv, which is what makes a stale
        // exported variable impossible to pick up by accident.
        env: { ...process.env, DATABASE_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    children.add(child);

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      children.delete(child);
      resolveBoot(result);
    };

    const deadline = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; settle still reports the timeout.
      }
      settle({ ok: false, ms: WORKER_TIMEOUT_MS, error: `timed out after ${WORKER_TIMEOUT_MS}ms` });
    }, WORKER_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      settle({ ok: false, ms: 0, error: error.message });
    });
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        settle({
          ok: false,
          ms: 0,
          error: `worker exited ${code} with no result${stderr ? `:\n${stderr.trim()}` : ""}`,
        });
        return;
      }
      try {
        settle(JSON.parse(line));
      } catch {
        settle({
          ok: false,
          ms: 0,
          error: `unparseable worker output: ${line}`,
        });
      }
    });
  });
}

function indent(text) {
  return String(text)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/**
 * Report a failure WITHOUT exiting.
 *
 * `process.exit()` here would skip the `finally` that drops both scratch
 * databases, leaking two `rbac_test_*` databases on every failing run. Setting
 * the exit code and throwing unwinds through that cleanup instead.
 */
function fail(message) {
  console.error(`[multi-instance] ${message}`);
  process.exitCode = 1;
  throw new Error(`[multi-instance] ${message}`);
}
