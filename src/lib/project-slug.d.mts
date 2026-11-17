/**
 * Type declarations for src/lib/project-slug.mjs. Runtime implementation and
 * its full documentation live there; keep the two in sync.
 */

export const MAX_SLUG_LENGTH: number;
export const FALLBACK_SLUG: string;
export function slugify(name: string): string;
export function nextFreeSlug(base: string, taken: ReadonlySet<string>): string;
export function isProjectIdSegment(segment: string): boolean;
export function nextFreeSlugSql(param: string): string;
