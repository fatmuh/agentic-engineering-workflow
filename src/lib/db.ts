import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import {
  BOOTSTRAP_LOCK_TIMEOUT_MS,
  SCHEMA_BOOTSTRAP_ADVISORY_LOCK,
} from "./schema-bootstrap.mjs";

/**
 * Shared PostgreSQL connection pool.
 * DATABASE_URL is defined in .env.local (gitignored).
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Add it to .env.local");
}

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Idempotent schema bootstrap (schema v3). Runs once per server process before
 * the first query so the app works against a fresh database without a separate
 * migration step.
 *
 * ONE TRANSACTION (D-1). Every block below — v2 through v9 — runs as a single
 * transaction on ONE checked-out client, behind a single transaction-scoped
 * advisory lock taken before the first DDL statement. `CREATE TABLE IF NOT
 * EXISTS` is not atomic against itself: two processes booting together both
 * find the catalog entry absent and both insert into `pg_type`, and the loser
 * dies with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.
 * A lock per block cannot fix that, because the blocks that race run before any
 * of those locks is taken. One global lock first, then everything inside it.
 *
 * A second consequence of the same design: bootstrap holds one pool connection
 * for its whole run. That is acceptable because it happens once per process and
 * is bounded by `lock_timeout` — not once per request.
 *
 * v2 replaces the legacy opaque-session design:
 *   users          id is a native UUID (gen_random_uuid()) instead of TEXT `usr_*`
 *   refresh_tokens JWT refresh material, stored as sha256(jti), rotatable/revocable
 *   sessions       dropped — sessions are now stateless JWT access tokens
 *
 * v3 adds RBAC:
 *   roles          role key → JSONB permission grants (the only permission data in the DB)
 *   role_audit     audit trail for every roles/permissions mutation
 *   users.role     becomes a real FK to roles(key) — in-place upgrade, zero data
 *                  migration (the seed reuses the exact values users.role already holds)
 *
 * v4 adds the Wiki + storage config:
 *   wiki_pages / wiki_labels / wiki_page_labels / wiki_comments / wiki_attachments
 *   wiki_audit    audit trail for every wiki/storage mutation (mirrors role_audit)
 *   app_settings  key → JSONB value store; holds the S3 storage config (the
 *                 requester's explicit "not .env" decision — see the plan)
 *
 * v6 adds OAuth 2.0 PKCE for the BMad Monitor MCP CLI:
 *   oauth_codes           single-use authorization codes (PKCE S256, 60s TTL)
 *   oauth_refresh_tokens  rotatable MCP refresh material, sha256(jti) — separate
 *                         from web refresh_tokens (different revoke semantics)
 *
 * v7 scopes the BMad board to a project (CAP-5):
 *   bmad_tasks / bmad_agent_nodes / bmad_backlogs move from a global
 *   `id TEXT PRIMARY KEY` to `PRIMARY KEY (project_id, id)`, so `TASK-101`
 *   means a different row per project instead of overwriting another project's
 *   task. The child FKs (task_id, parent_id) become composite and must be
 *   CASCADE — the previous `task_id ... ON DELETE SET NULL` is impossible on a
 *   composite key, since SET NULL would null the NOT NULL project_id that is
 *   part of the primary key. bmad_projects gains the two partial unique indexes
 *   that make workspace → project resolution race-safe (identity-mapping.md).
 *
 *   Unlike the blocks above this one runs DDL, so every step is guarded by
 *   pg_constraint state — constraint names are read from the catalog, never
 *   assumed, and re-running it is a no-op. It runs on the bootstrap
 *   transaction's client (see migrateProjectScopedKeys).
 *
 * v8 completes the backlog flow the MCP CLI already models:
 *   bmad_backlogs gains promoted_to_task_id / promoted_by / promoted_at plus a
 *   composite FK to bmad_tasks (project_id, id), so "promoted ⇒ the task
 *   exists" is a database invariant and the server-side promote stays
 *   idempotent. Like v7 this is catalog-guarded DDL on the bootstrap client.
 *
 * v9 folds workspace identity (D-4):
 *   bmad_projects.workspace_path is lowercased in place and
 *   uq_bmad_projects_workspace rebuilt over the folded expression, so
 *   `/Users/X/proj` and `/users/x/proj` are one key. Two rows that collapse
 *   into one key abort the boot with a message naming both projects — merging
 *   is never automatic. Same bootstrap-client shape as v7/v8.
 */
let schemaReady: Promise<void> | null = null;

/**
 * Drop the tables of the v1 design, on the bootstrap transaction's client.
 *
 * The client is a parameter, not the pool: these DROPs are part of the same
 * atomic bootstrap as every CREATE below. A `pool.query` here would run on some
 * other connection — outside the transaction and, worse, outside the bootstrap
 * lock — which is exactly the race D-1 exists to remove.
 */
async function migrateLegacySchema(client: PoolClient): Promise<void> {
  // A v1 database has users.id as TEXT (`usr_*` opaque ids). Detect it by column
  // type (lowercased — information_schema reports in lower case already, but be
  // explicit) and drop the legacy tables: ids are incompatible with v2 UUIDs and
  // the plan explicitly does not carry old data (scrypt hashes are dead too).
  const idType = await client.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'`
  );
  const isLegacy = idType.rows[0]?.data_type?.toLowerCase() === "text";

  // The sessions table belongs to the dropped design; remove it whenever found.
  await client.query(`DROP TABLE IF EXISTS sessions`);

  if (isLegacy) {
    console.warn("[db] legacy TEXT-id users table detected — dropping users (old data is not migrated)");
    await client.query(`DROP TABLE IF EXISTS users CASCADE`);
  }
}

/**
 * SQL expression for the comparable form of a git remote, shared by
 * `uq_bmad_projects_remote` and the JavaScript resolver in story 2. Mirrors
 * identity-mapping.md's normalisation steps 1-5: trim and strip a trailing "/",
 * strip a ".git" suffix, drop scheme + userinfo, turn `host:owner/repo` into
 * `host/owner/repo`, and lowercase. SQL and TS must agree or the index stops
 * guarding the rule the resolver applies.
 *
 * lower() is applied up front, not last: `.GIT` must be stripped by the same
 * rule as `.git`, and a trailing lower() would only run after that strip had
 * already missed it.
 *
 * Exported because `resolveProject` in ./projects compares against this exact
 * expression rather than re-deriving the key in JavaScript — one contract, so
 * the lookup and the index can never disagree.
 */
