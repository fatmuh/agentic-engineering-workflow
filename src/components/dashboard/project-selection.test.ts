import { describe, expect, it } from "vitest";
import {
  ACTIVE_PROJECT_KEY,
  persistSelection,
  readSelection,
  selectionFromStorageEvent,
  writeSelection,
  type SelectionStorage,
  type StorageEventLike,
} from "./project-selection";

/**
 * The workspace-selection persistence rules, as pure logic. The component
 * around them needs a DOM this suite deliberately does not have, but every
 * case below is a rule from the story's I/O matrix — and the oscillation case
 * is one a naive "apply then write the same value back" listener actually
 * fails, so it is exercised as a two-tab simulation rather than asserted in
 * the abstract.
 */

const PROJECTS = ["prj_a", "prj_b"];

/** A `Storage`-shaped fake whose `setItem` records writes, standing in for
 *  `window.localStorage` (which has no implementation in node). */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  const removes: string[] = [];
  const storage: SelectionStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      writes.push({ key, value });
      data.set(key, value);
    },
    removeItem: key => {
      removes.push(key);
      data.delete(key);
    },
  };
  return { storage, data, writes, removes };
}

const event = (key: string | null, newValue: string | null): StorageEventLike => ({ key, newValue });

describe("selectionFromStorageEvent", () => {
  it("applies an id that exists in the list this tab already loaded", () => {
    expect(selectionFromStorageEvent(event(ACTIVE_PROJECT_KEY, "prj_b"), PROJECTS)).toBe("prj_b");
  });

  it("ignores an id the loaded list does not contain, instead of clearing the selection", () => {
    // The other tab may be running a newer list (or a stale one after a
    // deletion); neither is a reason to drop this tab's selection.
    expect(selectionFromStorageEvent(event(ACTIVE_PROJECT_KEY, "prj_gone"), PROJECTS)).toBeNull();
  });

  it("ignores a different key", () => {
    expect(selectionFromStorageEvent(event("bmad-monitor.something-else", "prj_b"), PROJECTS)).toBeNull();
  });

  it("ignores a removal, and the key-less event storage clear() produces", () => {
    expect(selectionFromStorageEvent(event(ACTIVE_PROJECT_KEY, null), PROJECTS)).toBeNull();
    expect(selectionFromStorageEvent(event(null, null), PROJECTS)).toBeNull();
  });

  it("ignores an empty value rather than treating it as a selection", () => {
    expect(selectionFromStorageEvent(event(ACTIVE_PROJECT_KEY, ""), PROJECTS)).toBeNull();
  });

  it("ignores a valid id when this tab has not loaded any project yet", () => {
    // No list means no way to validate the id; applying it would point the
    // board at a project it cannot name.
    expect(selectionFromStorageEvent(event(ACTIVE_PROJECT_KEY, "prj_a"), [])).toBeNull();
  });

  it("applies an event whose storageArea IS this tab's localStorage", () => {
    const local = {};
    expect(selectionFromStorageEvent(
      { key: ACTIVE_PROJECT_KEY, newValue: "prj_b", storageArea: local }, PROJECTS, local,
    )).toBe("prj_b");
  });

  it("ignores a same-key write to another storage area (a sessionStorage write in an iframe)", () => {
    // `sessionStorage` writes fire the SAME `storage` event on same-origin
    // frames; they are not workspace selections and must not switch this tab.
    expect(selectionFromStorageEvent(
      { key: ACTIVE_PROJECT_KEY, newValue: "prj_b", storageArea: {} }, PROJECTS, {},
    )).toBeNull();
  });

  it("still validates when either side has no area to compare (hand-built events, blocked storage)", () => {
    // Real events always carry an area, but the guard must not turn into a
    // blanket rejection when one is missing.
    expect(selectionFromStorageEvent(event(ACTIVE_PROJECT_KEY, "prj_b"), PROJECTS)).toBe("prj_b");
    expect(selectionFromStorageEvent(
      { key: ACTIVE_PROJECT_KEY, newValue: "prj_b", storageArea: {} }, PROJECTS,
    )).toBe("prj_b");
  });
});

