/**
 * The permission catalog — the single source of truth for every authorization
 * key in the app.
 *
 * Keys are `<resource>.<verb>` where resource is a `navigation.ts` page id, an
 * explicit non-nav resource (`watching`), or an admin resource (`roles`). The
 * database stores only grants (role → JSONB array of keys/wildcards); what a
 * grant *means* is decided here, in code. Adding a page = adding one catalog
 * entry; no migration.
 *
 * Pure module by contract: no `pg`, no `next/headers`, no server-only imports —
 * client components (sidebar, matrix UI) import this file too. It may reference
 * `navigation.ts` type-only.
 */
import type { ALL_PAGES } from "@/components/dashboard/navigation";

export type Verb = "view" | "create" | "update" | "delete" | "use" | "manage" | "comment";

/** Nav-page ids that require a verbs entry. `watching` is a WorkspaceRoute that
 *  is not part of ALL_PAGES, so it is added explicitly here. */
type NavPageId = (typeof ALL_PAGES)[number]["id"] | "watching";

/** Non-page admin resources. Declared before VERBS_BY_PAGE because the Record
 *  below deliberately excludes these ids: `roles` is both a nav page (since the
 *  /roles admin page) and an EXTRA_RESOURCES resource, and a resource must own
 *  exactly one verbs declaration or PERMISSION_GROUPS would list it twice.
 *  `as const satisfies` keeps the resource literals narrow (VerbsPageId excludes
 *  them by literal) while still checking the same shape as before. */
const EXTRA_RESOURCES = [
  { resource: "roles", verbs: ["view", "manage"] },
  // Provider registry (the awm_provider_* tools): no dedicated page, the
  // switcher-style admin surface lives on /providers. `manage` is what gates
  // registering a provider, i.e. writing an API key into the database.
  { resource: "providers", verbs: ["view", "manage"] },
] as const satisfies ReadonlyArray<{ resource: string; verbs: readonly Verb[] }>;

/** Nav pages that render another resource's permissions and own no verbs of
 *  their own: /permissions is the roles catalog's per-role matrix, gated by
 *  pageViewPermission("permissions") → roles.view. Declared here so the Record
 *  below stays exhaustive without minting `permissions.*` catalog keys — the
 *  page borrows the roles resource's verbs instead of defining any. */
// Type-level only by design: the `as const satisfies` exists to keep the
// literals narrow for VerbsPageId's Exclude — nothing reads the array at
// runtime, which is why the aliased ids never leak into the exported catalog.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberate, see above
const ALIASED_PAGES = ["permissions"] as const satisfies readonly NavPageId[];

/** Nav-page ids whose verbs entry must live in VERBS_BY_PAGE: every nav id
 *  except the admin resources and aliased pages above. */
type VerbsPageId = Exclude<
  NavPageId,
  (typeof EXTRA_RESOURCES)[number]["resource"] | (typeof ALIASED_PAGES)[number]
>;

/** Record<VerbsPageId, ...> makes TypeScript fail the build when a page is added
 *  to navigation.ts without a verbs entry — the single-source-of-truth check.
 *  Declaration order is the catalog order (workspace pages, then watching,
 *  then admin); these keys are non-numeric so object insertion order holds. */
const VERBS_BY_PAGE: Record<VerbsPageId, readonly Verb[]> = {
  home: ["view"],
  "ask-ai": ["view", "use"],
  "agent-board": ["view"],
  wiki: ["view", "create", "update", "delete", "comment"],
  watching: ["view"],
  users: ["view", "create", "update", "delete"],
  storage: ["view", "manage"],
};

/** Human group heading per resource — the matrix UI's row groups and the i18n
 *  base. Keys are stable resource ids; labels are the translatable surface. */
const RESOURCE_LABELS: Record<string, string> = {
  home: "Home",
  "ask-ai": "Ask AI",
  "agent-board": "Agent Board",
  wiki: "Wiki",
  watching: "Watching",
  users: "Users",
  storage: "Storage",
  roles: "Roles",
  providers: "LLM Providers",
};

export interface ResourceGroup {
  resource: string;
  /** Group heading in matrix UI + i18n base. */
  label: string;
  verbs: readonly Verb[];
}

function groupOf(resource: string, verbs: readonly Verb[]): ResourceGroup {
  return { resource, label: RESOURCE_LABELS[resource] ?? resource, verbs };
}

/** Ordered for UI display: workspace pages, then watching, then admin. */
export const PERMISSION_GROUPS: readonly ResourceGroup[] = [
  ...(Object.entries(VERBS_BY_PAGE) as Array<[NavPageId, readonly Verb[]]>).map(
    ([id, verbs]) => groupOf(id, verbs)
  ),
  ...EXTRA_RESOURCES.map(({ resource, verbs }) => groupOf(resource, verbs)),
];

/** Every valid concrete key, e.g. ["home.view", "ask-ai.view", ..., "roles.manage"]. */
export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSION_GROUPS.flatMap((group) =>
  group.verbs.map((verb) => `${group.resource}.${verb}`)
);

const KEY_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_KEYS);
const GROUP_BY_RESOURCE: ReadonlyMap<string, ResourceGroup> = new Map(
  PERMISSION_GROUPS.map((group) => [group.resource, group])
);