export const NORMALIZED_REMOTE_SQL = `regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(btrim(git_remote_url)), '/+$', ''), '\\.git$', ''), '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '^[^/@]*@', ''), '^([^/:]+):[0-9]+(/.*)$', '\\1\\2'), '^([^/:]+):(.*)$', '\\1/\\2')`;

/**
 * SQL expression for the comparable form of a workspace path, used by
 * `uq_bmad_projects_workspace`. identity-mapping.md rule 2 compares normalised
 * paths; `~`-expansion and absolute resolution happen in the resolver, but the
 * trailing-slash strip must be here too — indexing the raw column would let
 * `/a/b` and `/a/b/` both insert and then resolve to two different projects,
 * which is exactly the race the index exists to lose. Root stays `/` and is
 * not stripped to the empty string, matching rule 3's "preserve / for root".
 *
 * CASE-FOLDED (D-4), with `translate` rather than `lower`. `lower()` folds the
 * whole Unicode range in a locale-dependent way, and JavaScript `toLowerCase()`
 * does not agree with it on `İ` or the Greek final sigma — a key that cannot
 * equal its own SQL form would duplicate the project on every resolve. Both
 * halves therefore fold exactly the ASCII letters and leave every other byte
 * untouched, so they agree on every possible input. Case-insensitivity for
 * non-ASCII letters is the accepted cost; ASCII paths — every real workspace
 * path — fold completely.
 *
 * Order mirrors `normalizeWorkspacePath`: btrim, strip trailing "/", then fold.
 *
 * Exported for the same reason as NORMALIZED_REMOTE_SQL above: the resolver
 * must compare with these expressions, not a parallel TS implementation.
 */
export const NORMALIZED_WORKSPACE_SQL = `CASE WHEN btrim(workspace_path) ~ '^/+$' THEN '/'
       ELSE translate(regexp_replace(btrim(workspace_path), '/+$', ''),
                      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') END`;

/**
 * The PRE-D-4 value of `NORMALIZED_WORKSPACE_SQL` — same trimming and
 * trailing-slash rule, no case fold.
 *
 * Kept only because v7's migration block must keep installing and checking the
 * index shape it shipped with (see `NORMALIZED_WORKSPACE_V7_INDEX_EXPR`); the
 * resolver does not use it. A pre-D-4 row is found by the folded expression
 * alone, which folds the STORED value.
 */
export const NORMALIZED_WORKSPACE_LEGACY_SQL = `CASE WHEN btrim(workspace_path) ~ '^/+$' THEN '/'
       ELSE regexp_replace(btrim(workspace_path), '/+$', '') END`;

/**
 * `CREATE INDEX` parses an index expression as a bare `a_expr`, and a `CASE`
 * is an `a_expr` only when parenthesised — hence the extra parens around the
 * workspace form at the index site. A plain function call needs none.
 */
const NORMALIZED_WORKSPACE_INDEX_EXPR = `(${NORMALIZED_WORKSPACE_SQL})`;

/**
 * The v7 index expression, frozen: the same shape `uq_bmad_projects_workspace`
 * had before v9 added the case fold.
 *
 * v7 must keep installing and checking THE SHAPE IT SHIPPED WITH. Folding it
 * here would make v7's duplicate pre-check fire on the very rows v9 exists to
 * report, with a message that names paths instead of projects — and on every
 * boot v7 would rebuild the index v9 had just folded, undoing the migration.
 * The folded form belongs to v9 alone, which owns the collision report.
 */
const NORMALIZED_WORKSPACE_V7_INDEX_EXPR = `(${NORMALIZED_WORKSPACE_LEGACY_SQL})`;

/** True when `pg_get_indexdef` output shows the case-folding (v9) workspace
 *  index. Function names are printed lower-case, so a substring test is enough
 *  to tell the two shipped shapes apart without parsing the definition. */
function isFoldedWorkspaceIndex(indexDef: string | null): boolean {
  return indexDef !== null && indexDef.includes("translate(");
}

/**
 * The installed `uq_bmad_projects_workspace` definition, or null when absent.
 *
 * Resolved through `to_regclass('bmad_projects')` rather than a hardcoded
 * `schemaname = 'public'`: every other statement in this file leaves the schema
 * to `search_path`, and on a database whose tables live in another schema a
 * hardcoded filter would return null forever. v7 would then rebuild the
 * unfolded index on every boot and v9 would fold it back — an endless
 * ping-pong. `to_regclass` uses the same path as the DDL, so both see the table
 * they actually operate on.
 */
async function workspaceIndexDef(
  client: { query: typeof pool.query }
): Promise<string | null> {
  const res = await client.query<{ indexdef: string }>(
    `SELECT pg_get_indexdef(i.indexrelid) AS indexdef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = to_regclass('bmad_projects')
        AND c.relname = 'uq_bmad_projects_workspace'`
  );
  return res.rows[0]?.indexdef ?? null;
}

/** Primary keys this migration installs, in the order their child FKs must be handled. */
const PROJECT_SCOPED_TABLES = ["bmad_tasks", "bmad_agent_nodes", "bmad_backlogs"] as const;

/** Child foreign keys that must be dropped before the referenced PK can change. */
const COMPOSITE_CHILD_FKS = [
  { table: "bmad_agent_nodes", column: "task_id" },
  { table: "bmad_agent_nodes", column: "parent_id" },
] as const;

/**
 * Resolve a column's attribute number from the catalog. Never hardcode these:
 * in the v5 layout `id` is column 1 and `project_id` is column 2, the reverse of
 * what the DDL order suggests at a glance.
 */
async function attnumOf(
  client: { query: typeof pool.query },
  table: string,
  column: string
): Promise<number | undefined> {
  const res = await client.query<{ attnum: number }>(
    `SELECT attnum FROM pg_attribute
      WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`,
    [table, column]
  );
  return res.rows[0]?.attnum;
}

/**
 * True when `table` already has a foreign key on (`column`, project_id) in the
 * composite shape v7 installs. Matching is by `conkey` MEMBERSHIP, not equality
 * of the whole array: once v7 has run the key is `(project_id, task_id)`, and an
 * equality test against `(task_id)` alone would read "absent", drop it again and
 * re-add a duplicate — the exact restart failure this guard exists to prevent.
 */
