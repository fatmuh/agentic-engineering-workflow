import { describe, expect, it } from "vitest";
import { ALL_PAGES } from "@/components/dashboard/navigation";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  hasPermission,
  isValidGrant,
  pageViewPermission,
  resolvePermissions,
  wouldLeaveNoManageHolder,
  type RoleGrantsUsage,
} from "./permissions";

/** The full catalog in display order — the deterministic order the resolver
 *  must emit regardless of grant order or duplicates. v1 was 11 keys; the wiki
 *  + storage initiative (v2 of the catalog) adds 7. */
const CATALOG_ORDER = [
  "home.view",
  "ask-ai.view",
  "ask-ai.use",
  "agent-board.view",
  "wiki.view",
  "wiki.create",
  "wiki.update",
  "wiki.delete",
  "wiki.comment",
  "watching.view",
  "users.view",
  "users.create",
  "users.update",
  "users.delete",
  "storage.view",
  "storage.manage",
  "roles.view",
  "roles.manage",
  "providers.view",
  "providers.manage",
] as const;

const USERS_KEYS = ["users.view", "users.create", "users.update", "users.delete"] as const;

// --- resolvePermissions: wildcard expansion, dead-grant dropping, order ----

describe("resolvePermissions", () => {
  it('expands "*" to the whole catalog, with no wildcard in the output', () => {
    const resolved = resolvePermissions(["*"]);
    expect(resolved).toEqual([...CATALOG_ORDER]);
    expect(resolved).toEqual([...ALL_PERMISSION_KEYS]);
    expect(resolved).not.toContain("*");
    expect(resolved.filter((key) => key.endsWith(".*"))).toEqual([]);
  });

  it('expands a known resource wildcard to that resource\'s keys only', () => {
    expect(resolvePermissions(["users.*"])).toEqual([...USERS_KEYS]);
    expect(resolvePermissions(["roles.*"])).toEqual(["roles.view", "roles.manage"]);
  });

  it("expands the wiki wildcard to all five wiki verbs, comment included", () => {
    expect(resolvePermissions(["wiki.*"])).toEqual([
      "wiki.view",
      "wiki.create",
      "wiki.update",
      "wiki.delete",
      "wiki.comment",
    ]);
    // `comment` is a first-class verb, not a synonym for update: a role may
    // hold wiki.update without wiki.comment and vice versa.
    expect(resolvePermissions(["wiki.update"])).toEqual(["wiki.update"]);
    expect(resolvePermissions(["wiki.comment"])).toEqual(["wiki.comment"]);
  });

  it("expands the storage wildcard to view + manage", () => {
    expect(resolvePermissions(["storage.*"])).toEqual(["storage.view", "storage.manage"]);
  });

  it("drops unknown concrete keys and unknown resource wildcards (dead grants are inert)", () => {
    expect(resolvePermissions(["retired.thing", "foo.*", "users.view"])).toEqual(["users.view"]);
    expect(resolvePermissions(["nope.view", "users.nope", ".*"])).toEqual([]);
  });

  it("de-duplicates grants and emits deterministic catalog order", () => {
    // Reverse-order, duplicated, overlapping concrete + wildcard grants.
    const resolved = resolvePermissions([
      "users.delete",
      "home.view",
      "users.view",
      "users.*",
      "home.view",
      "agent-board.view",
    ]);
    expect(resolved).toEqual(["home.view", "agent-board.view", ...USERS_KEYS]);
  });

  it("resolves an empty grant list to an empty permission list", () => {
    expect(resolvePermissions([])).toEqual([]);
  });

  it("never grants more than the catalog defines", () => {
    for (const key of resolvePermissions(["*", "users.*", "roles.manage", "bogus"])) {
      expect(ALL_PERMISSION_KEYS).toContain(key);
    }
  });
});

// --- isValidGrant: what a role row may store at the API boundary -----------

