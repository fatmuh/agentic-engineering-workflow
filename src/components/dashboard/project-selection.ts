/**
 * The pure half of workspace-selection persistence: which stored id another
 * tab's `storage` event carries, whether this tab may adopt it, and whether
 * the persist effect should write at all.
 *
 * It lives here, without React or DOM values, because `vitest.config.mts` runs
 * the node environment only (the repo has no jsdom) — the rules below are
 * exactly the ones that used to be unreachable from a test. This module owns
 * `ProjectStatus` so the dependency arrow points one way: `project-context`
 * (a client component) imports from here, never the reverse.
 *
 * Two rules carry the weight:
 *
 *   1. Only an id that exists in the list this tab has already loaded may be
 *      applied. An unknown value is ignored, never treated as "clear the
 *      selection": the other tab may simply be running a newer list.
 *   2. A tab that just applied an id from another tab must not write it back.
 *      The write would echo into the other tab and start a write loop whose
 *      only accidental brake is the browser's same-value dedupe in
 *      `setItem` — an implementation detail, not a guarantee this code should
 *      rest on. The marker therefore stays set for as long as this tab's
 *      selection is the received id, and is dropped only when the selection
 *      moves off it (see `persistSelection`).
 */

/** Where the project list stands. `"error"` means the list could not be read —
 *  not that there are no projects. Lives here, not in `project-context`, so a
 *  pure module can name it without importing a `"use client"` module; the
 *  context re-exports it for every consumer. */
export type ProjectStatus = "loading" | "ready" | "error";

/** Remembers the selection across reloads and across tabs. Holds a project
 *  *id*: workspace names are display labels, and the API does not promise they
 *  are unique. */
export const ACTIVE_PROJECT_KEY = "bmad-monitor.active-project-id";

/** The slice of `Storage` used here. Deliberately narrow: the caller supplies
 *  `window.localStorage` through a thunk, because even *reading* the property
 *  throws when storage is blocked (private mode, some embedded browsers). */
export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The remembered selection, or `null`. Never throws: blocked storage costs
 *  the user persistence, not the page. */
export function readSelection(access: () => SelectionStorage): string | null {
  try {
    return access().getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

/** Store (or, with `null`, forget) the selection. Never throws, same reason. */
export function writeSelection(access: () => SelectionStorage, id: string | null): void {
  try {
    if (id) access().setItem(ACTIVE_PROJECT_KEY, id);
    else access().removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    // The selection simply does not survive a reload.
  }
}

/** The fields of the DOM `StorageEvent` this module reads. `storageArea` is
 *  optional so a caller (and the tests) can omit it — a hand-built event in a
 *  node test has no `Storage` objects to compare. */
export interface StorageEventLike {
  key: string | null;
  newValue: string | null;
  /** Present in real events. When present it must be this page's
   *  `localStorage`: a same-key write to `sessionStorage` (from an iframe, or
   *  by another library) fires the same event and must not switch the tab. */
  storageArea?: unknown;
}

/**
 * The project id another tab just selected, or `null` when the event must be
 * ignored: another key, a removal (`newValue === null`, also how `clear()`
 * arrives — with `key === null`), an empty value, an event from a storage area
 * that is not this tab's `localStorage`, or an id missing from the list already
 * loaded here.
 */
export function selectionFromStorageEvent(
  event: StorageEventLike,
  projectIds: readonly string[],
  localStorageArea?: unknown,
): string | null {
  if (event.key !== ACTIVE_PROJECT_KEY) return null;
  if (
    event.storageArea !== undefined &&
    localStorageArea !== undefined &&
    event.storageArea !== localStorageArea
  ) {
    return null;
  }
  const id = event.newValue;
  if (!id) return null;
  return projectIds.includes(id) ? id : null;
}

export interface PersistSelectionInput {
  /** The project list's own state; only a `"ready"` list confirms a selection. */
  status: ProjectStatus;
  projectId: string | null;
  /** How many projects the loaded list carries (zero is a real answer). */
  projectCount: number;
  /** What `localStorage` holds right now. */
  stored: string | null;
  /** The id this tab last adopted from another tab's event, if it still owns
   *  the selection — the origin marker. */
  received: string | null;
}

/**
 * The id the persist effect should store on this render, or `null` when it must
 * write nothing.
 *
 * - A selection this tab adopted from another tab is not written back, for as
 *   long as it is still the selection. The caller holds the marker until the
 *   selection moves off it (the user picks here, or another event arrives),
 *   because every pass with the same value must skip — clearing the marker
 *   after one pass would let the next pass write the received id back and start
 *   the loop one round later.
 * - A value already stored is not re-written. Booting a tab would otherwise
 *   `setItem` the id it just read on every mount — harmless only because the
 *   browser dedupes identical values, which is the dedupe this module refuses
 *   to depend on elsewhere.
 * - Only a selection the list confirmed is persisted: writing while `projectId`
 *   is still `null` would erase the remembered id before the fetch that reads
 *   it lands.
 * - An empty list never clears a stored id — one transient incomplete response
 *   would otherwise erase the user's choice for good.
 */
export function persistSelection(input: PersistSelectionInput): string | null {
  const { status, projectId, projectCount, stored, received } = input;

  if (received !== null && received === projectId) return null;
  if (status !== "ready" || projectId === null) return null;
  if (projectCount === 0 && stored !== null) return null;
  if (stored === projectId) return null;
  return projectId;
}