async function hasCompositeForeignKey(
  client: { query: typeof pool.query },
  table: string,
  column: string
): Promise<boolean> {
  const columnAttnum = await attnumOf(client, table, column);
  const projectAttnum = await attnumOf(client, table, "project_id");
  if (!columnAttnum || !projectAttnum) return false;
  const res = await client.query(
    `SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.contype = 'f'
        AND array_length(c.conkey, 1) = 2
        AND $2 = ANY (c.conkey)
        AND $3 = ANY (c.conkey)
      LIMIT 1`,
    [table, columnAttnum, projectAttnum]
  );
  return res.rows.length > 0;
}

/**
 * True when `table` already has a SINGLE-column foreign key on `column`.
 * Step 1 drops exactly those: a v6 key is `(task_id)`, while a v7 key is
 * `(project_id, task_id)` and must be left alone on a restart.
 */
async function hasSingleColumnForeignKey(
  client: { query: typeof pool.query },
  table: string,
  column: string
): Promise<boolean> {
  const columnAttnum = await attnumOf(client, table, column);
  if (!columnAttnum) return false;
  const res = await client.query(
    `SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.contype = 'f'
        AND c.conkey = ARRAY[$2::smallint]
      LIMIT 1`,
    [table, columnAttnum]
  );
  return res.rows.length > 0;
}

/**
 * Schema v7 — composite `(project_id, id)` primary keys.
 *
 * Every step reads the catalog first, so a database already on v7 does no DDL
 * and a database half-way through cannot double-add. It runs on the bootstrap
 * transaction's client, so a failure leaves the old keys intact rather than a
 * table without a primary key — and no second `BEGIN`, because the caller
 * already owns the transaction and the global lock (see
 * SCHEMA_BOOTSTRAP_ADVISORY_LOCK; a nested one would be either illegal or a
 * redundant wait on a lock this very transaction holds).
 *
 * The rewrite is cheap only because existing rows are unique globally, which
 * makes the new composite key valid without a data scan for conflicts; the
 * pre-flight check below still refuses to proceed if some row pairs up in a
 * way the old key allowed but the new one does not.
 */
