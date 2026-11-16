"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Users, Wand2 } from "@/components/icons";
import { SidebarProvider, useSidebar, SidebarTrigger } from "@/components/ui/sidebar";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";
import { PermissionProvider, usePermission } from "./permission-provider";
import { ProjectProvider } from "./project-context";
import { AnnouncementProvider } from "./announcement-context";
import { ALL_PAGES, workspaceHref, type WorkspaceRoute } from "./navigation";

function DashboardContent({ route, children }: { route: WorkspaceRoute; children: ReactNode }) {
  const { open, isMobile } = useSidebar();
  const { can } = usePermission();
  const showTrigger = !open || isMobile;
  const current = ALL_PAGES.find(page => page.id === route) ?? { label: "Watching", icon: Users };
  const CurrentIcon = current.icon;

  return (
    <div className="my-0 sm:my-2 mr-0 sm:mr-2.5 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-[#e5e5e7] dark:border-neutral-800 bg-white dark:bg-[#121215] shadow-none sm:shadow-2xs">
      <header className="flex h-[58px] shrink-0 items-center justify-between px-4 sm:px-6 pt-1 border-b border-transparent dark:border-neutral-800/60">
        <div className="flex items-center">
          <div className={`flex items-center overflow-hidden transition-all duration-200 ease-in-out ${showTrigger ? "w-8 opacity-100 mr-1.5" : "w-0 opacity-0 mr-0"}`}>
            <SidebarTrigger
              className="size-7 rounded-md text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
              title="Toggle sidebar (Cmd+B)"
            />
          </div>
          <Breadcrumb>
            <BreadcrumbList className="gap-2 text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
              <BreadcrumbItem>
                <BreadcrumbPage className="inline-flex items-center gap-2 font-medium text-neutral-800 dark:text-neutral-200">
                  <CurrentIcon className="size-4 text-neutral-700 dark:text-neutral-300 shrink-0" />
                  <span>{current.label}</span>
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          {can("ask-ai.view") && (
            <Link href="/ask-ai" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#f4f4f5] dark:bg-neutral-800/80 px-3 text-[12.5px] font-medium text-neutral-800 dark:text-neutral-200 hover:bg-[#eaeaea] dark:hover:bg-neutral-700 transition-colors">
              <Wand2 className="size-3.5" />
              <span>Ask AI</span>
            </Link>
          )}
        </div>
      </header>
      <main className={route === "ask-ai"
        ? "flex-1 min-h-0 overflow-hidden"
        : "flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pt-5 sm:pt-6 pb-8 custom-scrollbar"}>
        {children}
      </main>
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // Exact match first, then prefix: /wiki/<page-id> must keep the Wiki entry
  // highlighted rather than falling through to the Watching default.
  const route: WorkspaceRoute =
    ALL_PAGES.find(page => page.href === pathname)?.id ??
    ALL_PAGES.find(page => pathname.startsWith(`${page.href}/`))?.id ??
    "watching";
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const handleNavigate = (destination: string) => {
    const href = workspaceHref(destination);
    if (href) router.push(href);
  };

  return (
    <PermissionProvider>
      {/* Above the sidebar and the page content: a workspace switch is
          announced through the shell's live region, and the sidebar that
          performs the switch is a sibling of the page it changes. */}
      <AnnouncementProvider>
        {/* Above the SidebarProvider too: the active project is shared state
            between the sidebar's switcher and the page content (Agent Board),
            so it must live above both. It sits INSIDE AnnouncementProvider
            because a `storage`-driven workspace switch is announced from here,
            and the provider that writes must be above the one that announces. */}
        <ProjectProvider>
          <SidebarProvider defaultOpen className="flex h-dvh w-full overflow-hidden bg-[#f5f5f5] dark:bg-[#09090b]">
            <AppSidebar currentRoute={route} onNavigate={handleNavigate} onOpenCommand={() => setIsCommandOpen(true)} />
            <DashboardContent route={route}>{children}</DashboardContent>
            <CommandPalette open={isCommandOpen} onOpenChange={setIsCommandOpen} onNavigate={handleNavigate} />
          </SidebarProvider>
        </ProjectProvider>
      </AnnouncementProvider>
    </PermissionProvider>
  );
}