/** Stable keys → human labels. Keys never change; labels are the i18n surface
 *  (swap map values for translated strings later, keys stay forever). */
export const PERMISSION_LABELS: Record<string, string> = {
  "home.view": "View Home",
  "ask-ai.view": "View Ask AI",
  "ask-ai.use": "Use Ask AI",
  "agent-board.view": "View Agent Board",
  "wiki.view": "View Wiki",
  "wiki.create": "Create wiki pages",
  "wiki.update": "Edit wiki pages",
  "wiki.delete": "Delete wiki pages",
  "wiki.comment": "Comment on wiki pages",
  "watching.view": "View Watching",
  "users.view": "View users",
  "users.create": "Create users",
  "users.update": "Update users",
  "users.delete": "Delete users",
  "storage.view": "View storage settings",
  "storage.manage": "Manage storage settings",
  "roles.view": "View roles & permissions",
  "roles.manage": "Manage roles & permissions",
  "providers.view": "View LLM providers",
  "providers.manage": "Register and update LLM providers",
};

/** Sidebar/page gate for a nav page id. Default `${id}.view`; the matrix page
 *  shares the roles resource's view verb — the catalog has no `permissions.*`
 *  resource, so one explicit override keeps "nav id → key" a function. */
export function pageViewPermission(pageId: string): string {
  return pageId === "permissions" ? "roles.view" : `${pageId}.view`;
}

/**
 * Expand wildcards against the catalog and drop unknown/dead grants.
 *
 * Rules:
 *   1. `"*"` → all of ALL_PERMISSION_KEYS.
 *   2. `"<resource>.*"` with a known resource → that group's keys; unknown
 *      resource → dropped.
 *   3. A concrete key not in ALL_PERMISSION_KEYS → dropped (dead grants are
 *      inert; stale data can never grant a permission the code no longer defines).
 *   4. Output is de-duplicated and in PERMISSION_GROUPS order, then verb order
 *      — deterministic, snapshot-testable.
 *
 * Invariant: the output NEVER contains `*` or `resource.*` entries.
 */
export function resolvePermissions(granted: readonly string[]): string[] {
  const wanted = new Set<string>();
  for (const entry of granted) {
    if (entry === "*") {
      for (const key of ALL_PERMISSION_KEYS) wanted.add(key);
      continue;
    }
    if (entry.endsWith(".*")) {
      const group = GROUP_BY_RESOURCE.get(entry.slice(0, -2));
      if (group) {
        for (const verb of group.verbs) wanted.add(`${group.resource}.${verb}`);
      }
      continue;
    }
    if (KEY_SET.has(entry)) wanted.add(entry);
  }
  return ALL_PERMISSION_KEYS.filter((key) => wanted.has(key));
}

/**
 * May a role row store this grant? The write-time counterpart of
 * resolvePermissions: the resolver silently drops dead grants (stale data must
 * stay inert), while this rejects them at the API boundary so new dead grants
 * can never be written.
 *
 * True for exactly the three grant shapes the resolver understands:
 *   1. `"*"`
 *   2. `"<resource>.*"` with a resource the catalog defines
 *   3. a concrete member of ALL_PERMISSION_KEYS
 *
 * Everything else — unknown concrete keys, unknown-resource wildcards,
 * malformed strings — is false. Driven by PERMISSION_GROUPS/ALL_PERMISSION_KEYS,
 * so a future catalog entry is automatically assignable with no route change.
 */
export function isValidGrant(entry: string): boolean {
  if (entry === "*") return true;
  if (entry.endsWith(".*")) return GROUP_BY_RESOURCE.has(entry.slice(0, -2));
  return KEY_SET.has(entry);
}

/** Membership test against an already-resolved list. */
export function hasPermission(resolved: readonly string[], required: string): boolean {
  return resolved.includes(required);
}

/** One role's stored grants plus how many users currently hold that role — the
 *  exact data the lockout computation needs. The API layer gathers this for
 *  every role in a single roles × users aggregate and hands it to the pure
 *  function below; the function itself never touches the database. */
export interface RoleGrantsUsage {
  key: string;
  grants: readonly string[];
  userCount: number;
}

/**
 * Would replacing `editedKey`'s grants with `replacementGrants` leave zero
 * users holding `roles.manage` across every role — the last-admin lockout?
 *
 * Pure by contract (no DB, no clock): each entry's grants are resolved exactly
 * as the request-time guard would resolve them (wildcards expanded, dead
 * grants dropped), with the edited role evaluated as it would exist AFTER the
 * write. An entry "holds" roles.manage when its resolution contains it, so
 * `*` and `roles.*` count exactly like the concrete key.
 *
 * True when the sum of holders' userCounts is zero — including the
 * already-locked-out state (no holder has users even before this edit): the
 * API should still refuse to ratify a world where nobody can administer roles.
 */
export function wouldLeaveNoManageHolder(
  entries: readonly RoleGrantsUsage[],
  editedKey: string,
  replacementGrants: readonly string[]
): boolean {
  let holders = 0;
  for (const entry of entries) {
    const grants = entry.key === editedKey ? replacementGrants : entry.grants;
    if (hasPermission(resolvePermissions(grants), "roles.manage")) {
      holders += entry.userCount;
    }
  }
  return holders === 0;
}