describe("persistSelection", () => {
  it("writes the user's own selection once the list confirms it", () => {
    expect(persistSelection({
      status: "ready", projectId: "prj_b", projectCount: 2, stored: "prj_a", received: null,
    })).toBe("prj_b");
  });

  it("does not write back an id that just arrived from another tab (the oscillation brake)", () => {
    expect(persistSelection({
      status: "ready", projectId: "prj_b", projectCount: 2, stored: "prj_b", received: "prj_b",
    })).toBeNull();
  });

  it("keeps skipping while the selection is still the received one, whatever the list state", () => {
    // A storage event can land before the initial fetch settles, and the
    // fetch's own render follows it. Neither pass may write, and neither may
    // "consume" the marker for the other.
    expect(persistSelection({
      status: "loading", projectId: "prj_b", projectCount: 0, stored: "prj_a", received: "prj_b",
    })).toBeNull();
    expect(persistSelection({
      status: "ready", projectId: "prj_b", projectCount: 2, stored: "prj_a", received: "prj_b",
    })).toBeNull();
  });

  it("a stale marker for a selection the user then changed does not suppress that write", () => {
    // The user picked prj_a while the marker still pointed at prj_b; their own
    // choice persists as usual.
    expect(persistSelection({
      status: "ready", projectId: "prj_a", projectCount: 2, stored: "prj_b", received: "prj_b",
    })).toBe("prj_a");
  });

  it("writes nothing during loading and never erases the remembered id", () => {
    expect(persistSelection({
      status: "loading", projectId: null, projectCount: 0, stored: "prj_a", received: null,
    })).toBeNull();
  });

  it("does not clear the stored id on an empty successful list", () => {
    expect(persistSelection({
      status: "ready", projectId: null, projectCount: 0, stored: "prj_a", received: null,
    })).toBeNull();
  });

  it("does not re-write the id that is already stored (a tab simply booting)", () => {
    // The most common runtime path: the stored id is read, the list confirms
    // it, and the selection never changes. Writing here would be a redundant
    // `setItem` per mount, saved only by the browser's same-value dedupe.
    expect(persistSelection({
      status: "ready", projectId: "prj_a", projectCount: 2, stored: "prj_a", received: null,
    })).toBeNull();
  });

  it("still writes when the stored id differs, so a change reaches the other tabs", () => {
    expect(persistSelection({
      status: "ready", projectId: "prj_b", projectCount: 2, stored: "prj_a", received: null,
    })).toBe("prj_b");
    expect(persistSelection({
      status: "ready", projectId: "prj_b", projectCount: 2, stored: null, received: null,
    })).toBe("prj_b");
  });

  it("does not write anything after a failed list", () => {
    expect(persistSelection({
      status: "error", projectId: null, projectCount: 0, stored: null, received: null,
    })).toBeNull();
  });
});

describe("blocked localStorage", () => {
  /** Reproduces a browser where merely reading `localStorage` throws. */
  const blocked = (): SelectionStorage => {
    throw new Error("SecurityError: storage is disabled");
  };

  it("reads as null instead of crashing the page", () => {
    expect(readSelection(blocked)).toBeNull();
  });

  it("swallows the write failure", () => {
    expect(() => writeSelection(blocked, "prj_a")).not.toThrow();
    expect(() => writeSelection(blocked, null)).not.toThrow();
  });

  it("still round-trips inside the tab through React state — storage is only the cross-reload memory", () => {
    // Nothing to persist, but the selection this tab holds is unaffected; the
    // in-tab flow never asks storage for the current value.
    const write = persistSelection({
      status: "ready", projectId: "prj_b", projectCount: 2, stored: readSelection(blocked), received: null,
    });
    expect(write).toBe("prj_b");
  });
});

describe("readSelection / writeSelection", () => {
  it("writes the id under the unchanged key and forgets it on null", () => {
    const { storage, data, writes, removes } = fakeStorage();
    writeSelection(() => storage, "prj_a");
    expect(writes).toEqual([{ key: "bmad-monitor.active-project-id", value: "prj_a" }]);
    expect(readSelection(() => storage)).toBe("prj_a");

    writeSelection(() => storage, null);
    expect(removes).toEqual([ACTIVE_PROJECT_KEY]);
    expect(data.has(ACTIVE_PROJECT_KEY)).toBe(false);
  });
});

