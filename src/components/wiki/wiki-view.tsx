"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { ArrowDown, ArrowUp, Copy, ExternalLink, FileDoc, Filter, Info, MoreHorizontal, Plus, Search, X } from "@/components/icons";
import type { FilterValue } from "@/components/ui/filter-menu-clean";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { FilterMenu, type FilterGroup } from "@/components/ui/filter-menu-clean";
import "./wiki-list.css";
import { usePermission } from "@/components/dashboard/permission-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button-clean";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import type { WikiLabelResponse, WikiPageSummary } from "@/lib/wiki";

/**
 * /wiki — the flat page list. Search and label filtering are client-side over
 * the same payload the API returns for every visit; the plan explicitly rules
 * out a query language, so there is nothing to push down.
 *
 * Row anatomy follows Plane's Pages list: a whole-row link (icon + title) with
 * a trailing cluster (editor avatar, info, overflow menu). Dates are
 * tooltip-only — Plane keeps them out of the row itself.
 */

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function initials(name: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

type SortKey = "name" | "created" | "modified";
type SortDir = "asc" | "desc";

const SORT_KEY_LABELS: Record<SortKey, string> = {
  name: "Name",
  created: "Date created",
  modified: "Date modified",
};

/** Plane's search: a collapsed icon that expands to a 256px field; the first
 *  Escape clears the query, the second closes the field. */
function CollapsingSearch({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <Button
        size="lg"
        variant="secondary"
        icon={<Search />}
        aria-label="Search pages"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="wiki-search">
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <label htmlFor={inputId} className="sr-only">Search pages by title</label>
      <input
        id={inputId}
        ref={inputRef}
        type="search"
        className="wiki-search-input"
        placeholder="Search pages"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          if (query) onQueryChange("");
          else setOpen(false);
        }}
      />
      {query && (
        <button
          type="button"
          className="wiki-search-clear"
          aria-label="Clear search"
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function WikiView({
  initialPages,
  initialLabels,
}: {
  initialPages: WikiPageSummary[];
  initialLabels: WikiLabelResponse[];
}) {
  const router = useRouter();
  const { can } = usePermission();
  const canCreate = can("wiki.create");

  const pages = initialPages;
  const labels = initialLabels;
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterValue>({});
  const [view, setView] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("modified");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [infoPage, setInfoPage] = useState<WikiPageSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const createInFlight = useRef(false);

  const labelGroups: FilterGroup[] = useMemo(
    () => [{ id: "label", label: "Label", options: labels.map((label) => ({ id: label.id, label: label.name })) }],
    [labels]
  );
  const selectedLabelCount = (filters.label ?? []).length;

  async function createPage(): Promise<void> {
    if (!canCreate || createInFlight.current) return;
    createInFlight.current = true;
    setCreating(true);
    try {
      const response = await apiFetch("/api/wiki/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled", labelIds: [] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(data?.error || "Failed to create the page. Please try again.");
      } else if (typeof data?.page?.id === "string" && data.page.id) {
        router.push(`/wiki/${data.page.id}${can("wiki.update") ? "?edit=true" : ""}`);
        // Keep creation locked until navigation unmounts the list.
        return;
      } else {
        toast.error("Could not open the new page. Refresh the list to find it.");
      }
    } catch {
      toast.error("Network error. Please try again.");
    }
    createInFlight.current = false;
    setCreating(false);
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pages.filter((page) => {
      if (needle && !page.title.toLowerCase().includes(needle)) return false;
      if (view === "labeled" && page.labels.length === 0) return false;
      if (view === "unlabeled" && page.labels.length > 0) return false;
      return (filters.label ?? []).every((id) => page.labels.some((label) => label.id === id));
    }).sort((a, b) => {
      const difference =
        sortKey === "name"
          ? a.title.localeCompare(b.title)
          : sortKey === "created"
            ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            : new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      return (sortDir === "asc" ? difference : -difference) || a.id.localeCompare(b.id);
    });
  }, [pages, query, filters, view, sortKey, sortDir]);

  async function copyLink(page: WikiPageSummary) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/wiki/${page.id}`);
      toast.success("Page link copied");
    } catch {
      toast.error("Could not copy the link. Open the page and copy its address instead.");
    }
  }

  return (
    <section aria-label="Wiki" className="wiki-list-workspace">
      <h1 id="wiki-list-title" className="sr-only">Wiki pages</h1>
      <Tabs value={view} onValueChange={(value) => setView(String(value))} className="wiki-list-tabs">
        <div className="wiki-list-toolbar">
          <TabsList variant="line" aria-label="Wiki page views">
            <TabsTrigger value="all">All pages</TabsTrigger>
            <TabsTrigger value="labeled">Labeled</TabsTrigger>
            <TabsTrigger value="unlabeled">Unlabeled</TabsTrigger>
          </TabsList>
          <div className="wiki-list-controls">
            <CollapsingSearch query={query} onQueryChange={setQuery} />
            <Popover>
              <PopoverTrigger render={<Button size="lg" variant="secondary" icon={<Filter />} aria-label="Filter by label" />}>
                {selectedLabelCount ? `Labels · ${selectedLabelCount}` : "Filters"}
              </PopoverTrigger>
              <PopoverContent unstyled align="end" className="wiki-filter-popover">
                <PopoverTitle className="sr-only">Filter wiki pages by label</PopoverTitle>
                <FilterMenu title="Filters" groups={labelGroups} value={filters} onChange={setFilters} />
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="lg" variant="secondary"
                icon={sortDir === "asc" ? <ArrowUp /> : <ArrowDown />} aria-label="Sort wiki pages" />}>
                {SORT_KEY_LABELS[sortKey]}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="wiki-sort-menu">
                <DropdownMenuRadioGroup value={sortKey} onValueChange={(value) => setSortKey(value as SortKey)}>
                  <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="created">Date created</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="modified">Date modified</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={sortDir} onValueChange={(value) => setSortDir(value as SortDir)}>
                  <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {canCreate && <Button size="lg" icon={<Plus />} loading={creating} disabled={creating} onClick={() => void createPage()}>New page</Button>}
          </div>
        </div>
        <TabsContent value={view} className="wiki-list-panel">
          <ul aria-label="Wiki pages" className="wiki-page-list">
            {visible.map((page) => (
              <li key={page.id} className="wiki-page-row">
                <Link href={`/wiki/${page.id}`} className="wiki-page-link">
                  <span className="wiki-page-icon" aria-hidden="true"><FileDoc className="size-4" /></span>
                  <span className="wiki-page-name">{page.title}</span>
                </Link>
                <div className="wiki-page-actions">
                  <span title={`Last edited by ${page.updatedByName ?? page.authorName ?? "Unknown"}`}>
                    <Avatar size="sm" aria-label={`Last edited by ${page.updatedByName ?? page.authorName ?? "Unknown"}`}>
                      <AvatarFallback>{initials(page.updatedByName ?? page.authorName)}</AvatarFallback>
                    </Avatar>
                  </span>
                  <span className="wiki-page-divider" aria-hidden="true" />
                  <Button size="sm" variant="ghost" icon={<Info />} aria-label={`Page info: ${page.title}`}
                    title={`Created on ${formatDate(page.createdAt)}`}
                    onClick={() => setInfoPage(page)} />
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size="sm" variant="ghost" icon={<MoreHorizontal />}
                      aria-label={`More actions: ${page.title}`} />} />
                    <DropdownMenuContent align="end" className="min-w-40">
                      <DropdownMenuItem render={<Link href={`/wiki/${page.id}`} />}><FileDoc />Open page</DropdownMenuItem>
                      <DropdownMenuItem render={<Link href={`/wiki/${page.id}`} target="_blank" rel="noopener noreferrer" />}><ExternalLink />Open in new tab</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void copyLink(page)}><Copy />Copy link</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setInfoPage(page)}><Info />Page info</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="wiki-list-empty">
                <FileDoc className="size-6 text-muted-foreground" aria-hidden="true" />
                <p>{pages.length === 0 ? "No wiki pages yet" : "No pages match those filters"}</p>
                {pages.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{canCreate ? "Create your first page with New page." : "Pages shared with this workspace will appear here."}</p>
                ) : <Button size="sm" variant="secondary" onClick={() => { setQuery(""); setFilters({}); setView("all"); }}>Reset filters</Button>}
              </li>
            )}
          </ul>
        </TabsContent>
      </Tabs>

      <Dialog open={infoPage !== null} onOpenChange={(open) => { if (!open) setInfoPage(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Page info</DialogTitle>
            <DialogDescription className="break-words">{infoPage?.title}</DialogDescription>
          </DialogHeader>
          {infoPage && <dl className="wiki-page-info">
            <dt>Created by</dt><dd>{infoPage.authorName ?? "Unknown"}</dd>
            <dt>Created</dt><dd><time dateTime={infoPage.createdAt}>{formatDate(infoPage.createdAt)}</time></dd>
            <dt>Last edited by</dt><dd>{infoPage.updatedByName ?? infoPage.authorName ?? "Unknown"}</dd>
            <dt>Date modified</dt><dd><time dateTime={infoPage.updatedAt}>{formatDate(infoPage.updatedAt)}</time></dd>
            <dt>Comments</dt><dd className="tabular-nums">{infoPage.commentCount}</dd>
            <dt>Labels</dt><dd className="flex flex-wrap gap-1">{infoPage.labels.length
              ? infoPage.labels.map((label) => <Badge key={label.id} variant="outline">{label.name}</Badge>) : "No labels"}</dd>
          </dl>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
