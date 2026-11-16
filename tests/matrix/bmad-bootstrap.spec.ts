import pg from "pg";
import { afterAll, expect, test, vi } from "vitest";
import {
  MIN_CATALOG_ROWS,
  readCatalogShape,
} from "../../scripts/catalog-shape.mjs";
import {
  baseConnectionString,
  createScratchDb,
  deriveScratchDbName,
  dropScratchDb,
  scratchConnectionString,
} from "../../scripts/test-db.mjs";
import {
  BOOTSTRAP_LOCK_TIMEOUT_MS,
  SCHEMA_BOOTSTRAP_ADVISORY_LOCK,
} from "@/lib/schema-bootstrap.mjs";
import { closeDbPool } from "./helpers";

/**
 * Bootstrap regression matrix (spec-bmad-hardening story 4 / CAP-1) — the rows
 * of the story's I/O matrix that are about the BOOTSTRAP itself rather than
 * about HTTP behaviour.
 *
 * The behaviour under test is one sentence: `ensureSchema()` is ONE transaction
 * on ONE client, behind ONE advisory lock taken before the first DDL statement.
 * Everything here exists because the previous shape (a series of `pool.query()`
 * calls, with per-block locks starting only at v7) let two processes fight over
 * `CREATE TABLE IF NOT EXISTS` until one died on `pg_type_typname_nsp_index`.
 *
 * Destructive rows (rollback, lock timeout) get their OWN scratch database:
 * they deliberately break the catalog halfway through a bootstrap, and the
 * shared matrix database must never be the thing that is broken. The
 * non-destructive row replays against the shared scratch database, which is
 * also the honest target — it is already migrated, which is exactly the
 * "second boot does nothing" state.
 *
 * `@/lib/db` is only ever imported by swapping DATABASE_URL FIRST (it binds the
 * URL at import time), after `vi.resetModules()`, restoring the variable
 * afterwards and closing that import's pool. Same recipe as
 * tests/matrix/bmad-backlog.spec.ts and bmad-identity.spec.ts.
 */

/**
 * Both values come from src/lib/db.ts rather than a copy: the timing assertion
 * below waits the REAL timeout out, so a test-local duplicate that drifts would
 * either fail spuriously or stop proving the configured value is in force.
 */
const BOOTSTRAP_LOCK_KEY = SCHEMA_BOOTSTRAP_ADVISORY_LOCK;
const LOCK_TIMEOUT_MS = BOOTSTRAP_LOCK_TIMEOUT_MS;

const base = baseConnectionString();

/** Scratch databases this file created, dropped in afterAll even on failure. */
const scratchDatabases: string[] = [];

/**
 * A fresh, empty scratch database this file OWNS. Each call advances the
 * trailing epoch-ms instead of re-deriving it, so two calls in the same
 * millisecond cannot collide while the name stays inside test-db.mjs's
 * `rbac_test_<pid>_<epoch-ms>` reaper pattern.
 */
async function freshDatabase(): Promise<{ name: string; url: string }> {
  const stamp = deriveScratchStamp();
  const name = `rbac_test_${process.pid}_${stamp}`;
  scratchDatabases.push(name);
  await createScratchDb({ name, base });
  return { name, url: scratchConnectionString(base, name) };
}

let lastStamp = 0;

/** The epoch-ms part of deriveScratchDbName(), strictly increasing per call. */
function deriveScratchStamp(): number {
  const stamp = Number(deriveScratchDbName().split("_").pop());
  lastStamp = Math.max(stamp, lastStamp + 1);
  return lastStamp;
}

/** A bare client on one database — the test's own connection, never @/lib/db's. */
async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Import @/lib/db bound to `url` and hand it to `body`, then close THAT import's
 * pool. Restoring by assignment would store the literal "undefined" when the
 * variable was never set, so the absent case deletes the key instead.
 */
async function withDatabase<T>(
  url: string,
  body: (db: typeof import("@/lib/db")) => Promise<T>,
): Promise<T> {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    vi.resetModules();
    const db = await import("@/lib/db");
    try {
      return await body(db);
    } finally {
      await db.pool.end();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous;
    }
  }
}

