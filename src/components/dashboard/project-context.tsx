"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "@/lib/api";
import {
  persistSelection,
  readSelection,
  selectionFromStorageEvent,
  writeSelection,
  type ProjectStatus,
  type SelectionStorage,
} from "./project-selection";
import { useAnnounce } from "./announcement-context";

/** The project list's state. Owned by `./project-selection` (a pure module)
 *  and re-exported here so every consumer of the status (`WorkspaceSwitcher`,
 *  the board) keeps one import path — and a fourth state added there must fail
 *  to typecheck at each consumer rather than fall through. */
export type { ProjectStatus };

/** The subset of `GET /api/projects` the dashboard actually consumes. */
export interface WorkspaceProject {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  workspacePath: string | null;
}

interface ProjectContextValue {
  /** Every registered project, in the order the API returned them. */
  projects: WorkspaceProject[];
  /** Active project id; `null` only while nothing is selectable (loading, error, or empty). */
  projectId: string | null;
  project: WorkspaceProject | null;
  /** `"error"` means the list could not be read — not that there are no projects. */
  status: ProjectStatus;
  setProjectId(id: string): void;
  reload(): void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/** The stored id lives under `ACTIVE_PROJECT_KEY` (see `./project-selection`).
 *  Access goes through a thunk because reading `window.localStorage` itself
 *  throws when storage is blocked — the pure module turns that into `null`. */
function localSelectionStorage(): SelectionStorage {
  return window.localStorage;
}

function readStoredProjectId(): string | null {
  return readSelection(localSelectionStorage);
}

function storeProjectId(id: string | null): void {
  writeSelection(localSelectionStorage, id);
}

function toProject(value: unknown): WorkspaceProject | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    gitRemoteUrl: typeof row.gitRemoteUrl === "string" ? row.gitRemoteUrl : null,
    workspacePath: typeof row.workspacePath === "string" ? row.workspacePath : null,
  };
}

/**
 * Which project a freshly loaded list should activate. The current selection
 * wins if it still exists (a re-fetch must not yank the user elsewhere), then
 * the stored one, then the first project returned — so a deleted project falls
 * back instead of leaving the board pointed at nothing.
 */
function resolveActiveProjectId(
  projects: WorkspaceProject[],
  current: string | null,
  stored: string | null
): string | null {
  const exists = (id: string | null) => id !== null && projects.some(project => project.id === id);
  if (exists(current)) return current;
  if (exists(stored)) return stored;
  return projects[0]?.id ?? null;
}

/**
 * Secondary line of a Workspace Switcher entry. `bmad_projects` has no plan
 * tier, so the honest equivalent is where the workspace lives: the git remote
 * host, or the fact that it is a local checkout.
 */
export function workspaceSubtitle(project: WorkspaceProject): string {
  const remote = project.gitRemoteUrl?.trim();
  if (remote) {
    // scp-like form: git@github.com:owner/repo.git
    const scpHost = /^[^/@\s]+@([^:/\s]+):/.exec(remote);
    if (scpHost) return scpHost[1];
    try {
      const host = new URL(remote).host;
      if (host) return host;
    } catch {
      // Not a URL — fall through to the path-based label below.
    }
  }
  if (project.workspacePath) return "Workspace lokal";
  return "Workspace";
}

