import { Suspense } from "react";
import { PagePermissionGate } from "@/components/dashboard/page-permission-gate";
import { PermissionsView } from "@/components/dashboard/permissions-view";
import { ForbiddenView } from "@/components/status/forbidden-view";
import { getSessionUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { toRoleResponse, type RoleResponse, type RoleRow } from "@/lib/roles";

/**
 * The permissions matrix page (design §6): /roles' architecture — RSC first
 * paint + client island — with grouped permission rows and role columns.
 *
 * The gate is server-side AND load-bearing for the flight payload (the 2.1/2.2
 * pattern): `getSessionUser` + `roles.view` run BEFORE the roles query, so a
 * forbidden visitor never gets role data serialized into the RSC payload at
 * all — not merely hidden by the client gate, which stays as the second layer
 * for the same reason every page keeps it. The page shares the roles
 * resource's view verb (pageViewPermission("permissions") → roles.view): the
 * catalog defines no `permissions.*` keys.
 */
interface RoleListRow extends RoleRow {
  user_count: number;
}

/** The same roles × users aggregate GET /api/roles and /roles serve (epic 1's
 *  shape) — the column headers' member counts come from it. */
async function listRoles(): Promise<RoleResponse[]> {
  const result = await query<RoleListRow>(
    `SELECT r.key, r.name, r.description, r.permissions, r.is_system, r.created_at,
            COUNT(u.id)::int AS user_count
     FROM roles r
     LEFT JOIN users u ON u.role = r.key
     GROUP BY r.key, r.name, r.description, r.permissions, r.is_system, r.created_at
     ORDER BY r.created_at ASC, r.key ASC`
  );
  return result.rows.map((row) => toRoleResponse(row, Number(row.user_count ?? 0)));
}

/** `?role=<key>` deep link → the selector preselects that role. Unknown keys
 *  are ignored (placeholder). Non-string values (e.g. ?role=a&role=b) take the
 *  first entry. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function PermissionsPageBody({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  // Return before any query: no role row may reach a forbidden user's payload.
  if (!user || !hasPermission(user.permissions, "roles.view")) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <ForbiddenView permission="roles.view" />
      </div>
    );
  }

  const params = await searchParams;
  const roles = await listRoles();
  const initialRoleKey = firstParam(params.role);

  return (
    <PagePermissionGate permission="roles.view">
      <PermissionsView initialRoles={roles} initialRoleKey={initialRoleKey} />
    </PagePermissionGate>
  );
}

export default function PermissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The page itself never awaits runtime data: the session read (cookies) and
  // searchParams are request-time APIs, so with cacheComponents they belong
  // behind this Suspense boundary — the shell streams, the gated body follows.
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-[50vh] items-center justify-center"
          role="status"
          aria-label="Loading permissions"
        >
          <div className="size-2 animate-pulse rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>
      }
    >
      <PermissionsPageBody searchParams={searchParams} />
    </Suspense>
  );
}