/**
 * The pid WAITING for the bootstrap advisory lock in THIS database, or null.
 *
 * `pg_locks` is cluster-wide, so the database filter is load-bearing: without
 * it another database's waiter would satisfy the poll below and the test would
 * proceed against a bootstrap that had not yet reached the lock at all.
 */
async function bootstrapLockWaiterPid(url: string): Promise<number | null> {
  const client = await connect(url);
  try {
    const { rows } = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objid = $1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        LIMIT 1`,
      [BOOTSTRAP_LOCK_KEY],
    );
    return rows[0]?.pid ?? null;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Relation locks held by one backend.
 *
 * This is the observable that distinguishes "waiting before any DDL" from
 * "ran v2–v6 and then waited": DDL takes locks on `pg_class`, `pg_type` and the
 * target relation, and those stay held for the rest of the transaction. A
 * backend that has executed no DDL holds none. (Table EXISTENCE cannot tell
 * the two apart — uncommitted DDL is invisible to every other session.)
 */
async function relationLockCount(url: string, pid: number): Promise<number> {
  const client = await connect(url);
  try {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
        WHERE pid = $1 AND locktype = 'relation'`,
      [pid],
    );
    return Number(rows[0]?.count ?? 0);
  } finally {
    await client.end().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

afterAll(async () => {
  try {
    for (const name of scratchDatabases) {
      await dropScratchDb({ name, base, quiet: true });
    }
  } finally {
    await closeDbPool();
  }
});

test("a replay on the already-migrated database performs no effective DDL and does not error", async () => {
  // Every harness boot is a fresh database, so the "everything is already
  // done" path only ran once per run. A replay of ensureSchema() is a server
  // restart against an already-migrated database — the ordinary production
  // case — and it must be indistinguishable from not running at all.
  //
  // "No effective DDL" is proven structurally: the whole public catalog
  // (tables, columns, constraints, index definitions) is byte-identical before
  // and after. A block that recreated an index, or v7 rebuilding the index v9
  // had folded, would change at least one definition.
  const url = process.env.MATRIX_DB_URL;
  if (!url) {
    throw new Error("MATRIX_DB_URL is not set — the matrix global setup did not run");
  }

  const before = await readCatalogShape(url);
  // Guards against a vacuously passing comparison: a dump that captured nothing
  // would be identical to another dump that captured nothing. The floor is the
  // shared one, so this and the multi-instance script agree on what "empty" is.
  expect(before.length).toBeGreaterThanOrEqual(MIN_CATALOG_ROWS);

  await withDatabase(url, async (db) => {
    await expect(db.ensureSchema()).resolves.toBeUndefined();
  });

  expect(await readCatalogShape(url)).toEqual(before);
});

test("the advisory lock is taken before the first DDL statement", async () => {
  // The defect D-1 fixes is not "the blocks are not serialised" but "they are
  // not serialised BEFORE the first CREATE". Hold the lock from a foreign
  // session, start a bootstrap, and inspect the WAITING backend.
  //
  // Table EXISTENCE cannot answer this: uncommitted DDL is MVCC-hidden from
  // every other session, so a bootstrap that ran v2–v6 and only then blocked
  // would look exactly like one that blocked first. Locks can answer it. DDL
  // takes relation locks (on pg_class, pg_type and the new table) and holds
  // them until the transaction ends, so the waiting backend holds relation
  // locks only if a DDL statement has already executed. Zero is therefore the
  // signature of "the lock came first".
  const { url } = await freshDatabase();

  const holder = await connect(url);
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);

    const booting = withDatabase(url, async (db) => db.ensureSchema());

    // Wait until the bootstrap is provably BLOCKED on the lock, not merely slow
    // to start (a foreign database's waiter cannot satisfy this — see the
    // helper), so the measurement is taken at the moment that matters.
    let waiterPid: number | null = null;
    const deadline = Date.now() + 10_000;
    while (waiterPid === null) {
      if (Date.now() > deadline) {
        throw new Error("bootstrap never reached the advisory lock within 10s");
      }
      waiterPid = await bootstrapLockWaiterPid(url);
      if (waiterPid === null) await sleep(50);
    }

    expect(await relationLockCount(url, waiterPid)).toBe(0);

    await holder.query("COMMIT");
    await expect(booting).resolves.toBeUndefined();

    // And it did finish the job once unblocked.
    const observer = await connect(url);
    try {
      const { rows } = await observer.query<{ users: string | null }>(
        "SELECT to_regclass('public.users')::text AS users",
      );
      expect(rows[0]?.users).toBe("users");
    } finally {
      await observer.end().catch(() => {});
    }
  } finally {
    await holder.end().catch(() => {});
  }
});