/**
 * Single source of truth for "which project is active": the sidebar highlights
 * from it and the Agent Board reads every request (and mutation) from it. The
 * project list comes from `GET /api/projects` — `bmad_projects` is the registry
 * of workspaces, not a hardcoded menu.
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectId, setProjectIdState] = useState<string | null>(null);
  const [status, setStatus] = useState<ProjectStatus>("loading");
  const [reloadToken, setReloadToken] = useState(0);
  // The id this tab adopted from ANOTHER tab's `storage` event. The persist
  // effect skips it, so adopting a selection is never echoed back — without
  // this, two tabs would write each other's selection forever and only the
  // browser's same-value dedupe would hide it. A ref, not state: writing it
  // is not a reason to render, and the effect reads the value current at the
  // render it runs for.
  const receivedProjectId = useRef<string | null>(null);
  // The list as the storage listener sees it. The listener is registered once
  // and must not re-register on every fetch, so it reads this ref instead.
  // Assigned in the fetch `.then` BESIDE `setProjects`, not in a mirror
  // effect: an effect runs after the commit, and a `storage` event delivered
  // in between would validate against the previous list and drop a valid id.
  const projectsRef = useRef<WorkspaceProject[]>([]);
  // Adopting another tab's selection is a workspace switch like any other, so
  // it is announced the same way — a screen-reader user gets no other signal
  // that their board just changed underneath them.
  const announce = useAnnounce();
  // The name a `storage` adoption should announce, once the list confirms it.
  const adoptedRef = useRef<string | null>(null);

  useEffect(() => {
    let ignore = false;
    apiFetch("/api/projects", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((payload: unknown) => {
        if (ignore) return;
        // A non-array payload is a broken response, not an empty workspace. It
        // must not be reported as "ready with zero projects": that would clear
        // the stored selection and leave the user with no workspace, from a
        // single transient bad response.
        if (!Array.isArray(payload)) {
          throw new Error("Unexpected /api/projects payload");
        }
        const list = payload
          .map(toProject)
          .filter((project): project is WorkspaceProject => project !== null);
        projectsRef.current = list;
        setProjects(list);
        setStatus("ready");
        setProjectIdState(current => resolveActiveProjectId(list, current, readStoredProjectId()));
      })
      .catch((error: unknown) => {
        if (ignore) return;
        console.warn("[Workspace] Gagal memuat daftar project:", error);
        setStatus("error");
      });
    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  // Another tab's selection. `storage` fires only in the tabs that did NOT
  // write, so this is the only cross-tab path — the writer's own tab keeps its
  // ordinary behaviour.
  //
  // The id is applied only when the list this tab already loaded contains it:
  // the other tab may be on a newer list, or selecting a project this tab has
  // not fetched yet, and pointing the board at a project it cannot name would
  // be worse than staying put. A removal (`newValue === null`) is ignored for
  // the same class of reason — it is not a selection.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Even reading `window.localStorage` throws when storage is blocked; the
    // listener must not be what crashes the page.
    let area: unknown;
    try {
      area = window.localStorage;
    } catch {
      area = undefined;
    }
    const onStorage = (event: StorageEvent) => {
      // `storageArea` is checked against this tab's localStorage: a same-key
      // write to sessionStorage (an iframe, another library) fires this event
      // too and is not a workspace switch.
      const next = selectionFromStorageEvent(
        event,
        projectsRef.current.map(item => item.id),
        area,
      );
      if (next === null) return;
      receivedProjectId.current = next;
      const name = projectsRef.current.find(item => item.id === next)?.name;
      // A receipt for the id this tab already shows is not a switch: React
      // skips the render, so nothing must be announced either.
      setProjectIdState(current => {
        if (current === next) return current;
        adoptedRef.current = name ?? next;
        return next;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Announce an adoption once the render that shows it has committed. Kept out
  // of the storage handler: `setProjectIdState`'s updater may run twice and
  // must stay free of side effects.
  useEffect(() => {
    const name = adoptedRef.current;
    if (name === null) return;
    adoptedRef.current = null;
    announce(`Beralih ke workspace ${name}.`);
  }, [projectId, announce]);

  // Persist only a selection the list confirmed. Writing during the initial
  // `null` would erase the remembered id before the fetch that reads it lands,
  // which is exactly how a reload would lose the workspace. All of the
  // decisions live in `persistSelection` (node-testable); this effect only
  // carries them out.
  useEffect(() => {
    const write = persistSelection({
      status,
      projectId,
      projectCount: projects.length,
      stored: readStoredProjectId(),
      received: receivedProjectId.current,
    });
    if (write === null) return;
    storeProjectId(write);
    // A pass that writes means the selection is no longer the received one
    // (the decision rule guarantees it), so the marker has done its job.
    receivedProjectId.current = null;
  }, [projectId, projects.length, status]);

  const setProjectId = useCallback((id: string) => {
    // A user choice made HERE is this tab's own selection, so any pending
    // foreign marker must not suppress persisting it — even when the user
    // picks the id another tab had just sent.
    receivedProjectId.current = null;
    setProjectIdState(id);
  }, []);

  const reload = useCallback(() => {
    // From the event handler, not the effect: the effect body may only kick
    // off the request, never set state synchronously with the render.
    setStatus("loading");
    setReloadToken(current => current + 1);
  }, []);

  const value = useMemo<ProjectContextValue>(() => ({
    projects,
    projectId,
    project: projects.find(project => project.id === projectId) ?? null,
    status,
    setProjectId,
    reload,
  }), [projects, projectId, status, setProjectId, reload]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useActiveProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useActiveProject must be used inside <ProjectProvider>");
  return value;
}