async function migrateProjectScopedKeys(client: PoolClient): Promise<void> {
  // ---- 1. Drop the child FKs that reference a changing key --------------
  // Read the real constraint name from pg_constraint rather than assuming
  // `<table>_<column>_fkey`: the name is auto-generated and a hand-created
  // database may carry a different one. Only SINGLE-column keys are dropped —
  // a composite one is already v7's and must survive a restart untouched.
  for (const { table, column } of COMPOSITE_CHILD_FKS) {
    if (!(await hasSingleColumnForeignKey(client, table, column))) continue;
    const existing = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'f'
          AND conkey = ARRAY[$2::smallint]`,
      [table, await attnumOf(client, table, column)]
    );
    for (const { conname } of existing.rows) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(conname)}`);
    }
  }

  // ---- 2. Guard the new composite keys against existing data ------------
  // Runs before the key swap (not before all DDL — step 1 has already
  // dropped the child FKs); the transaction is what makes that safe: a throw
  // here rolls the whole thing back and leaves the v5 keys in place.
  //
  // A row is only a problem when this node's OWN project lacks the id it
  // points at. A node whose task_id matches its own project's task is valid
  // even when another project reuses that id — that reuse is precisely what
  // v7 exists to allow, so flagging it would brick startup on normal data.
  // The trailing EXISTS keeps the check cheap: no such row can exist under
  // the old global key unless a row was edited outside the app.
  const conflicts = await client.query<{ kind: string; rows: string }>(`
    SELECT 'duplicate key' AS kind, count(*)::text AS rows FROM (
      SELECT project_id, id FROM bmad_tasks GROUP BY 1, 2 HAVING count(*) > 1
      UNION ALL
      SELECT project_id, id FROM bmad_agent_nodes GROUP BY 1, 2 HAVING count(*) > 1
      UNION ALL
      SELECT project_id, id FROM bmad_backlogs GROUP BY 1, 2 HAVING count(*) > 1
    ) dup
    UNION ALL
    SELECT 'node.task_id not in own project', count(*)::text FROM bmad_agent_nodes n
     WHERE n.task_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bmad_tasks o
                        WHERE o.project_id = n.project_id AND o.id = n.task_id)
       AND EXISTS (SELECT 1 FROM bmad_tasks t WHERE t.id = n.task_id)
    UNION ALL
    SELECT 'node.parent_id not in own project', count(*)::text FROM bmad_agent_nodes n
     WHERE n.parent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bmad_agent_nodes o
                        WHERE o.project_id = n.project_id AND o.id = n.parent_id)
       AND EXISTS (SELECT 1 FROM bmad_agent_nodes p WHERE p.id = n.parent_id)
  `);
  const blocking = conflicts.rows.filter((row) => Number(row.rows) > 0);
  if (blocking.length > 0) {
    throw new Error(
      `[db] schema v7 cannot run: ${blocking
        .map((row) => `${row.kind} (${row.rows} rows)`)
        .join(", ")}. Resolve these rows, then restart.`
    );
  }

  // ---- 3. Swap each global PK for the composite one ---------------------
  for (const table of PROJECT_SCOPED_TABLES) {
    const pkey = await client.query<{ conname: string; cols: number[] }>(
      `SELECT conname, conkey::int[] AS cols FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'p'`,
      [table]
    );
    const current = pkey.rows[0];
    // Already `(project_id, id)` → nothing to do. Compared by attribute
    // NUMBERS, the same way the FK guards are, so a renamed or re-ordered
    // catalog entry cannot be mistaken for the v5 shape.
    const projectAttnum = await attnumOf(client, table, "project_id");
    const idAttnum = await attnumOf(client, table, "id");
    const isComposite =
      current?.cols.length === 2 &&
      !!projectAttnum && !!idAttnum &&
      current.cols.includes(projectAttnum) &&
      current.cols.includes(idAttnum);
    if (isComposite) continue;
    if (current) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(current.conname)}`);
    }
    await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (project_id, id)`);
  }

  // ---- 4. Re-add the child FKs as composite, CASCADE --------------------
  // Matched by column-membership rather than by name, so a restart on an
  // already-migrated database adds nothing and does not collide with the
  // constraint it created on the previous boot.
  if (!(await hasCompositeForeignKey(client, "bmad_agent_nodes", "task_id"))) {
    await client.query(`
      ALTER TABLE bmad_agent_nodes ADD CONSTRAINT bmad_agent_nodes_task_id_fkey
        FOREIGN KEY (project_id, task_id)
        REFERENCES bmad_tasks (project_id, id) ON DELETE CASCADE
    `);
  }
  if (!(await hasCompositeForeignKey(client, "bmad_agent_nodes", "parent_id"))) {
    await client.query(`
      ALTER TABLE bmad_agent_nodes ADD CONSTRAINT bmad_agent_nodes_parent_id_fkey
        FOREIGN KEY (project_id, parent_id)
        REFERENCES bmad_agent_nodes (project_id, id) ON DELETE CASCADE
    `);
  }

  // ---- 5. Access-pattern indexes ---------------------------------------
  // `(project_id, stage)` from v5 stays: the board filters by stage inside
  // one project. The two added here serve the ordered task list and the
  // tree assembly, both now scoped by project.
  //
  // idx_bmad_agent_nodes_project is now a prefix of (project_id, parent_id)
  // and idx_bmad_agent_nodes_parent is covered by the PK's trailing `id`
  // lookup, so both are redundant. Left in place deliberately: they cost only
  // write amplification on a small table, and dropping them is outside this
  // story's scope.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bmad_tasks_project_updated
      ON bmad_tasks (project_id, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bmad_agent_nodes_project_parent
      ON bmad_agent_nodes (project_id, parent_id)
  `);

  // ---- 6. Identity indexes on bmad_projects ----------------------------
  // Checked BEFORE the CREATE UNIQUE INDEX statements: a single duplicate
  // would abort the index build, roll back the whole transaction and leave
  // the app replaying a failing bootstrap with no UI path out. Throwing a
  // named, actionable error here keeps the failure diagnosable.
  //
  // Reported values are the truncated live inputs, not the normalised forms,
  // so they can be found with a plain WHERE. The grouped expressions are
  // repeated rather than projected: GROUP BY can only reference the input
  // columns of the row being indexed.
  const remoteDupes = await client.query<{ values: string; n: string }>(`
    SELECT string_agg(DISTINCT substring(v FROM 1 FOR 60), ', ') AS values, count(*)::text AS n
      FROM (SELECT git_remote_url AS v, ${NORMALIZED_REMOTE_SQL} AS k
              FROM bmad_projects WHERE git_remote_url IS NOT NULL) s
     GROUP BY k HAVING count(*) > 1
  `);
  if (remoteDupes.rows.length > 0) {
    throw new Error(
      `[db] schema v7 cannot run: ${remoteDupes.rows.length} duplicated git remote(s) — ${remoteDupes.rows
        .map((row) => `${row.values} (${row.n} projects)`)
        .join("; ")}. Keep one project per remote, then restart.`
    );
  }

  const workspaceDupes = await client.query<{ values: string; n: string }>(`
    SELECT string_agg(DISTINCT substring(v FROM 1 FOR 60), ', ') AS values, count(*)::text AS n
      FROM (SELECT workspace_path AS v, ${NORMALIZED_WORKSPACE_LEGACY_SQL} AS k
              FROM bmad_projects
             WHERE git_remote_url IS NULL AND workspace_path IS NOT NULL) s
     GROUP BY k HAVING count(*) > 1
  `);
  if (workspaceDupes.rows.length > 0) {
    throw new Error(
      `[db] schema v7 cannot run: ${workspaceDupes.rows.length} duplicated workspace path(s) — ${workspaceDupes.rows
        .map((row) => `${row.values} (${row.n} projects)`)
        .join("; ")}. Keep one project per path, then restart.`
    );
  }

  // Partial, so many projects may share a NULL remote / NULL path, and the
  // path index only covers remote-less projects — a path that happens to
  // match a remote-backed project must not claim it (identity-mapping.md).
  //
  // The workspace index is dropped and rebuilt rather than created
  // conditionally: an earlier cut of v7 shipped it over the RAW column, and
  // `CREATE INDEX IF NOT EXISTS` matches by name only, so a database that ran
  // that cut would keep the weak index forever with no error. Dropping first
  // is idempotent and makes the shape self-correcting. The remote index needs
  // no such treatment — its only shipped definition has always been this one.
  //
  // The expression here is the FROZEN v7 one (see
  // NORMALIZED_WORKSPACE_V7_INDEX_EXPR and the guard just above): v7 keeps
  // producing the exact shape it shipped, and v9 — which runs right after —
  // upgrades it to the case-folded form. Without the guard, every boot would
  // replay v7's unfold over the index v9 had just folded.
  if (!isFoldedWorkspaceIndex(await workspaceIndexDef(client))) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bmad_projects_remote
        ON bmad_projects (${NORMALIZED_REMOTE_SQL})
        WHERE git_remote_url IS NOT NULL
    `);
    await client.query(`DROP INDEX IF EXISTS uq_bmad_projects_workspace`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bmad_projects_workspace
        ON bmad_projects (${NORMALIZED_WORKSPACE_V7_INDEX_EXPR})
        WHERE git_remote_url IS NULL AND workspace_path IS NOT NULL
    `);
  } else {
    // Already on v9's shape: v7 has nothing left to install, and recreating
    // its old index here would undo the fold. The remote index is still
    // guarded independently, since it was never rebuilt by v9.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bmad_projects_remote
        ON bmad_projects (${NORMALIZED_REMOTE_SQL})
        WHERE git_remote_url IS NOT NULL
    `);
  }

  // No COMMIT here: the caller's transaction is the only one, and it must stay
  // open for v8 and v9 (see ensureSchema).
}