describe("isValidGrant", () => {
  it("accepts the global wildcard", () => {
    expect(isValidGrant("*")).toBe(true);
  });

  it("accepts a wildcard for every resource the catalog defines", () => {
    for (const group of PERMISSION_GROUPS) {
      expect(isValidGrant(`${group.resource}.*`), `${group.resource}.*`).toBe(true);
    }
  });

  it("accepts every concrete catalog key", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      expect(isValidGrant(key), key).toBe(true);
    }
  });

  it("rejects unknown concrete keys", () => {
    for (const grant of ["banana.peel", "users.nope", "retired.thing"]) {
      expect(isValidGrant(grant), grant).toBe(false);
    }
  });

  it("rejects wildcards for resources the catalog does not define", () => {
    for (const grant of ["foo.*", ".*"]) {
      expect(isValidGrant(grant), grant).toBe(false);
    }
  });

  it("rejects malformed entries", () => {
    // Empty, doubled/prefixed wildcards, missing half of resource.verb, and
    // stray whitespace or case — none of these are catalog keys.
    for (const grant of [
      "",
      "*.*",
      "*.view",
      "users",
      "users.",
      ".view",
      " users.view ",
      "USERS.VIEW",
    ]) {
      expect(isValidGrant(grant), JSON.stringify(grant)).toBe(false);
    }
  });

  it("agrees with the resolver: every accepted grant resolves to something", () => {
    const accepted = ["*", "users.*", "roles.manage"];
    for (const grant of accepted) {
      expect(resolvePermissions([grant]).length, grant).toBeGreaterThan(0);
    }
    // And every rejected grant resolves to nothing on its own.
    for (const grant of ["banana.peel", "foo.*", "*.view"]) {
      expect(resolvePermissions([grant]), grant).toEqual([]);
    }
  });
});

// --- hasPermission: membership over an already-resolved list ---------------

describe("hasPermission", () => {
  it("is plain membership over the resolved list", () => {
    const member = resolvePermissions(["home.view", "watching.view"]);
    expect(hasPermission(member, "home.view")).toBe(true);
    expect(hasPermission(member, "users.view")).toBe(false);
  });

  it("denies everything for an empty permission list", () => {
    expect(hasPermission([], "home.view")).toBe(false);
  });
});

// --- pageViewPermission: nav page id → its gating view key -----------------

describe("pageViewPermission", () => {
  it("maps every nav page id to its own view key", () => {
    for (const page of ALL_PAGES) {
      // Widen to string: "permissions" is an aliased page id whose override
      // must hold now that epic 2 adds it to ALL_PAGES — the comparison stays
      // a runtime fact, not a compile-time one.
      const id: string = page.id;
      // The permissions matrix page deliberately shares the roles resource's
      // view verb.
      const expected = id === "permissions" ? "roles.view" : `${id}.view`;
      expect(pageViewPermission(id)).toBe(expected);
    }
    expect(pageViewPermission("watching")).toBe("watching.view");
  });

  it("routes the permissions matrix page through the roles resource", () => {
    expect(pageViewPermission("permissions")).toBe("roles.view");
  });
});

// --- catalog integrity: keys, groups, labels stay in sync ------------------

