/**
 * Type declarations for scripts/catalog-shape.mjs — shared catalog
 * introspection for the bootstrap proof (CAP-1).
 *
 * TypeScript resolves an `.mjs` import through its `.d.mts` sibling (JS-source
 * inference is unreliable for these). The runtime implementation and its full
 * documentation live in catalog-shape.mjs. Keep the two in sync when changing
 * the module's surface.
 */

/** Floor for a full bootstrap catalog dump (currently 381 rows). */
export const MIN_CATALOG_ROWS: number;

/**
 * Every table, column, constraint and index in `public`, one sorted
 * `kind\tname\tdetail` line each.
 */
export function readCatalogShape(connectionString: string): Promise<string[]>;

/** Line-by-line difference between two dumps; empty means identical. */
export function diffCatalogShapes(
  reference: readonly string[],
  actual: readonly string[],
): string[];

/** Row count per relation, keyed by relation name. */
export function readRelationRowCounts(
  connectionString: string,
  relations: readonly string[],
): Promise<Record<string, number>>;
