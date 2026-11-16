"use client";

import { cn } from "@/lib/utils";
import Image from "next/image";
import Link from "next/link";
import {
  AlertCircle,
  ChevronUp,
  MoreHorizontal,
  PanelLeft,
  Search,
  X,
} from "@/components/icons";

import { useSidebar } from "@/components/ui/sidebar";
import { UserProfileMenu } from "./user-profile-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { useActiveProject, workspaceSubtitle } from "./project-context";
import { WORKSPACE_LIST_FAILED } from "./workspace-switcher-state";
import { useAnnounce } from "./announcement-context";
import { usePermission } from "./permission-provider";
import { pageViewPermission } from "@/lib/permissions";
import { ADMIN_PAGES, WORKSPACE_PAGES, WATCHED_COMPANIES } from "./navigation";
import { toast } from "sonner";

function AdminNavigation({ currentRoute, collapsed = false, onNavigate }: { currentRoute: string; collapsed?: boolean; onNavigate?: () => void }) {
  const { can } = usePermission();
  // Admin entries gate on pageViewPermission — the future /permissions page
  // (story 2.3) shares roles.view instead of owning a catalog resource.
  const adminPages = ADMIN_PAGES.filter(item => can(pageViewPermission(item.id)));
  // The whole section — label included — disappears when nothing is grantable.
  if (adminPages.length === 0) return null;
  return (
    <nav aria-label="Admin" className="mt-[22px] flex w-full flex-col gap-1.5">
      {!collapsed && <p className="px-2.5 text-xs font-medium text-muted-foreground">Admin</p>}
      {adminPages.map(item => <Link key={item.id} href={item.href} aria-label={item.label} title={collapsed ? item.label : undefined} aria-current={currentRoute === item.id ? "page" : undefined} onClick={onNavigate}
        className={cn("flex h-8 items-center gap-2.5 rounded-lg text-[13px] font-medium transition-colors", collapsed ? "mx-auto size-9 justify-center" : "w-full px-2.5", currentRoute === item.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent")}>
        <item.icon className="size-4 shrink-0" aria-hidden="true" />{!collapsed && <span>{item.label}</span>}
      </Link>)}
    </nav>
  );
}

/**
 * Visible recovery for a failed workspace list, directly under the switcher.
 *
 * The switcher's menu already carries "Coba lagi", but that affordance only
 * exists once the menu is open — the sidebar showed a failed (or stale) chip
 * with no way forward short of a page reload, which is the hole D-8b names.
 * Both call the context's one `reload()`, so there is still a single path.
 *
 * The news is the sentence inside a `role="status"` region, and the button is
 * its sibling — the same shape the board's notice uses. Putting the button
 * inside the region would re-announce the sentence every time it is focused.
 * The two sentences come from `workspace-switcher-state`, so the sidebar and
 * the board cannot drift apart.
 */
function WorkspaceListRecovery({ collapsed, onRetry }: {
  collapsed: boolean;
  onRetry: () => void;
}) {
  // No stale variant: nothing calls `reload()` while rows are loaded, so the
  // sidebar can only ever be in this state with an empty list. The switcher's
  // menu note covers the stale case it can actually reach.
  const sentence = WORKSPACE_LIST_FAILED;
  // `reload()` flips the status to "loading" synchronously, which unmounts
  // this row in the same click — taking keyboard focus with it and dropping it
  // to <body>. Focus moves to the sidebar column first, which stays mounted.
  const retry = (event: React.MouseEvent<HTMLButtonElement>) => {
    const column = event.currentTarget.closest<HTMLElement>("[data-workspace-column]");
    column?.focus();
    onRetry();
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={retry}
        title={`${sentence} Coba lagi`}
        aria-label={`${sentence} Coba lagi`}
        className="mx-auto mt-1 flex size-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 cursor-pointer"
      >
        <AlertCircle className="size-4" aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-normal text-neutral-600 dark:text-neutral-400">
      <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
      <p role="status" className="min-w-0 flex-1">{sentence}</p>
      <button
        type="button"
        onClick={retry}
        className="shrink-0 cursor-pointer font-medium underline hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        Coba lagi
      </button>
    </div>
  );
}

interface AppSidebarProps {
  currentRoute?: string;
  onNavigate?: (route: string) => void;
  onOpenCommand?: () => void;
}

export function AppSidebar({
  currentRoute = "home",
  onNavigate,
  onOpenCommand,
}: AppSidebarProps) {
  const { open, toggleSidebar, openMobile, setOpenMobile } = useSidebar();
  const isCollapsed = !open;
  const { can } = usePermission();

  // The workspace list and the active workspace both come from the shared
  // project context — the same state the Agent Board reads its requests from,
  // so choosing here is what the board shows.
  const { projects, projectId, project, setProjectId, status: projectStatus, reload } = useActiveProject();
  const announce = useAnnounce();

  const workspaces = projects.map(item => ({
    id: item.id,
    name: item.name,
    plan: workspaceSubtitle(item),
  }));

  // `value` is the project id: the active row is marked from the same state
  // the board fetches from, not from a name match that could collide.
  const currentWorkspaceId = project?.id ?? "";

  const handleSwitchWorkspace = (id: string) => {
    const next = projects.find(item => item.id === id);
    // Clearing the active row is not a switch — there is nothing to tell the
    // user about, and announcing an empty name would be noise.
    if (!next || next.id === projectId) return;
    setProjectId(next.id);
    // One sentence, two destinations. Sonner already exposes its own
    // `aria-live`, but a toast disappears after a few seconds (and a second
    // identical toast can replace the first before it is read); the shell's
    // region persists, so the sentence is still there when the reader reaches
    // it, and every write is re-announced even if the text is unchanged.
    const sentence = `Beralih ke workspace ${next.name}`;
    toast.success(sentence);
    announce(`${sentence}.`);
  };

  // Permission-filtered nav: mobile and desktop maps both render this list, so
  // an ungrantable page never appears in either (hidden is the safe direction
  // while permissions are still loading, too).
  const navItems = WORKSPACE_PAGES.filter(page => can(`${page.id}.view`));
  const canWatchWatching = can("watching.view");
  const watchingItems = WATCHED_COMPANIES;

  return (
    <>
      {/* Mobile Drawer Backdrop */}
      <div
        onClick={() => setOpenMobile(false)}
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-xs transition-opacity duration-200 md:hidden ${
          openMobile ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Mobile Slide-over Drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-[270px] max-w-[82vw] flex-col justify-between bg-[#f5f5f5] dark:bg-[#0e0e11] p-3 shadow-2xl transition-transform duration-200 ease-in-out md:hidden select-none ${
          openMobile ? "translate-x-0" : "-translate-x-full pointer-events-none"
        }`}
      >
        <div data-workspace-column tabIndex={-1} className="min-h-0 w-full flex-1 overflow-y-auto scrollbar-none focus-visible:outline-none">
          {/* Workspace Brand Row with Close Button */}
          <div className="flex h-8 w-full items-center justify-between px-1">
            <WorkspaceSwitcher workspaces={workspaces} value={currentWorkspaceId} onChange={handleSwitchWorkspace} status={projectStatus} onRetry={reload} />

            <button
              type="button"
              onClick={() => setOpenMobile(false)}
              className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors p-1 rounded-md hover:bg-neutral-200/60 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
              title="Close menu"
            >
              <X className="size-4" />
            </button>
          </div>

          {projectStatus === "error" && <WorkspaceListRecovery collapsed={false} onRetry={reload} />}

          {/* Search Trigger on Mobile */}
          <button
            type="button"
            onClick={() => {
              setOpenMobile(false);
              onOpenCommand?.();
            }}
            className="group mt-2.5 flex h-[34px] w-full items-center gap-2 rounded-lg border border-black/[0.06] dark:border-white/[0.08] bg-white dark:bg-[#141417] px-2.5 shadow-2xs hover:border-neutral-300 dark:hover:border-neutral-700 transition-colors text-left cursor-pointer"
          >
            <Search className="size-3.5 shrink-0 text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-200 transition-colors" />
            <span className="text-[13px] text-neutral-400 leading-none whitespace-nowrap select-none">
              Search...
            </span>
            <kbd className="ml-auto inline-flex h-4 select-none items-center rounded border border-neutral-200/60 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 px-1 font-mono text-[9.5px] font-medium text-neutral-400">
              ⌘K
            </kbd>
          </button>

          {/* Navigation Items on Mobile */}
          <nav className="mt-[20px] space-y-[4px] w-full">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentRoute === item.id;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setOpenMobile(false)}
                  className={`flex h-[32px] w-full items-center rounded-lg px-2.5 text-[13px] font-medium transition-colors cursor-pointer ${
                    isActive
                      ? "bg-[#e5e5e7] dark:bg-[#1c1c22] text-neutral-900 dark:text-white"
                      : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60 hover:text-neutral-900 dark:hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 shrink-0">
                    <Icon className="size-4 shrink-0 text-neutral-700 dark:text-neutral-300" />
                    <span>{item.label}</span>
                  </div>

                </Link>
              );
            })}
          </nav>

          <AdminNavigation currentRoute={currentRoute} onNavigate={() => setOpenMobile(false)} />

          {/* Watching Section on Mobile — the whole section (header, companies,
              "Show all") exists only under watching.view */}
          {canWatchWatching && (
          <div className="mt-[22px] w-full">
            <div className="flex h-5 items-center gap-1.5 px-2.5 text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
              <ChevronUp className="size-3 text-neutral-400 shrink-0" />
              <span>Watching</span>
            </div>
            <div className="mt-1.5 space-y-[4px] w-full">
              {watchingItems.map((item) => (
                <Link
                  key={item.name}
                  href={`/watching#${item.id}`}
                  onClick={() => setOpenMobile(false)}
                  className="flex h-[32px] w-full items-center rounded-lg px-2.5 text-[13px] font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0 shrink-0">
                    <Image
                      src={item.icon}
                      alt=""
                      width={16}
                      height={16}
                      className="size-4 shrink-0 rounded-[4px] object-cover"
                    />
                    <span>{item.name}</span>
                  </div>
                </Link>
              ))}
              <Link
                href="/watching"
                aria-current={currentRoute === "watching" ? "page" : undefined}
                onClick={() => setOpenMobile(false)}
                className="flex h-[32px] w-full items-center rounded-lg px-2.5 text-[13px] font-normal text-neutral-500 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0 shrink-0">
                  <MoreHorizontal className="size-4 shrink-0 text-neutral-400" />
                  <span>Show all</span>
                </div>
              </Link>
            </div>
          </div>
          )}
        </div>

        {/* User Footer Profile Dropdown on Mobile */}
        <UserProfileMenu
          isCollapsed={false}
          onNavigate={(r) => {
            onNavigate?.(r);
            setOpenMobile(false);
          }}
          onOpenCommand={() => {
            onOpenCommand?.();
            setOpenMobile(false);
          }}
        />
      </div>

      {/* Desktop Sidebar (ThemeForest Commercial Grade) */}
      <aside
        className={`hidden md:flex h-full shrink-0 flex-col justify-between bg-[#f5f5f5] dark:bg-[#0e0e11] border-r md:border-r-0 border-neutral-200 dark:border-neutral-800 px-3 pt-2.5 pb-[16px] select-none overflow-hidden transition-[width] duration-200 ease-in-out ${
          isCollapsed ? "w-[60px]" : "w-[240px]"
        }`}
      >
        <div data-workspace-column tabIndex={-1} className="min-h-0 w-full flex-1 overflow-y-auto scrollbar-none focus-visible:outline-none">
          {/* Workspace Brand Row */}
          <div
            className={`flex h-8 w-full items-center ${
              isCollapsed ? "justify-center px-0" : "justify-between px-1"
            }`}
          >
            <WorkspaceSwitcher workspaces={workspaces} value={currentWorkspaceId} onChange={handleSwitchWorkspace} collapsed={isCollapsed} status={projectStatus} onRetry={reload} />

            {/* Collapse Trigger Button on Desktop */}
            {!isCollapsed && (
              <button
                type="button"
                onClick={toggleSidebar}
                className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 transition-all duration-150 p-1 rounded-md hover:bg-neutral-200/60 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
                title="Collapse sidebar (Cmd+B)"
              >
                <PanelLeft className="size-4" />
              </button>
            )}
          </div>

          {projectStatus === "error" && <WorkspaceListRecovery collapsed={isCollapsed} onRetry={reload} />}

          {/* Search Trigger Button */}
          <button
            type="button"
            onClick={onOpenCommand}
            title={isCollapsed ? "Search (⌘K)" : undefined}
            className={`group mt-2.5 flex h-[34px] items-center rounded-lg border border-black/[0.06] dark:border-white/[0.08] bg-white dark:bg-[#141417] shadow-2xs hover:border-neutral-300 dark:hover:border-neutral-700 transition-colors text-left cursor-pointer ${
              isCollapsed
                ? "size-9 p-0 justify-center mx-auto"
                : "w-full px-2.5 gap-2"
            }`}
          >
            <Search className="size-3.5 shrink-0 text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-200 transition-colors" />
            {!isCollapsed && (
              <>
                <span className="text-[13px] text-neutral-400 leading-none whitespace-nowrap select-none">
                  Search...
                </span>
                <kbd className="ml-auto inline-flex h-4 select-none items-center rounded border border-neutral-200/60 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 px-1 font-mono text-[9.5px] font-medium text-neutral-400">
                  ⌘K
                </kbd>
              </>
            )}
          </button>

          {/* Navigation Items */}
          <nav className="mt-[22px] space-y-[4px] w-full overflow-hidden">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentRoute === item.id;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  title={isCollapsed ? item.label : undefined}
                  className={`flex h-[31px] items-center rounded-lg transition-colors overflow-hidden cursor-pointer ${
                    isCollapsed
                      ? "size-9 justify-center px-0 mx-auto"
                      : "w-full px-2.5 text-[13px] font-medium"
                  } ${
                    isActive
                      ? "bg-[#e5e5e7] dark:bg-[#1c1c22] text-neutral-900 dark:text-white"
                      : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60 hover:text-neutral-900 dark:hover:text-white"
                  }`}
                >
                  <div className={`flex items-center gap-2.5 min-w-0 ${isCollapsed ? "justify-center" : "shrink-0"}`}>
                    <Icon className="size-4 shrink-0 text-neutral-700 dark:text-neutral-300" />
                    {!isCollapsed && (
                      <span className="whitespace-nowrap">
                        {item.label}
                      </span>
                    )}
                  </div>

                </Link>
              );
            })}
          </nav>

          <AdminNavigation currentRoute={currentRoute} collapsed={isCollapsed} />

          {/* Watching Section — same watching.view gate as the mobile drawer */}
          {canWatchWatching && (
          <div className="mt-[22px] w-full overflow-hidden">
            <div className="relative h-5 w-full overflow-hidden">
              {!isCollapsed ? (
                <div className="flex h-5 items-center gap-1.5 px-2.5 text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
                  <ChevronUp className="size-3 text-neutral-400 shrink-0" />
                  <span className="whitespace-nowrap">Watching</span>
                </div>
              ) : (
                <div className="flex h-5 items-center justify-center">
                  <div className="w-5 border-t border-neutral-300/80 dark:border-neutral-700" />
                </div>
              )}
            </div>

            <div className="mt-1.5 space-y-[4px] w-full overflow-hidden">
              {watchingItems.map((item) => (
                <Link
                  key={item.name}
                  href={`/watching#${item.id}`}
                  title={isCollapsed ? item.name : undefined}
                  className={`flex h-[31px] items-center rounded-lg transition-colors overflow-hidden cursor-pointer ${
                    isCollapsed
                      ? "size-9 justify-center px-0 mx-auto hover:bg-neutral-200/50 dark:hover:bg-neutral-800"
                      : "w-full px-2.5 text-[13px] font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60 hover:text-neutral-900 dark:hover:text-white"
                  }`}
                >
                  <div className={`flex items-center gap-2.5 min-w-0 ${isCollapsed ? "justify-center" : "shrink-0"}`}>
                    <Image
                      src={item.icon}
                      alt=""
                      width={16}
                      height={16}
                      className="size-4 shrink-0 rounded-[4px] object-cover"
                    />
                    {!isCollapsed && (
                      <span className="whitespace-nowrap">
                        {item.name}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
              <Link
                href="/watching"
                aria-current={currentRoute === "watching" ? "page" : undefined}
                title={isCollapsed ? "Show all" : undefined}
                className={`flex h-[31px] items-center rounded-lg transition-colors overflow-hidden cursor-pointer ${
                  isCollapsed
                    ? "size-9 justify-center px-0 mx-auto hover:bg-neutral-200/50 dark:hover:bg-neutral-800"
                    : "w-full px-2.5 text-[13px] font-normal text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60 hover:text-neutral-700 dark:hover:text-neutral-200"
                }`}
              >
                <div className={`flex items-center gap-2.5 min-w-0 ${isCollapsed ? "justify-center" : "shrink-0"}`}>
                  <MoreHorizontal className="size-4 shrink-0 text-neutral-400" />
                  {!isCollapsed && (
                    <span className="whitespace-nowrap">
                      Show all
                    </span>
                  )}
                </div>
              </Link>
            </div>
          </div>
          )}
        </div>

        {/* User Footer Profile Dropdown */}
        <UserProfileMenu
          isCollapsed={isCollapsed}
          onNavigate={onNavigate}
          onOpenCommand={onOpenCommand}
        />
      </aside>
    </>
  );
}
