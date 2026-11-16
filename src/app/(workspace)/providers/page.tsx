import { Suspense } from "react";
import { PagePermissionGate } from "@/components/dashboard/page-permission-gate";
import { ProvidersView, type ProviderView } from "@/components/dashboard/providers-view";
import { ForbiddenView } from "@/components/status/forbidden-view";
import { getSessionUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { listProviders } from "@/lib/providers";

/**
 * /providers — RSC first paint + client island, same shape as /storage. The
 * server gate runs BEFORE the list read so a session without
 * `providers.view` never receives the API keys at all.
 */
async function ProvidersPageBody() {
  const user = await getSessionUser();
  if (!user || !hasPermission(user.permissions, "providers.view")) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <ForbiddenView permission="providers.view" />
      </div>
    );
  }

  const providers = await listProviders();

  return (
    <PagePermissionGate permission="providers.view">
      <ProvidersView initialProviders={providers as ProviderView[]} />
    </PagePermissionGate>
  );
}

export default function ProvidersPage() {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-[50vh] items-center justify-center text-xs text-muted-foreground"
          role="status"
          aria-label="Memuat daftar provider"
        >
          Memuat daftar provider…
        </div>
      }
    >
      <ProvidersPageBody />
    </Suspense>
  );
}