test("a failure in a LATER block rolls back what an EARLIER block created", async () => {
  // The failing block must not be the first one. Before D-1, v2–v6 were a
  // single multi-statement `pool.query` — one implicit transaction — so a
  // failure IN that batch already rolled itself back and the old code would
  // pass a test built around it. Only work committed by one block and unwound
  // by a later one distinguishes "one outer transaction" from "a batch
  // followed by independent statements".
  //
  // `roles` is pre-created with a shape the v3 block trips on (no `name`
  // column, so its seed INSERT fails), while v2 has already created `users`
  // and `refresh_tokens` in the same transaction. Their disappearance is the
  // evidence: it can only come from the outer ROLLBACK.
  const { url } = await freshDatabase();

  const admin = await connect(url);
  try {
    await admin.query("CREATE TABLE roles (key TEXT PRIMARY KEY, note TEXT)");
  } finally {
    await admin.end().catch(() => {});
  }

  await withDatabase(url, async (db) => {
    await expect(db.ensureSchema()).rejects.toThrow(/name/);

    const check = await connect(url);
    try {
      const { rows } = await check.query<{
        users: string | null;
        tokens: string | null;
        roles: string | null;
        projects: string | null;
      }>(
        `SELECT to_regclass('public.users')::text           AS users,
                to_regclass('public.refresh_tokens')::text  AS tokens,
                to_regclass('public.roles')::text           AS roles,
                to_regclass('public.bmad_projects')::text   AS projects`,
      );
      // v2's tables are gone (rolled back), the pre-existing `roles` survives
      // untouched, and no later block ran.
      expect(rows[0]).toEqual({
        users: null,
        tokens: null,
        roles: "roles",
        projects: null,
      });
    } finally {
      await check.end().catch(() => {});
    }

    // The SAME module instance retries. schemaReady was reset on rejection, so
    // removing the cause is enough — no process restart needed.
    const repair = await connect(url);
    try {
      await repair.query("DROP TABLE roles");
    } finally {
      await repair.end().catch(() => {});
    }
    await expect(db.ensureSchema()).resolves.toBeUndefined();

    const done = await connect(url);
    try {
      const { rows } = await done.query<{ users: string | null; projects: string | null }>(
        `SELECT to_regclass('public.users')::text AS users,
                to_regclass('public.bmad_projects')::text AS projects`,
      );
      expect(rows[0]).toEqual({ users: "users", projects: "bmad_projects" });
    } finally {
      await done.end().catch(() => {});
    }
  });
});

test("a legacy TEXT-id database is dropped inside the bootstrap transaction and rebuilt as UUID", async () => {
  // `migrateLegacySchema` now runs inside the one transaction, and its
  // `DROP TABLE users CASCADE` is destructive. The legacy branch only fires on
  // a v1 database, which no harness boot ever produces, so without this test
  // the most destructive statement in the bootstrap is never executed by CI.
  const { url } = await freshDatabase();

  const admin = await connect(url);
  try {
    // A v1 shape: TEXT opaque ids, plus the sessions table of the old design.
    await admin.query("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)");
    await admin.query("INSERT INTO users (id, email) VALUES ('usr_legacy', 'old@example.test')");
    await admin.query("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT)");
  } finally {
    await admin.end().catch(() => {});
  }

  await withDatabase(url, async (db) => {
    await expect(db.ensureSchema()).resolves.toBeUndefined();
  });

  const check = await connect(url);
  try {
    // Replaced, not merely emptied: the column type is the proof.
    const { rows } = await check.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'`,
    );
    expect(rows[0]?.data_type).toBe("uuid");

    const { rows: legacy } = await check.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM users WHERE email = 'old@example.test'",
    );
    expect(legacy[0]?.count).toBe(0);

    const { rows: sessions } = await check.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions')::text AS sessions",
    );
    expect(sessions[0]?.sessions).toBeNull();
  } finally {
    await check.end().catch(() => {});
  }
});

