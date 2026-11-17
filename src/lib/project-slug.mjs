/**
 * Workspace slugs: the readable half of `/agent-board/<slug>`.
 *
 * Plain `.mjs` with a `.d.mts` sibling, like ./schema-bootstrap.mjs: db.ts
 * imports it, and db.ts runs under plain Node too
 * (scripts/verify-multi-instance.mjs), where a relative import needs a real
 * filename.
 *
 * A slug is derived from the project name once, when the row is created (or
 * backfilled at boot for rows that predate slugs), and never follows a later
 * rename: a shared link must keep pointing at the same workspace. Names are not
 * unique, so a taken slug gets the first free `-2`, `-3`, … suffix.
 *
 * Slugs use `[a-z0-9-]` only, so one can never be mistaken for a `prj_*` id
 * (which carries an underscore): a URL segment is looked up as an id when it
 * starts with `prj_` and as a slug otherwise.
 *
 * Pure: no `pg`, so the rules are testable without a database. The SQL that
 * picks a free suffix at insert time is {@link NEXT_FREE_SLUG_SQL}.
 */

export const MAX_SLUG_LENGTH = 48;

/** Slug used when a name has no ASCII letters or digits at all. */
export const FALLBACK_SLUG = "workspace";

export function slugify(name) {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || FALLBACK_SLUG;
}

/** The first of `base`, `base-2`, `base-3`, … that is not in `taken`. */
export function nextFreeSlug(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** True when a URL segment names a project by id rather than by slug. */
export function isProjectIdSegment(segment) {
  return segment.startsWith("prj_");
}

/**
 * SQL expression for the slug of a new row, given the base slug as parameter
 * `$n`: the same rule as {@link nextFreeSlug}, evaluated inside the INSERT so
 * the check and the write are one statement. Two concurrent inserts of the
 * same name can still pick the same value; `uq_bmad_projects_slug` rejects the
 * loser, and callers retry ({@link isSlugViolation} in ./projects).
 */
export function nextFreeSlugSql(param) {
  return `(CASE WHEN NOT EXISTS (SELECT 1 FROM bmad_projects WHERE slug = ${param}) THEN ${param}
     ELSE ${param} || '-' || (
       SELECT min(n) FROM generate_series(2, (SELECT count(*) FROM bmad_projects) + 2) AS n
       WHERE NOT EXISTS (SELECT 1 FROM bmad_projects WHERE slug = ${param} || '-' || n)
     ) END)`;
}
