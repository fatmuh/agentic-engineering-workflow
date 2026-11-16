/**
 * Type declarations for src/lib/schema-bootstrap.mjs — the schema bootstrap's
 * locking contract (D-1). Runtime implementation and its full documentation
 * live in schema-bootstrap.mjs; keep the two in sync.
 */

/** Transaction-scoped advisory lock key serialising the whole bootstrap. */
export const SCHEMA_BOOTSTRAP_ADVISORY_LOCK: number;

/** How long bootstrap waits for that lock before failing (ms). */
export const BOOTSTRAP_LOCK_TIMEOUT_MS: number;