/** Quote an identifier read from the catalog for inline DDL. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Schema v8 — backlog promotion columns.
 *
 * `bmad_backlogs` gets the three promotion columns the Go MCP client already
 * models (`promotedToTaskId` / `promotedBy` / `promotedAt` in models.go) and a
 * composite FK to `bmad_tasks (project_id, id)`. Without them the four
 * `awm_backlog_*` tools have nowhere to record what a backlog became, and
 * nothing stops a promoted backlog from pointing at a deleted task.
 *
 * The FK is deliberately ON DELETE NO ACTION (the default): deleting a
 * promoted task is rejected — "promoted ⇒ task exists" is an invariant, not a
 * suggestion. Deleting the whole PROJECT still works, because both tables
 * cascade from `bmad_projects` and Postgres checks NO ACTION only after the
 * cascade has removed the referencing rows too.
 *
 * Idempotent exactly like v7: columns arrive via ADD COLUMN IF NOT EXISTS, the
 * FK is guarded from the catalog by hasCompositeForeignKey, and it runs on the
 * bootstrap transaction's client, so a restart or a concurrent boot adds
 * nothing.
 */
async function migrateBacklogPromotion(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE bmad_backlogs
      ADD COLUMN IF NOT EXISTS promoted_to_task_id TEXT,
      ADD COLUMN IF NOT EXISTS promoted_by TEXT,
      ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ
  `);
  if (!(await hasCompositeForeignKey(client, "bmad_backlogs", "promoted_to_task_id"))) {
    await client.query(`
      ALTER TABLE bmad_backlogs ADD CONSTRAINT bmad_backlogs_promoted_to_task_id_fkey
        FOREIGN KEY (project_id, promoted_to_task_id)
        REFERENCES bmad_tasks (project_id, id)
    `);
  }
}

/**
 * Schema v9 — workspace identity is case-folded (D-4).
 *
 * `uq_bmad_projects_workspace` is built from `NORMALIZED_WORKSPACE_SQL`, and
 * that expression now lowercases. An index over a new expression over OLD
 * values would guard nothing the resolver honours: the resolver computes the
 * folded key, the rows still hold the unfolded path, and the same workspace
 * could be inserted a second time. So the stored column is folded in place,
 * then the index is rebuilt over it.
 *
 * Two rows can collide once folded (`/Users/X/proj` and `/users/x/proj` were
 * two keys and are now one). This migration REFUSES to pick:
 *   1. it reports every colliding pair by id and name and throws, leaving every
 *      row untouched (the transaction rolls back), so boot fails loudly with an
 *      instruction rather than silently merging or deleting a project;
 *   2. only when nothing collides does it fold and rebuild the index.
 *
 * Idempotent like v7/v8: the fold's predicate is "value differs from its folded
 * form", so a second boot updates zero rows AND skips the index rebuild
 * entirely; the index is dropped and recreated (not `IF NOT EXISTS`) only when
 * a rebuild is actually needed, so a database that ran an earlier cut of this
 * block self-corrects instead of keeping a stale index forever. Runs on the
 * bootstrap transaction's client; it neither begins nor commits one.
 *
 * Deliberately scoped to `bmad_projects`: `bmad_tasks`, `bmad_agent_nodes` and
 * `bmad_backlogs` are not touched.
 */
async function migrateWorkspaceCaseFold(client: PoolClient): Promise<void> {
  // Compared on the FOLDED trailingslash-free forms, because that is exactly
  // what the unique index will consider equal. Grouped rows are reported by
  // their own id and stored path so the operator can tell the projects apart.
  const collisions = await client.query<{ ids: string; names: string; paths: string }>(`
    SELECT string_agg(id, ', ' ORDER BY id)                AS ids,
           string_agg(name, ', ' ORDER BY id)              AS names,
           string_agg(workspace_path, ', ' ORDER BY id)    AS paths
      FROM bmad_projects
     WHERE git_remote_url IS NULL AND workspace_path IS NOT NULL
     GROUP BY ${NORMALIZED_WORKSPACE_SQL}
    HAVING count(*) > 1
  `);
  if (collisions.rows.length > 0) {
    throw new Error(
      `[db] schema v9 cannot run: ${collisions.rows.length} workspace path group(s) would collapse ` +
        `into one case-folded key. Resolve each pair by hand (keep one, or give one its own path), then restart. ` +
        collisions.rows
          .map(
            (row) =>
              `Projects ${row.ids} ("${row.names}") share workspace paths ${row.paths}`
          )
          .join("; ")
    );
  }

  // Already migrated: every stored path equals its normalised form AND the
  // installed index already carries the fold. Nothing to rewrite, and nothing
  // to rebuild — recreating an identical index on every boot would be pure
  // write amplification. The collision check above still ran, so a pair that
  // appears later is reported even on this path.
  //
  // The comparison uses NORMALIZED_WORKSPACE_SQL itself, not a hand-inlined
  // copy: the expression carries the root-preserving CASE arm (`/` stays `/`),
  // and a copy that dropped it would rewrite a root row to `''` — a key no
  // lookup can ever reach — and report it as still-unfolded on every boot.
  const unfolded = await client.query<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM bmad_projects
     WHERE workspace_path IS NOT NULL
       AND (${NORMALIZED_WORKSPACE_SQL}) IS DISTINCT FROM workspace_path
  `);
  const indexReady = isFoldedWorkspaceIndex(await workspaceIndexDef(client));
  if (unfolded.rows[0]?.count === 0 && indexReady) return;

  // The fold itself: write the same expression the index is built from, so
  // every stored value IS its own folded form afterwards and the index never
  // re-folds it differently. Root is preserved by the expression's CASE arm.
  await client.query(`
    UPDATE bmad_projects
       SET workspace_path = (${NORMALIZED_WORKSPACE_SQL})
     WHERE workspace_path IS NOT NULL
       AND (${NORMALIZED_WORKSPACE_SQL}) IS DISTINCT FROM workspace_path
  `);

  await client.query(`DROP INDEX IF EXISTS uq_bmad_projects_workspace`);
  await client.query(`
    CREATE UNIQUE INDEX uq_bmad_projects_workspace
      ON bmad_projects (${NORMALIZED_WORKSPACE_INDEX_EXPR})
      WHERE git_remote_url IS NULL AND workspace_path IS NOT NULL
  `);
}

/**
 * Every schema block, v2 through v9, applied to the caller's transaction.
 *
 * Split from ensureSchema so the transaction's shape (connect, lock, run,
 * commit) is readable on its own; nothing here opens or closes a
 * transaction, and nothing here takes a lock — the caller owns both.
 */
