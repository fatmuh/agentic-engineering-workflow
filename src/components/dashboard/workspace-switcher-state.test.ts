import { describe, expect, it } from "vitest";
import {
  WORKSPACE_LIST_FAILED,
  WORKSPACE_LIST_STALE,
  switcherCopy,
} from "./workspace-switcher-state";

/**
 * The Workspace Switcher's copy rules, as pure logic. The component itself
 * needs a DOM (which this suite deliberately does not have), but every case
 * below is a rule that was actually broken once: a blank trigger, a failure
 * that hid a usable list, an accessible name that did not contain the visible
 * text, and a ready-but-stale selection.
 */
describe("switcherCopy", () => {
  it("loading says it is loading instead of leaving the trigger blank", () => {
    const copy = switcherCopy("loading", 0, "");
    expect(copy.trigger).toBe("Memuat workspace…");
    expect(copy.note).toBe("Memuat daftar workspace…");
    expect(copy.staleFailure).toBeUndefined();
  });

  it("an empty list on error reports the failure", () => {
    const copy = switcherCopy("error", 0, "");
    expect(copy.trigger).toBe("Gagal memuat workspace");
    // One sentence, shared with the board's recovery notice.
    expect(copy.note).toBe(WORKSPACE_LIST_FAILED);
    expect(copy.staleFailure).toBeUndefined();
  });

  it("a ready list with no workspaces says so", () => {
    const copy = switcherCopy("ready", 0, "");
    expect(copy.trigger).toBe("Belum ada workspace");
    expect(copy.note).toBe("Belum ada workspace terdaftar.");
  });

  it("a ready list with an active workspace is just the name and the radio list", () => {
    const copy = switcherCopy("ready", 3, "Acme Production");
    expect(copy).toEqual({
      trigger: "Acme Production",
      label: "Acme Production — ganti workspace",
      note: null,
    });
  });

  it("a non-empty list keeps naming the active workspace after a failed refresh", () => {
    // The rows are still selectable; hiding the name behind failure copy was
    // the defect. The failure moves to the menu note instead.
    const copy = switcherCopy("error", 3, "Acme Production");
    expect(copy.trigger).toBe("Acme Production");
    expect(copy.label).toBe("Acme Production — ganti workspace; daftar workspace gagal dimuat");
    expect(copy.note).toContain("gagal dimuat");
    expect(copy.staleFailure).toBe(true);
  });

  it("a non-empty list with no active workspace explains the blank name", () => {
    // Never a blank chip: the trigger names the action, and the menu says why
    // no row is marked.
    const copy = switcherCopy("ready", 2, "");
    expect(copy.trigger).toBe("Pilih workspace");
    expect(copy.label).toBe("Pilih workspace — ganti workspace; belum ada workspace aktif");
    expect(copy.note).toContain("Belum ada workspace aktif");
  });

  it("the failed-but-populated list with no active row still avoids a blank trigger", () => {
    const copy = switcherCopy("error", 2, "");
    expect(copy.trigger).toBe("Pilih workspace");
    expect(copy.staleFailure).toBe(true);
  });

  it.each([
    ["loading", 0, ""],
    ["error", 0, ""],
    ["ready", 0, ""],
    ["ready", 2, ""],
    ["ready", 2, "Acme"],
    ["error", 2, "Acme"],
  ] as const)("every state names itself and starts with its visible text (%s, %i, %s)", (status, count, name) => {
    const copy = switcherCopy(status, count, name);
    expect(copy.trigger.length).toBeGreaterThan(0);
    // WCAG 2.5.3: the accessible name must contain the visible label verbatim,
    // so a voice-control user can say what they see.
    expect(copy.label.startsWith(copy.trigger)).toBe(true);
  });
});

describe("the shared failure sentences", () => {
  it("a stale list adds the caveat rather than contradicting the base sentence", () => {
    // The switcher's note for a failed refresh over rows; the board and
    // sidebar can never reach this state and use the base sentence alone.
    expect(WORKSPACE_LIST_STALE).toContain(WORKSPACE_LIST_FAILED);
    expect(WORKSPACE_LIST_STALE).not.toBe(WORKSPACE_LIST_FAILED);
  });
});