describe("catalog integrity", () => {
  it("defines exactly the 20 catalog keys, in catalog order", () => {
    expect(ALL_PERMISSION_KEYS).toEqual([...CATALOG_ORDER]);
    expect(ALL_PERMISSION_KEYS).toHaveLength(20);
  });

  it("has a verbs entry (own or aliased) for every nav page id plus watching", () => {
    const resources = new Set(PERMISSION_GROUPS.map((group) => group.resource));
    for (const page of [...ALL_PAGES, { id: "watching" } as const]) {
      // Widen to string: ids like "permissions" are aliased pages — they render
      // another resource's permissions, so pageViewPermission maps their gate
      // to that resource's view verb and they own no verbs entry.
      const id: string = page.id;
      const owns = resources.has(id);
      const aliased = pageViewPermission(id) !== `${id}.view`;
      expect(owns || aliased, `${id} owns no verbs entry and borrows none`).toBe(true);
      // Every gated page must at least be viewable — the sidebar gate is
      // pageViewPermission(id), and that key must be a real catalog key.
      expect(ALL_PERMISSION_KEYS).toContain(pageViewPermission(id));
      if (owns) {
        const group = PERMISSION_GROUPS.find((candidate) => candidate.resource === id);
        expect(group?.verbs, `${id} must define a view verb`).toContain("view");
      }
    }
  });

  it("orders groups workspace-first, then watching, then admin", () => {
    expect(PERMISSION_GROUPS.map((group) => group.resource)).toEqual([
      "home",
      "ask-ai",
      "agent-board",
      "wiki",
      "watching",
      "users",
      "storage",
      "roles",
      "providers",
    ]);
  });

  it("labels every key", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      expect(PERMISSION_LABELS[key], `missing label for ${key}`).toBeTruthy();
    }
  });

  it("has no orphan labels", () => {
    const labelKeys = Object.keys(PERMISSION_LABELS);
    expect(labelKeys).toHaveLength(ALL_PERMISSION_KEYS.length);
    for (const key of labelKeys) {
      expect(ALL_PERMISSION_KEYS, `orphan label ${key}`).toContain(key);
    }
  });
});

// --- wouldLeaveNoManageHolder: the last-admin lockout computation ----------

describe("wouldLeaveNoManageHolder", () => {
  const MANAGE = "roles.manage";

  /** Compact RoleGrantsUsage fixture: one role's key, stored grants, and how
   *  many users currently hold it. */
  const entry = (key: string, grants: readonly string[], userCount: number): RoleGrantsUsage => ({
    key,
    grants,
    userCount,
  });

  it("returns true when the sole holder role is stripped of manage", () => {
    const entries = [entry("support", [MANAGE], 2), entry("viewer", ["home.view"], 5)];
    expect(wouldLeaveNoManageHolder(entries, "support", ["home.view"])).toBe(true);
  });

  it("returns false when another role still holds manage explicitly", () => {
    const entries = [entry("ops-a", [MANAGE], 2), entry("ops-b", [MANAGE], 1)];
    expect(wouldLeaveNoManageHolder(entries, "ops-a", ["home.view"])).toBe(false);
  });

  it("returns false when another role holds manage via a wildcard (`*` or `roles.*`)", () => {
    const entries = [
      entry("ops-a", [MANAGE], 2),
      entry("ops-star", ["*"], 1),
      entry("ops-group", ["roles.*"], 1),
    ];
    expect(wouldLeaveNoManageHolder(entries, "ops-a", ["home.view"])).toBe(false);
    expect(wouldLeaveNoManageHolder(entries, "ops-star", ["home.view"])).toBe(false);
    expect(wouldLeaveNoManageHolder(entries, "ops-group", ["home.view"])).toBe(false);
  });

  it("returns false when the edit adds manage to a role that has users", () => {
    const entries = [entry("ops", [MANAGE], 0), entry("support", ["home.view"], 3)];
    expect(wouldLeaveNoManageHolder(entries, "support", [MANAGE])).toBe(false);
  });

  it("returns true when the only holder role has zero users (already locked out)", () => {
    const entries = [entry("ops", [MANAGE], 0), entry("support", ["home.view"], 2)];
    // Editing a different role while nobody actually holds manage anywhere.
    expect(wouldLeaveNoManageHolder(entries, "support", ["users.view"])).toBe(true);
  });

  it("returns false when the edited role was never a holder and another role holds", () => {
    const entries = [entry("admin", ["*"], 5), entry("support", ["home.view"], 2)];
    expect(wouldLeaveNoManageHolder(entries, "support", ["users.view"])).toBe(false);
  });

  it("evaluates dead grants as non-holding, matching the resolver", () => {
    // A "holder" whose only manage grant is a dead key resolves to nothing.
    const entries = [entry("stale", ["roles.manage.retired"], 4)];
    expect(wouldLeaveNoManageHolder(entries, "stale", ["home.view"])).toBe(true);
  });
});