/**
 * Two tabs sharing one `localStorage`, with `storage` events delivered to the
 * OTHER tab only — the browser's rule. Each tab runs the same listener and the
 * same persist decision the provider runs, so this is a model of the real
 * wiring rather than a restatement of it.
 *
 * Two switches, because two different brakes are under test and only one of
 * them belongs to the code:
 *
 *   - `honorMarker` — the origin marker. Off, the listener writes back what it
 *     received, which is the naive implementation and the actual bug.
 *   - `dedupeEqualWrites` — the browser's same-value `setItem` dedupe. Off, a
 *     redundant write still fires an event, so the marker has to be what stops
 *     the loop rather than the browser quietly swallowing it.
 *
 * `mirrorRenderBailout` mirrors React: `setProjectIdState(c => c === next ? c
 * : next)` commits no render for an identical value, so the persist effect
 * does not run either. The provider is modelled with it ON; it is off only to
 * prove the marker stands on its own even if a pass were forced.
 */
function twoTabs(options: {
  honorMarker: boolean;
  dedupeEqualWrites: boolean;
  mirrorRenderBailout?: boolean;
  /** Hide the stored-id equality from the decision, so the marker is the only
   *  brake left. Used to prove the marker is load-bearing on its own: the
   *  stored-equality rule is an independent guard that would otherwise mask a
   *  missing marker in this scenario, where storage and selection already
   *  agree by construction. */
  ignoreStoredEquality?: boolean;
}) {
  const mirrorRenderBailout = options.mirrorRenderBailout ?? true;
  const shared = new Map<string, string>([[ACTIVE_PROJECT_KEY, "prj_a"]]);

  interface Tab {
    projectId: string;
    /** The origin marker: the id this tab just adopted from the other one. */
    received: string | null;
    writes: number;
    applied: string[];
  }

  const tabs: Tab[] = [
    { projectId: "prj_a", received: null, writes: 0, applied: [] },
    { projectId: "prj_a", received: null, writes: 0, applied: [] },
  ];
  // Queued, never delivered inline: an inline dispatch of a synchronous write
  // would recurse rather than ping-pong, which hides the two-tab shape.
  const queue: Array<{ to: number; event: StorageEventLike }> = [];

  const write = (from: number, value: string): void => {
    const current = shared.get(ACTIVE_PROJECT_KEY) ?? null;
    if (options.dedupeEqualWrites && current === value) return;
    shared.set(ACTIVE_PROJECT_KEY, value);
    tabs[from].writes += 1;
    queue.push({ to: 1 - from, event: { key: ACTIVE_PROJECT_KEY, newValue: value } });
  };

  /** The provider's persist effect, for one tab.
   *
   *  With the marker, this is the shipping effect: `persistSelection` decides.
   *  Without it, this is the pre-story effect — `storeProjectId(projectId)`
   *  with no decision at all — because "just add a storage listener" on top of
   *  that old effect is what the naive case has to model. Modelling the naive
   *  case as "the new effect minus one branch" would smuggle in the stored-id
   *  guard, which is a separate brake and would hide the loop. */
  const persist = (index: number): void => {
    const tab = tabs[index];
    if (!options.honorMarker) {
      if (tab.projectId !== null) write(index, tab.projectId);
      return;
    }
    const next = persistSelection({
      status: "ready",
      projectId: tab.projectId,
      projectCount: PROJECTS.length,
      stored: options.ignoreStoredEquality ? null : shared.get(ACTIVE_PROJECT_KEY) ?? null,
      received: tab.received,
    });
    if (next === null) return;
    write(index, next);
    // The provider drops the marker only on a pass that writes, i.e. once the
    // selection is no longer the received one.
    tab.received = null;
  };

  /** The tab's `storage` listener, mirroring the provider exactly. */
  const receive = (index: number, event: StorageEventLike): void => {
    const tab = tabs[index];
    const id = selectionFromStorageEvent(event, PROJECTS);
    if (id === null) return;
    // The provider's state updater is `current === next ? current : next`.
    // React bails out on the identical value: no render, so no persist pass.
    if (mirrorRenderBailout && tab.projectId === id) return;
    tab.received = id;
    if (tab.projectId !== id) {
      tab.projectId = id;
      tab.applied.push(id);
    }
    persist(index);
  };

  /** Deliver queued events until the queue drains or `limit` deliveries pass. */
  const settle = (limit = 200): number => {
    let delivered = 0;
    while (queue.length > 0 && delivered < limit) {
      const next = queue.shift()!;
      delivered += 1;
      receive(next.to, next.event);
    }
    return delivered;
  };

  /** The user picking a workspace: state, then the ordinary persist pass. */
  const select = (index: number, id: string): void => {
    tabs[index].projectId = id;
    persist(index);
  };

  /** Deliver an event to a tab as if its own write had been echoed back. */
  const deliverOwnWrite = (index: number, value: string): void =>
    receive(index, { key: ACTIVE_PROJECT_KEY, newValue: value });

  return {
    tabs, shared, select, settle, receive, write, deliverOwnWrite,
    pending: () => queue.length,
    totalWrites: () => tabs[0].writes + tabs[1].writes,
  };
}

