/**
 * Constants that define the schema bootstrap's locking contract (D-1).
 *
 * They live in their own module, separate from `./db`, because they carry no
 * side effects: `db.ts` binds DATABASE_URL at import time and creates a pool,
 * which a test that only wants to know the lock key must not trigger. Tests
 * import this file; the bootstrap logic imports it too, so there is exactly one
 * definition and no "keep these two in sync" note anywhere.
 *
 * Plain `.mjs` with a `.d.mts` sibling, like scripts/test-db.mjs: db.ts is
 * imported directly by plain Node (scripts/verify-multi-instance.mjs, under
 * built-in type stripping), where a relative import needs a real filename and
 * `.ts` specifiers are rejected by tsc. `.mjs` is the one form both accept.
 */

/**
 * The single transaction-scoped advisory lock serialising the WHOLE bootstrap
 * (D-1).
 *
 * Taken before the first DDL statement, not between blocks. `BEGIN` gives
 * atomicity but not exclusion: two processes booting together would both read
 * the same empty catalog, both run `CREATE TABLE IF NOT EXISTS`, and the loser
 * would die on `pg_type_typname_nsp_index` — the two statements are each
 * internally consistent but not atomic against each other. A lock taken only
 * before v7 arrives too late: v2–v6 have already raced.
 *
 * The key is an arbitrary fixed int4; only its stability matters. It is
 * transaction-scoped, so it releases on COMMIT/ROLLBACK without a matching
 * unlock. The lock is deliberately held for the whole bootstrap: exactly one
 * process does the DDL while the others wait at a known point, and the losers
 * then find every block a no-op.
 *
 * The value is the one this file's former per-block v7 lock used. The per-block
 * locks (v7/v8/v9) are gone, so nothing else in this codebase takes that key.
 * (A mixed-version rollout is not otherwise serialised: instances still running
 * the old build do not take a lock before v2–v6, which is why the boot path is
 * expected to roll rather than overlap across versions.)
 */
export const SCHEMA_BOOTSTRAP_ADVISORY_LOCK = 730_200_001;

/**
 * How long bootstrap waits behind another instance's bootstrap before giving
 * up. Applied as `SET LOCAL lock_timeout` inside the transaction, so a stuck
 * first instance cannot hang every later one forever, and normal request
 * queries (outside bootstrap) are untouched.
 */
export const BOOTSTRAP_LOCK_TIMEOUT_MS = 60_000;
