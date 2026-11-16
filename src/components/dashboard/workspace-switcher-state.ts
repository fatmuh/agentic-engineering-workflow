import type { ProjectStatus } from "./project-selection";

/**
 * The one sentence for a workspace list that could not be read. Four spellings
 * of this across three modules (and e2e regexes pinned to two of them) is how
 * the board's recovery copy drifted away from the switcher's; every surface
 * that reports the failure now reads it from here.
 */
export const WORKSPACE_LIST_FAILED = "Daftar workspace gagal dimuat.";

/** The same failure when rows from the last successful load are still on
 *  screen, so the list is stale rather than absent. Reached by the switcher
 *  menu, whose rows survive a failed refresh; the board and sidebar notices
 *  cannot reach that state (nothing reloads the list while rows are loaded),
 *  so they always use `WORKSPACE_LIST_FAILED`. */
export const WORKSPACE_LIST_STALE = "Daftar workspace gagal dimuat. Daftar workspace mungkin sudah tidak terbaru.";

/** What the Workspace Switcher's trigger and menu say for a given state.
 *  `trigger` is the visible trigger text, `label` the trigger's accessible
 *  name, and `note` the sentence added to the menu's group label (or `null`
 *  when the ordinary list needs no explanation). */
export interface SwitcherCopy {
  trigger: string;
  label: string;
  note: string | null;
  /** The list failed even though rows are still on screen (a failed refresh). */
  staleFailure?: boolean;
}

/** Visible text first, state clause second — WCAG 2.5.3 (Label in Name): a
 *  voice-control user says what they see, and the accessible name has to
 *  contain it. An `aria-label` that rewords the trigger breaks that. */
function label(trigger: string, clause: string): string {
  return `${trigger} — ${clause}`;
}

/**
 * The switcher must never render as a blank chip, and it must never stop
 * naming the active workspace while the user can still pick one.
 *
 * Precedence:
 *   1. a non-empty list always names the active workspace — a failed refresh
 *      keeps the rows selectable, so replacing the name would hide the one
 *      thing the user needs; the failure becomes a menu note instead
 *   2. otherwise the list's own state speaks (loading, error, empty)
 *   3. a list that is ready and non-empty but does not contain `value`
 *      (e.g. the remembered id is gone) says so rather than using an empty
 *      name, which `activeName` would otherwise supply.
 */
export function switcherCopy(
  status: ProjectStatus,
  workspaceCount: number,
  activeName: string,
): SwitcherCopy {
  if (workspaceCount > 0) {
    if (status === "error") {
      const trigger = activeName || "Pilih workspace";
      return {
        trigger,
        label: label(trigger, "ganti workspace; daftar workspace gagal dimuat"),
        note: WORKSPACE_LIST_STALE,
        staleFailure: true,
      };
    }
    if (activeName) {
      return {
        trigger: activeName,
        label: label(activeName, "ganti workspace"),
        note: null,
      };
    }
    // Rows exist, but none of them is the active one.
    return {
      trigger: "Pilih workspace",
      label: label("Pilih workspace", "ganti workspace; belum ada workspace aktif"),
      note: "Belum ada workspace aktif. Pilih salah satu workspace di bawah.",
    };
  }

  if (status === "loading") {
    const trigger = "Memuat workspace…";
    return {
      trigger,
      label: label(trigger, "ganti workspace; daftar workspace sedang dimuat"),
      note: "Memuat daftar workspace…",
    };
  }
  if (status === "error") {
    const trigger = "Gagal memuat workspace";
    return {
      trigger,
      label: label(trigger, "ganti workspace; daftar workspace gagal dimuat"),
      note: WORKSPACE_LIST_FAILED,
    };
  }
  const trigger = "Belum ada workspace";
  return {
    trigger,
    label: label(trigger, "ganti workspace; belum ada workspace terdaftar"),
    note: "Belum ada workspace terdaftar.",
  };
}