async function bootstrapSchema(client: PoolClient): Promise<void> {
  await migrateLegacySchema(client);

  // gen_random_uuid() is built into Postgres 13+; the extension attempt is a
  // no-op there and a best-effort fallback for older instances.
  //
  // The SAVEPOINT is not decoration: inside a single transaction a failed
  // statement aborts the whole transaction, so simply swallowing the error
  // would leave every following statement failing with 25P02 ("current
  // transaction is aborted"). Rolling back to a savepoint is the only way to
  // treat this one statement as optional as intended. It was a `try/catch`
  // around `pool.query` before D-1 — the same intent, and that context is gone.
  await client.query("SAVEPOINT pgcrypto_extension");
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await client.query("RELEASE SAVEPOINT pgcrypto_extension");
  } catch (extensionError) {
    // Ignore: extension may require privileges the app user lacks.
    try {
      await client.query("ROLLBACK TO SAVEPOINT pgcrypto_extension");
    } catch (rollbackError) {
      // A broken connection cannot be recovered by ignoring the extension. The
      // ORIGINAL failure stays attached as `cause` — otherwise the rollback's
      // own error would be all the operator sees, and the reason the boot died
      // would be lost.
      throw new Error(
        `[db] schema bootstrap failed: could not undo the optional pgcrypto extension ` +
          `(${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}) ` +
          `after the extension itself failed (${extensionError instanceof Error ? extensionError.message : String(extensionError)})`,
        { cause: extensionError }
      );
    }
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Member',
      team TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
    -- Existing v2 databases were created before revoked_reason existed.
    ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_reason TEXT;
  `);

  // ---- Schema v3: RBAC (roles, audit, FK) -------------------------------
  // Ordering matters: roles must exist AND be seeded before the FK is added,
  // because existing users.role rows must all satisfy the constraint. Every
  // value ever writable through the app is exactly Admin/Editor/Member, and
  // the seed covers those — so no UPDATE users statement is needed.
  await client.query(`
    -- 1. Roles
    CREATE TABLE IF NOT EXISTS roles (
      key         TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_system   BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 2. Audit trail (tiny, from day 1)
    CREATE TABLE IF NOT EXISTS role_audit (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- nullable: audit outlives actors
      action     TEXT NOT NULL,          -- 'role.created' | 'role.updated' | 'role.deleted' | 'role.permissions.replaced'
      role_key   TEXT NOT NULL,          -- raw key, not an FK: audit rows must survive role deletion
      diff       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_role_audit_role_key_created ON role_audit(role_key, created_at DESC);

    -- 3. Seed the 3 system roles. Keys MUST be the capitalized literals so existing
    --    users.role rows satisfy the FK below with zero migration.
    --    ON CONFLICT DO NOTHING = seeded once; admin edits to system roles survive
    --    restarts — which is also why the v4 wiki keys are appended here for FRESH
    --    databases only: an existing database's Editor/Member rows keep whatever an
    --    admin granted them, and pick wiki up through /permissions. Admin's ["*"]
    --    resolves against the catalog at request time, so it needs no seed change.
    INSERT INTO roles (key, name, description, permissions, is_system) VALUES
      ('Admin',  'Admin',  'Full access to every page and action',
        '["*"]'::jsonb, true),
      ('Editor', 'Editor', 'Workspace plus user management, no user deletion',
        '["home.view","ask-ai.view","ask-ai.use","agent-board.view","wiki.view",
          "wiki.create","wiki.update","wiki.comment","watching.view",
          "users.view","users.create","users.update",
          "providers.view","providers.manage"]'::jsonb, true),
      ('Member', 'Member', 'Workspace view access',
        '["home.view","ask-ai.view","ask-ai.use","agent-board.view","wiki.view",
          "watching.view"]'::jsonb, true)
    ON CONFLICT (key) DO NOTHING;

    -- 4. users.role becomes a real FK. Postgres has no ADD CONSTRAINT IF NOT EXISTS,
    --    so guard via pg_constraint in a DO block (idempotent across restarts).
    --    The check is scoped to the users table: a same-named constraint on any
    --    other table must not silently skip adding this FK.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'users_role_fkey' AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_fkey
          FOREIGN KEY (role) REFERENCES roles(key);
      END IF;
    END $$;
  `);

  // ---- Schema v4: Wiki + storage config ---------------------------------
  // Append-only and idempotent like the blocks above: every statement is
  // CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so a v3
  // database upgrades in place and a fresh one arrives at the same shape.
  //
  // FK policy (mirrors the RBAC tables):
  //   page children (labels links, comments, attachments) CASCADE — a page
  //     delete takes its discussion and its metadata with it;
  //   user references SET NULL — pages/comments/audit outlive their authors;
  //   audit `target` is a raw string, never an FK, so the row survives its
  //     subject exactly like role_audit.role_key does.
  await client.query(`
    -- 1. Generic key → JSONB store. Holds the S3 storage config; the
    --    requester decided credentials live in the database, not .env.
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL
    );

    -- 2. Wiki pages. content is the tiptap/ProseMirror document as JSONB.
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title      TEXT NOT NULL,
      content    JSONB NOT NULL DEFAULT 'null'::jsonb,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_updated ON wiki_pages(updated_at DESC);

    -- 3. Labels + the flat page↔label join.
    CREATE TABLE IF NOT EXISTS wiki_labels (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wiki_page_labels (
      page_id  UUID NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
      label_id UUID NOT NULL REFERENCES wiki_labels(id) ON DELETE CASCADE,
      PRIMARY KEY (page_id, label_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_page_labels_label ON wiki_page_labels(label_id);

    -- 4. Comments (author + timestamp; author survives as NULL).
    CREATE TABLE IF NOT EXISTS wiki_comments (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id    UUID NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
      author_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_comments_page ON wiki_comments(page_id, created_at DESC);

    -- 5. Attachments: METADATA ONLY — no file bytes ever enter Postgres.
    --    visibility decides how /api/wiki/files/[id] serves the object:
    --    'private' → short-lived presigned URL, 'public' → the public base.
    CREATE TABLE IF NOT EXISTS wiki_attachments (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id     UUID NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
      uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
      file_name   TEXT NOT NULL,
      mime_type   TEXT NOT NULL,
      size_bytes  BIGINT NOT NULL,
      s3_key      TEXT NOT NULL,
      visibility  TEXT NOT NULL DEFAULT 'private'
                  CHECK (visibility IN ('public', 'private')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_attachments_page ON wiki_attachments(page_id);

    -- 6. Audit trail for every wiki/storage mutation (mirrors role_audit).
    CREATE TABLE IF NOT EXISTS wiki_audit (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- nullable: audit outlives actors
      action     TEXT NOT NULL,  -- 'page.created' | 'page.updated' | 'page.deleted' | ...
      target     TEXT NOT NULL,  -- raw id string, not an FK: the row must survive its subject
      diff       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_audit_target_created ON wiki_audit(target, created_at DESC);

    -- ---- Schema v5: BMad Monitor Integration (Kanban, Worktree, Backlog) -
    -- 1. BMad Projects
    CREATE TABLE IF NOT EXISTS bmad_projects (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      git_remote_url TEXT,
      workspace_path TEXT,
      owner_id       UUID REFERENCES users(id) ON DELETE SET NULL,
      team_id        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 2. Context reference files reported by BMad skills
    CREATE TABLE IF NOT EXISTS bmad_context_files (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id      TEXT NOT NULL REFERENCES bmad_projects(id) ON DELETE CASCADE,
      path            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      file_size_bytes BIGINT NOT NULL DEFAULT 0,
      last_modified   TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bmad_context_files_project ON bmad_context_files(project_id);

    -- 3. Kanban Task Items (AffectUI Agent Inbox compatible)
    CREATE TABLE IF NOT EXISTS bmad_tasks (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES bmad_projects(id) ON DELETE CASCADE,
      title            TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      stage            TEXT NOT NULL DEFAULT 'ready_for_review',
      priority         TEXT NOT NULL DEFAULT 'medium',
      approval_status  TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      assigned_agent   TEXT NOT NULL DEFAULT 'bmad-agent',
      context_files    JSONB NOT NULL DEFAULT '[]'::jsonb,
      checklists       JSONB NOT NULL DEFAULT '[]'::jsonb,
      steps            JSONB NOT NULL DEFAULT '[]'::jsonb,
      sources          INT NOT NULL DEFAULT 0,
      tool_calls       INT NOT NULL DEFAULT 0,
      duration         TEXT NOT NULL DEFAULT '0s',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bmad_tasks_project_stage ON bmad_tasks(project_id, stage);

    -- 4. Agent Tree Nodes (AffectUI Agent Tree compatible with Token Usage)
    CREATE TABLE IF NOT EXISTS bmad_agent_nodes (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES bmad_projects(id) ON DELETE CASCADE,
      task_id      TEXT REFERENCES bmad_tasks(id) ON DELETE SET NULL,
      parent_id    TEXT REFERENCES bmad_agent_nodes(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'orchestrator',
      status       TEXT NOT NULL DEFAULT 'running',
      action       TEXT NOT NULL DEFAULT '',
      duration_ms  BIGINT NOT NULL DEFAULT 0,
      token_usage  JSONB NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"totalTokens":0}'::jsonb,
      model_used   JSONB NOT NULL DEFAULT '{"provider":"Anthropic","modelId":"claude-sonnet-5-5"}'::jsonb,
      artifacts    JSONB NOT NULL DEFAULT '[]'::jsonb,
      tools        JSONB NOT NULL DEFAULT '[]'::jsonb,
      error_detail TEXT,
      timestamp    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bmad_agent_nodes_project ON bmad_agent_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_bmad_agent_nodes_parent ON bmad_agent_nodes(parent_id);

    -- 5. Backlog & Code Impact Analysis
    CREATE TABLE IF NOT EXISTS bmad_backlogs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES bmad_projects(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      raw_description TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL DEFAULT 'web',
      created_by      TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'draft',
      impact_analysis JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bmad_backlogs_project ON bmad_backlogs(project_id);

    -- 6. Multi-Provider LLM Vault
    CREATE TABLE IF NOT EXISTS bmad_llm_providers (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      provider_type  TEXT NOT NULL DEFAULT 'anthropic',
      base_url       TEXT NOT NULL,
      api_key        TEXT NOT NULL,
      model_id       TEXT NOT NULL,
      is_team_shared BOOLEAN NOT NULL DEFAULT false,
      registered_by  TEXT NOT NULL DEFAULT '',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 7. Seed default project if none exists
    INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path) VALUES
      ('prj_default', 'Agentic Engineering Workflow', 'git@github.com:fatmuh/agentic-engineering-workflow.git', '/Volumes/DevWorkspace/Development/Projects/apps/agentic-engineering-workflow')
    ON CONFLICT (id) DO NOTHING;
  `);

  // ---- Schema v6: OAuth 2.0 PKCE for the BMad Monitor MCP CLI ----------
  // Append-only and idempotent like every block above: CREATE TABLE IF NOT
  // EXISTS / CREATE INDEX IF NOT EXISTS, so a v5 database upgrades in place
  // and a fresh one arrives at the same shape.
  //
  // oauth_refresh_tokens mirrors the web refresh_tokens pattern (sha256(jti),
  // rotatable, revocable) but stays a separate table: the MCP population
  // (CLI devices) and its revoke reasons must never touch the web session
  // path this feature is forbidden to change.
  await client.query(`
    -- 1. Single-use authorization codes issued by /oauth/authorize.
    --    Consumed exactly once by POST /api/oauth/token via an atomic
    --    UPDATE ... WHERE consumed_at IS NULL ... RETURNING.
    CREATE TABLE IF NOT EXISTS oauth_codes (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code                TEXT NOT NULL UNIQUE,
      code_challenge      TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      redirect_uri        TEXT NOT NULL,
      client_id           TEXT NOT NULL DEFAULT 'bmad-mcp-cli',
      user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at          TIMESTAMPTZ NOT NULL,
      consumed_at         TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_code ON oauth_codes(code);

    -- 2. MCP refresh material, sha256(jti), rotating on every use.
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash     TEXT NOT NULL UNIQUE,
      expires_at     TIMESTAMPTZ NOT NULL,
      revoked_at     TIMESTAMPTZ,
      revoked_reason TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_user_id ON oauth_refresh_tokens(user_id);
  `);

  // ---- Schema v7: project-scoped composite keys (BMad board) -----------
  // Separate from the guarded blocks above because it is DDL against
  // existing tables, not CREATE ... IF NOT EXISTS: see
  // migrateProjectScopedKeys for the per-step catalog guards.
  await migrateProjectScopedKeys(client);

  // ---- Schema v8: backlog promotion columns (BMad backlog flow) --------
  // Must run after v7: the FK references the composite
  // bmad_tasks (project_id, id) key v7 installs. Catalog-guarded steps in
  // migrateBacklogPromotion.
  await migrateBacklogPromotion(client);

  // ---- Schema v9: case-folded workspace identity (D-4) -----------------
  // Last, because it rebuilds the identity index v7 installed: it must see
  // the index (to drop it) and the column (to fold it). Catalog-guarded
  // steps in migrateWorkspaceCaseFold.
  await migrateWorkspaceCaseFold(client);
}

/**
 * Turn "could not take the bootstrap lock" into an error that says so.
 *
 * The story's I/O matrix requires that a losing instance fails with a message
 * naming the lock rather than an arbitrary DDL error: the whole failure mode
 * this design exists for is several processes booting against one database, and
 * an operator watching one of them die needs to know it was waiting, not that
 * the schema is broken. Only the two codes that mean exactly that are
 * rewritten; anything else is a real failure and must keep its own message
 * (a permission error must not read as "another instance is booting").
 */
function isLockTimeout(error: unknown): error is Error & { code: "55P03" } {
  return (error as { code?: string } | null)?.code === "55P03";
}

function describeBootstrapLockFailure(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  // 55P03 lock_not_available: `SET LOCAL lock_timeout` expired while waiting,
  // i.e. another instance has been holding the bootstrap lock for longer than
  // BOOTSTRAP_LOCK_TIMEOUT_MS. Retrying later is the fix — the error is not
  // memoised, because ensureSchema() resets schemaReady on any rejection.
  if (code === "55P03") {
    return new Error(
      `[db] schema bootstrap could not start: another process is holding the bootstrap lock ` +
        `(${BOOTSTRAP_LOCK_TIMEOUT_MS / 1000}s wait). If that process is stuck, stop it and retry; ` +
        `this instance will retry on the next request.`,
      { cause: error }
    );
  }
  // Nothing else is rewritten. In particular there is no separate
  // deadlock_detected (40P01) branch: the waiter holds no database lock while
  // it waits, so it can never be part of a cycle, and a same-process second
  // holder is seen by this process as an ordinary 55P03 timeout. Inventing a
  // branch for a code that cannot arrive would mislabel the case that does.
  return error;
}

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      // ONE client, ONE transaction, ONE lock for the entire bootstrap (D-1).
      //
      // Ordering is deliberate and is the whole point of this shape:
      //   1. connect   — a client, not `pool.query`: pool.query may use a
      //                  DIFFERENT connection for each statement, which would
      //                  put the DDL outside this transaction (and so outside
      //                  the lock) without any error.
      //   2. BEGIN
      //   3. SET LOCAL lock_timeout — so waiting for another instance's
      //                  bootstrap is bounded. LOCAL, so a normal request query
      //                  later on this same pooled connection is unaffected.
      //   4. pg_advisory_xact_lock — BEFORE the first DDL statement. Taking it
      //                  between blocks is too late: v2–v6 have already raced,
      //                  and `CREATE TABLE IF NOT EXISTS` loses that race on
      //                  `pg_type_typname_nsp_index`.
      //   5. every schema block on this client
      //   6. COMMIT / ROLLBACK
      //
      // Deadlock reasoning (this is why the lock is taken first and nothing else
      // is): the waiting instance holds exactly ONE pool connection and no
      // database locks while it waits. Every later statement runs on the client
      // that already owns the lock, so bootstrap never waits on a lock while
      // holding one that the lock holder could need. The pool has 10
      // connections; bootstrap consumes one for its duration, which leaves 9
      // for request traffic, and bootstrap waits behind no request because no
      // request takes a conflicting lock (the lock is only ever taken here).
      // The readiness probe the harness runs is itself a normal request: it
      // awaits this same memoized promise in-process, or simply queues on
      // `pool.connect()` in another process, and neither can hold a lock the
      // bootstrap needs.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL lock_timeout = ${BOOTSTRAP_LOCK_TIMEOUT_MS}`);
        try {
          await client.query("SELECT pg_advisory_xact_lock($1)", [
            SCHEMA_BOOTSTRAP_ADVISORY_LOCK,
          ]);
        } catch (error) {
          // Only THIS statement is translated. A lock_timeout hit anywhere else
          // in the transaction — an ALTER waiting behind a request's table
          // lock, say — propagates untouched, so this message can never claim
          // "the bootstrap lock was held" for a wait that was not one.
          throw describeBootstrapLockFailure(error);
        }

        try {
          await bootstrapSchema(client);
        } catch (error) {
          // `SET LOCAL lock_timeout` covers the rest of the transaction, not
          // just the advisory lock. A timeout inside a later DDL therefore
          // arrives as a bare 55P03 with nothing saying where it came from —
          // name the bootstrap phase, and keep the original code so anything
          // matching on 55P03 still sees it.
          if (isLockTimeout(error)) {
            const wrapped = new Error(
              `[db] schema bootstrap timed out waiting for a database lock inside a ` +
                `migration block (lock_timeout ${BOOTSTRAP_LOCK_TIMEOUT_MS / 1000}s): ` +
                `${error instanceof Error ? error.message : String(error)}. ` +
                `Retry once the other session's transaction ends; this instance will retry on the next request.`,
              { cause: error }
            ) as Error & { code?: string };
            wrapped.code = (error as { code?: string }).code;
            throw wrapped;
          }
          throw error;
        }

        await client.query("COMMIT");
      } catch (error) {
        // Any failure — a DDL error, a v7/v8/v9 guard rejecting the data, or
        // the lock itself — rolls the WHOLE bootstrap back. Nothing is left
        // half-applied: no table without its primary key, no unfolded column
        // under a folded index.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      // Allow a later request to retry if bootstrap failed (e.g. DB was down,
      // or the lock was held past lock_timeout by another instance).
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  await ensureSchema();
  const result = await pool.query(text, params);
  return result as QueryResult<T>;
}
