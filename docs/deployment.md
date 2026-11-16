# Deployment & schema bootstrap

What an operator needs to know about starting this app against a database, and
the one rollout rule that code cannot enforce for you.

## The bootstrap runs once per process, in one transaction

`ensureSchema()` (`src/lib/db.ts`) creates and migrates every table. It runs
lazily on the first request that touches the database, once per process, and it
is **one transaction on one connection**:

```
connect → BEGIN → SET LOCAL lock_timeout → pg_advisory_xact_lock → every block → COMMIT
```

The advisory lock is taken **before the first DDL statement**. That is the whole
point: `CREATE TABLE IF NOT EXISTS` is not atomic against a concurrent
`CREATE TABLE`, so two processes booting together used to lose the race on
`pg_type_typname_nsp_index` (measured: 1 of 8 concurrent boots failed).

Consequences worth knowing:

- **A fresh database takes one extra connection for the boot's duration.** The
  pool has 10; a cold database with heavy traffic during boot still has 9.
- **A failed boot rolls the whole thing back.** Nothing is half-applied, and
  `schemaReady` is reset so the next request retries. A hand-damaged database
  that used to let the v2 block "apply what it could" now fails the boot
  outright — read the error, it names the table or the duplicated project.
- **A stuck first boot does not hang the others forever.** Waiters give up after
  `BOOTSTRAP_LOCK_TIMEOUT_MS` (60s) with a message naming the bootstrap lock,
  and retry on the next request.

## The rollout rule code cannot enforce

**Do not run old and new builds at the same time against one database.**

The lock only works when both sides take it. Builds from before this change run
their schema work as plain `pool.query()` calls and never ask for the advisory
lock, so a new instance waiting on that lock is waiting for a holder that will
never appear. If the old and new processes overlap, the original `pg_type` race
returns for the duration of the overlap.

- **Rolling deploy (one version live at a time):** safe, and this is the
  assumption the boot path is written for.
- **Blue/green or canary with both versions live:** the new instances are safe
  with each other; the overlap with the old ones is not. Either drain the old
  version first, or take the app down for the migration.

This is a deployment property, not a code bug: nothing a new build does can
make an old build take a lock it does not know about.

## Verifying a deploy

```bash
npm run test:multi-instance   # 8 processes booting against one empty database
```

The script boots a reference database single-process, then N (default 8,
`--processes=N`, max 64) against one empty database at once, and fails if any
boot fails or if the resulting catalog, `bmad_projects` or `roles` differ from
the reference. CI runs it (`npm run test:multi-instance` step) after `verify`.

### Verifying the MCP client contract

```bash
# the binary lives in the other repo
cd ../bmad-monitor-mcp && go build -o /tmp/bmad-monitor ./cmd/bmad-monitor && cd -
npm run test:mcp -- --binary /tmp/bmad-monitor
```

`scripts/verify-mcp-tools.mjs` drives the real binary over stdio against its own
scratch database and an isolated `HOME`, then asserts the database after each
write: `awm_project_init`, `awm_context_report`, `awm_agent_progress`,
`awm_task_create_batch`, `awm_task_update`, `awm_task_wait_approval`,
`awm_project_list`.

It is a **manual** gate on purpose — it needs a second repository and a Go
toolchain, so it is not part of `npm run verify`. It refuses to run (exit 2)
when the binary, the production build, or the port is not available, rather than
passing without testing anything, and it cleans up on failure and on
SIGINT/SIGTERM.

## Secrets at rest

- **Provider API keys** are encrypted with AES-256-GCM under a key derived from
  `AUTH_SECRET`. The API still returns them in clear text — the Go MCP client
  turns them into `ANTHROPIC_API_KEY` — so anyone with a valid bearer can read
  them. The encryption removes the "leaked dump or backup" path, not the API
  path. Rotating `AUTH_SECRET` makes existing provider keys unreadable: re-enter
  them from `/providers` afterwards.
- **Credential-bearing git remotes** are rejected on input (400) and never
  returned for rows written before that rule, but the old rows are not
  rewritten — clean them by hand if you care to.
