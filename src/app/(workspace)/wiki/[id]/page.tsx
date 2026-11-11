import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PagePermissionGate } from "@/components/dashboard/page-permission-gate";
import { WikiPageView } from "@/components/wiki/wiki-page-view";
import { ForbiddenView } from "@/components/status/forbidden-view";
import { getSessionUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { isConfigured, readStorageSettings } from "@/lib/storage";
import { getWikiPageDetail, isUuid, listWikiLabels } from "@/lib/wiki";

/**
 * /wiki/[id] — the page detail. Same two-layer gate as /wiki: the server check
 * runs before any wiki query so a forbidden session's payload never carries the
 * document, and the client gate re-checks on mount.
 */
async function WikiDetailBody({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user || !hasPermission(user.permissions, "wiki.view")) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <ForbiddenView permission="wiki.view" />
      </div>
    );
  }

  if (!isUuid(id)) notFound();
  const page = await getWikiPageDetail(id);
  if (!page) notFound();

  // One read for both the upload hint and the editor's disabled state. Storage
  // being unavailable must never block page editing itself — it only disables
  // the upload buttons.
  const settings = await readStorageSettings();
  const [labels] = await Promise.all([listWikiLabels()]);

  return (
    <PagePermissionGate permission="wiki.view">
      <WikiPageView
        key={page.id}
        initialPage={page}
        initialLabels={labels}
        storageConfigured={Boolean(settings && isConfigured(settings))}
      />
    </PagePermissionGate>
  );
}

export default function WikiDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The page itself never awaits runtime data: `params` is a request-time API,
  // so with cacheComponents it belongs inside the boundary — the shell streams
  // (its usePathname needs a Suspense boundary above it during prerender),
  // the gated body follows.
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-[50vh] items-center justify-center"
          role="status"
          aria-label="Loading wiki page"
        >
          <div className="size-2 animate-pulse rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>
      }
    >
      <WikiDetailBody params={params} />
    </Suspense>
  );
}
