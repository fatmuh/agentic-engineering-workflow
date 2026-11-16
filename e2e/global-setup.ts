import { baseConnectionString, scratchConnectionString } from "../scripts/test-db.mjs";
import pg from "pg";

/**
 * Playwright global setup — the barrier between "the server answers HTTP" and
 * "the scratch database is safe for a spec to touch directly".
 *
 * Why it exists (D-1, schema bootstrap in one transaction): since the whole
 * bootstrap runs inside ONE transaction on ONE connection, nothing it creates
 * is visible to any OTHER connection until it commits. The e2e specs seed rows
 * through their own pg pool (`e2e/helpers.ts:seedUser`), so they are exactly
 * such a connection.
 *
 * Playwright's `webServer` readiness is only `GET /login` answering, and that
 * page does not touch the database, so specs used to start while the bootstrap
 * transaction was still open: `seedUser` then failed with `relation "users"
 * does not exist`. Before the transaction existed, the v2 block committed on
 * its own, early, and hid the race.
 *
 * This setup polls with a REAL connection of its own until every table the
 * specs seed into is visible, i.e. until the bootstrap has committed. It is a
 * visibility barrier, not a timing sleep: the condition is the exact predicate
 * the specs need, and a bootstrap that never commits fails the run with a clear
 * message instead of producing an endless series of confusing SQL errors.
 */

const VISIBILITY_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

/** Relations a spec must be able to write to as soon as it starts. */
const REQUIRED_RELATIONS = ["users", "roles", "bmad_projects", "bmad_tasks"] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function globalSetup(): Promise<void> {
  const name = process.env.E2E_SCRATCH_DB_NAME;
  if (!name) {
    throw new Error(
      "E2E_SCRATCH_DB_NAME is not set — e2e specs must run through `npm run test:e2e` with a derived scratch DB"
    );
  }
  const url = scratchConnectionString(baseConnectionString(), name);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const startedAt = Date.now();
    for (;;) {
      // A single query, so a relation that is still uncommitted reports as
      // absent rather than aborting the session.
      const { rows } = await client.query<{ missing: string | null }>(
        `SELECT string_agg(name, ', ') AS missing
           FROM unnest($1::text[]) AS name
          WHERE to_regclass('public.' || name) IS NULL`,
        [REQUIRED_RELATIONS],
      );
      if (!rows[0]?.missing) return;

      if (Date.now() - startedAt > VISIBILITY_TIMEOUT_MS) {
        throw new Error(
          `[e2e] the schema bootstrap did not commit within ${VISIBILITY_TIMEOUT_MS / 1000}s — ` +
            `still missing: ${rows[0]?.missing}. The bootstrap runs in one transaction (D-1); ` +
            `a boot that fails now rolls the whole thing back, so check the server log for the real error.`
        );
      }
      await sleep(POLL_MS);
    }
  } finally {
    await client.end().catch(() => {});
  }
}