test("the optional pgcrypto extension is rolled back to its savepoint, not the whole bootstrap", async () => {
  // `CREATE EXTENSION IF NOT EXISTS pgcrypto` is best-effort: on a fresh
  // database it is a no-op (13+ has gen_random_uuid built in), on an older or
  // restricted one it may fail and the bootstrap must carry on regardless.
  //
  // Inside ONE transaction a failed statement aborts the ENTIRE transaction
  // with 25P02, so merely swallowing the error would break every following
  // block. This forces the failure by pre-creating `digest(bytea, text)` — the
  // extension's own function — so the extension install collides (42723), and
  // then asserts the bootstrap still completes. Without the SAVEPOINT the
  // bootstrap fails with "current transaction is aborted", which is the
  // regression this pins.
  const { url } = await freshDatabase();

  const admin = await connect(url);
  try {
    await admin.query(
      `CREATE FUNCTION public.digest(bytea, text) RETURNS bytea AS 'SELECT $1' LANGUAGE sql IMMUTABLE`,
    );
  } finally {
    await admin.end().catch(() => {});
  }

  await withDatabase(url, async (db) => {
    await expect(db.ensureSchema()).resolves.toBeUndefined();
  });

  const check = await connect(url);
  try {
    const { rows } = await check.query<{ users: string | null; projects: string | null }>(
      `SELECT to_regclass('public.users')::text AS users,
              to_regclass('public.bmad_projects')::text AS projects`,
    );
    expect(rows[0]).toEqual({ users: "users", projects: "bmad_projects" });
  } finally {
    await check.end().catch(() => {});
  }
});

test(
  "an instance that loses the lock race fails with a message naming the bootstrap lock",
  async () => {
    // Held past lock_timeout, so the waiter's SET LOCAL lock_timeout expires and
    // Postgres raises 55P03. The story requires the operator to see a message
    // about the lock — not an arbitrary DDL error from a block that ran
    // unsynchronised, and not a bare "canceling statement due to lock timeout".
    //
    // This waits the real 60s: the timeout is production behaviour with no test
    // hook, and a shorter fake would stop proving that the configured value is
    // the one in force.
    const { url } = await freshDatabase();

    const holder = await connect(url);
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);

      await withDatabase(url, async (db) => {
        const startedAt = Date.now();
        await expect(db.ensureSchema()).rejects.toThrow(/bootstrap lock/i);
        // It really waited out the timeout rather than failing fast for some
        // other reason.
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 2_000);

        // schemaReady was reset: once the lock is free, the next attempt on the
        // SAME module instance succeeds and builds the schema.
        await holder.query("COMMIT");
        await expect(db.ensureSchema()).resolves.toBeUndefined();

        const check = await connect(url);
        try {
          const { rows } = await check.query<{ users: string | null }>(
            "SELECT to_regclass('public.users')::text AS users",
          );
          expect(rows[0]?.users).toBe("users");
        } finally {
          await check.end().catch(() => {});
        }
      });
    } finally {
      await holder.end().catch(() => {});
    }
  },
  LOCK_TIMEOUT_MS + 30_000,
);

test("concurrent callers in one process share one bootstrap", async () => {
  // The memoized promise is what keeps a request spike during a cold start from
  // queueing N bootstraps — and, with a global lock, from deadlocking N module
  // instances inside one process. Both callers must see the same promise.
  const { url } = await freshDatabase();

  await withDatabase(url, async (db) => {
    const first = db.ensureSchema();
    const second = db.ensureSchema();
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    const check = await connect(url);
    try {
      const { rows } = await check.query<{ users: string | null }>(
        "SELECT to_regclass('public.users')::text AS users",
      );
      expect(rows[0]?.users).toBe("users");
    } finally {
      await check.end().catch(() => {});
    }
  });
});
