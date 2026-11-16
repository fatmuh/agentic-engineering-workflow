"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

interface Announcement {
  /** The latest sentence written by any component. */
  message: string;
  /** Bumped on every write, including a write of the same sentence. */
  version: number;
}

/** The writer is its own context so a component that only announces (the
 *  sidebar) never re-renders when someone else announces. */
const WriterContext = createContext<((message: string) => void) | null>(null);
const AnnouncementContext = createContext<Announcement | null>(null);

/**
 * Carries screen-reader announcements from whoever has news — the sidebar's
 * workspace switch, the board's approve/reject — to the one live region
 * `AnnouncementLiveRegion` renders.
 *
 * The sidebar and the page content are peers, so neither can call the other's
 * setter; this provider sits above both in `DashboardShell`. The region lives
 * there too, NOT inside the Agent Board: a workspace switch can be made from
 * any route (`/`, `/wiki`, `/users`), and a region mounted only on
 * `/agent-board` would announce to nobody on the page the switch happened on.
 *
 * Why a region at all when Sonner already has its own `aria-live`: a toast is
 * transient (it disappears after a few seconds, and a second identical toast
 * may replace the first before it is read). This region persists for the life
 * of the page and every write is a fresh insertion, so the sentence is still
 * there when the reader reaches it.
 *
 * `version` is what the live region renders as its key. The text alone cannot
 * carry a repeated sentence — A→B→A would leave the second A's text identical
 * to text the reader already processed — so each write remounts the text node
 * and the reader treats it as new.
 *
 * A sentence is cleared when the route changes and again after
 * `ANNOUNCEMENT_LIFETIME_MS`, so a page that mounts later never inherits a
 * stale one: the region is persistent for a READER within a page, not for the
 * next page.
 */
const ANNOUNCEMENT_LIFETIME_MS = 10_000;

export function AnnouncementProvider({ children }: { children: ReactNode }) {
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement>({ message: "", version: 0 });
  const pathname = usePathname();

  const clear = useCallback(() => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = null;
    setAnnouncement(previous => (previous.message === ""
      ? previous
      // A new version even for a no-op clear, so the text node is replaced
      // rather than left mounted.
      : { message: "", version: previous.version + 1 }));
  }, []);

  // Stable, so writers never re-render from someone else's announcement.
  const announce = useCallback((next: string) => {
    setAnnouncement(previous => ({ message: next, version: previous.version + 1 }));
    // Long enough to be read (some screen readers are slow to pick up a
    // mutation into an `sr-only` node), short enough that a stale sentence is
    // never sitting in the DOM waiting for the next route to inherit it.
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(clear, ANNOUNCEMENT_LIFETIME_MS);
  }, [clear]);

  // Navigating away bounds the announcement to the page it was made on.
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (firstPath.current === pathname) return;
    firstPath.current = pathname;
    clear();
  }, [pathname, clear]);

  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
  }, []);
  return (
    <WriterContext.Provider value={announce}>
      <AnnouncementContext.Provider value={announcement}>
        {children}
        <AnnouncementLiveRegion />
      </AnnouncementContext.Provider>
    </WriterContext.Provider>
  );
}

/** The single `role="status"` region, mounted on every route. `version` keys
 *  the text so an identical sentence written twice is a new DOM node and is
 *  announced again. */
function AnnouncementLiveRegion() {
  const announcement = useContext(AnnouncementContext);
  if (!announcement) return null;
  return (
    <p role="status" className="sr-only">
      <span key={announcement.version}>{announcement.message}</span>
    </p>
  );
}

/** Write a sentence to the live region. */
export function useAnnounce(): (message: string) => void {
  const announce = useContext(WriterContext);
  if (!announce) throw new Error("useAnnounce must be used inside <AnnouncementProvider>");
  return announce;
}