describe("two-tab synchronisation", () => {
  it("the other tab adopts the selection without writing it back", () => {
    const world = twoTabs({ honorMarker: true, dedupeEqualWrites: false });
    world.select(1, "prj_b");
    expect(world.shared.get(ACTIVE_PROJECT_KEY)).toBe("prj_b");
    expect(world.tabs[1].writes).toBe(1);

    world.settle();

    expect(world.tabs[0].projectId).toBe("prj_b");
    expect(world.tabs[0].applied).toEqual(["prj_b"]);
    // The whole point: adopting is not a reason to write.
    expect(world.tabs[0].writes).toBe(0);
    expect(world.pending()).toBe(0);
  });

  it("a tab writing its own selection never hears its own event", () => {
    // The browser does not deliver a `storage` event to the writing tab; the
    // model is asserted here so a later change cannot quietly assume it does.
    const world = twoTabs({ honorMarker: true, dedupeEqualWrites: false });
    world.select(0, "prj_b");
    expect(world.pending()).toBe(1); // for B only
    expect(world.tabs[0].applied).toEqual([]);
  });

  it("a tab tolerates its own write being echoed back to it", () => {
    // Browsers do not do this, but the listener must not be the thing that
    // turns a stray echo into a second write.
    const world = twoTabs({ honorMarker: true, dedupeEqualWrites: false });
    const writesBefore = world.tabs[0].writes;

    world.deliverOwnWrite(0, "prj_a");

    // An echo of the id this tab already shows is inert: React bails out, so
    // no persist pass runs and nothing is written.
    expect(world.tabs[0].projectId).toBe("prj_a");
    expect(world.tabs[0].applied).toEqual([]);
    expect(world.tabs[0].writes).toBe(writesBefore);
    expect(world.pending()).toBe(0);
  });

  it("the naive listener — adopt, then write it back — ping-pongs forever once the dedupe is gone", () => {
    // What "just add a storage listener" produces: no marker, and no
    // render-bailout to stop the first write either. With no dedupe, every
    // write is a new event in the other tab, whose write is a new event back.
    // The delivery cap bounds the test; the assertion is that it does NOT
    // settle. This is the failure the marker prevents.
    const world = twoTabs({
      honorMarker: false, dedupeEqualWrites: false, mirrorRenderBailout: false,
    });
    world.select(1, "prj_b");

    const delivered = world.settle(50);

    expect(delivered).toBe(50);
    expect(world.pending()).toBeGreaterThan(0);
    // Both tabs keep writing, and neither stops first.
    expect(world.tabs[0].writes).toBeGreaterThan(10);
    expect(world.tabs[1].writes).toBeGreaterThan(10);
  });

  it("the marker alone stops the loop, even when every redundant write is delivered", () => {
    // A world with no same-value dedupe AND no render bailout: the only thing
    // that can stop the ping-pong is the marker. If the fix leaned on either
    // browser/React behaviour, this test fails.
    const world = twoTabs({
      honorMarker: true,
      dedupeEqualWrites: false,
      mirrorRenderBailout: false,
      ignoreStoredEquality: true,
    });
    world.select(1, "prj_b");

    expect(world.settle()).toBe(1);
    expect(world.tabs[0].writes).toBe(0);

    // And back the other way, so the marker is per-receipt, not one-shot for
    // the lifetime of the page.
    world.select(0, "prj_a");
    expect(world.settle()).toBe(1);
    expect(world.tabs[1].projectId).toBe("prj_a");
    expect(world.tabs[1].writes).toBe(1);
  });

  it("an id missing from the list is ignored and the selection stays put", () => {
    const world = twoTabs({ honorMarker: true, dedupeEqualWrites: false });
    world.write(1, "prj_deleted_elsewhere");

    world.settle();

    expect(world.tabs[0].projectId).toBe("prj_a");
    expect(world.tabs[0].applied).toEqual([]);
    expect(world.tabs[0].writes).toBe(0);
  });
});
