"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AutosaveQueue } from "./autosave-queue";
import "./wiki-page.css";
import { toast } from "sonner";
import type { JSONContent } from "@tiptap/react";
import {
  ArrowRight,
  CommentIcon,
  Download,
  FileDoc,
  PanelLeft,
  Paperclip,
  Plus,
  TagIcon,
  Trash2,
} from "@/components/icons";
import { usePermission } from "@/components/dashboard/permission-provider";
import { WikiEditor } from "@/components/wiki/wiki-editor";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button-clean";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import type {
  WikiAttachmentResponse,
  WikiCommentResponse,
  WikiLabelResponse,
  WikiPageDetail,
} from "@/lib/wiki";

/**
 * /wiki/[id] — one page, two modes. Everything action-shaped is hidden without
 * its permission AND rejected by the API without it; this component only keeps
 * the UI from offering buttons the server would refuse.
 *
 * The right pane follows Plane's navigation pane: outline / info / assets tabs
 * (plus comments, which Plane keeps in a different place but this wiki has
 * page-level), driven by ?paneTab= so a pane state is shareable.
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

function formatRelative(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(iso));
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// --- document analysis (outline + stats) --------------------------------------

interface OutlineEntry {
  level: number;
  text: string;
}

/** Depth-first walk collecting every H1–H3 with its plain-text content. */
function extractOutline(node: JSONContent | null, into: OutlineEntry[] = []): OutlineEntry[] {
  if (!node) return into;
  if (node.type === "heading" && (node.attrs?.level as number | undefined) !== undefined) {
    const level = Number(node.attrs?.level);
    if (level >= 1 && level <= 3) {
      const text = flattenText(node).trim();
      if (text) into.push({ level, text });
    }
  }
  for (const child of node.content ?? []) extractOutline(child, into);
  return into;
}

function flattenText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(flattenText).join("");
}

interface DocumentStats {
  words: number;
  characters: number;
  paragraphs: number;
  readTime: string;
}

function computeStats(node: JSONContent | null): DocumentStats {
  let characters = 0;
  let words = 0;
  let paragraphs = 0;
  const visit = (current: JSONContent): void => {
    if (current.type === "text") {
      const text = current.text ?? "";
      characters += text.length;
      words += text.split(/\s+/).filter(Boolean).length;
    }
    if (current.type === "paragraph") paragraphs += 1;
    for (const child of current.content ?? []) visit(child);
  };
  if (node) visit(node);
  // 200 wpm reading pace; under a minute shows seconds, Plane-style.
  const seconds = Math.max(1, Math.round((words / 200) * 60));
  return {
    words,
    characters,
    paragraphs,
    readTime: seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`,
  };
}

const PANE_TABS = ["outline", "info", "assets", "comments"] as const;
type PaneTab = (typeof PANE_TABS)[number];

function isPaneTab(value: string | null): value is PaneTab {
  return value !== null && (PANE_TABS as readonly string[]).includes(value);
}

export function WikiPageView({
  initialPage,
  initialLabels,
  storageConfigured,
}: {
  initialPage: WikiPageDetail;
  initialLabels: WikiLabelResponse[];
  storageConfigured: boolean;
}) {
  const router = useRouter();
  const { user, can } = usePermission();
  const canEdit = can("wiki.update");
  const canComment = can("wiki.comment");
  const canDelete = can("wiki.delete");

  const [page, setPage] = useState(initialPage);
  const [labels, setLabels] = useState(initialLabels);

  const searchParams = useSearchParams();
  const mode = canEdit ? "edit" : "view";
  const [draftTitle, setDraftTitle] = useState(initialPage.title);
  const [draftContent, setDraftContent] = useState<JSONContent | null>(
    (initialPage.content as JSONContent | null) ?? null
  );
  const [draftLabelIds, setDraftLabelIds] = useState<Set<string>>(
    () => new Set(initialPage.labels.map((label) => label.id))
  );
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Plane-style right pane: outline / info / assets / comments.
  const [paneOpen, setPaneOpen] = useState(() => isPaneTab(searchParams.get("paneTab")));
  const [paneTab, setPaneTab] = useState<PaneTab>(() => {
    const fromUrl = searchParams.get("paneTab");
    return isPaneTab(fromUrl) ? fromUrl : "outline";
  });
  const [newLabelName, setNewLabelName] = useState("");
  const [creatingLabel, setCreatingLabel] = useState(false);

  const refreshPage = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/wiki/pages/${page.id}`);
      if (!response.ok) return;
      const data = await response.json();
      if (data?.page) setPage(data.page);
    } catch {
      /* transient — keep showing the last good copy */
    }
  }, [page.id]);

  const refreshLabels = useCallback(async () => {
    try {
      const response = await apiFetch("/api/wiki/labels");
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data?.labels)) setLabels(data.labels);
    } catch {
      /* transient */
    }
  }, []);

  const [autosave] = useState(() => new AutosaveQueue<WikiPageDetail>(
    JSON.stringify({
      title: initialPage.title.trim() || "Untitled",
      content: initialPage.content ?? null,
      labelIds: initialPage.labels.map(label => label.id).sort(),
    }),
    async (snapshot) => {
      const response = await apiFetch(`/api/wiki/pages/${initialPage.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: snapshot,
      });
      const data = await readBody(response);
      if (!response.ok || !data.page) {
        throw new Error((data.error as string) || "Could not save changes.");
      }
      return data.page as WikiPageDetail;
    },
    (savedPage) => {
      setPage(savedPage);
      setSaveError(null);
    },
    (error) => setSaveError(error instanceof Error ? error.message : "Could not save changes."),
    setSavePending,
  ));

  useEffect(() => {
    if (!canEdit) return;
    autosave.enqueue(JSON.stringify({
      title: draftTitle.trim() || "Untitled",
      content: draftContent,
      labelIds: [...draftLabelIds].sort(),
    }));
  }, [autosave, canEdit, draftTitle, draftContent, draftLabelIds]);

  useEffect(() => {
    if (!canEdit) return;
    const retry = () => { void autosave.flush(); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!autosave.pending) return;
      void autosave.flush();
      event.preventDefault();
      event.returnValue = "";
    };
    // Wait for pending writes before ordinary in-app link navigation. A failed
    // write leaves the writer mounted, with the draft and Retry still available.
    const beforeNavigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !autosave.pending) return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      void autosave.flush().then(() => {
        if (!autosave.pending) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("online", retry);
    document.addEventListener("click", beforeNavigate, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("online", retry);
      document.removeEventListener("click", beforeNavigate, true);
      void autosave.flush();
    };
  }, [autosave, canEdit, router]);

  /** Plane syncs the pane tab into ?paneTab=; a history-only write so it never
   *  re-runs the server component for a pure view preference. */
  function selectPaneTab(tab: PaneTab): void {
    setPaneTab(tab);
    const params = new URLSearchParams(window.location.search);
    params.set("paneTab", tab);
    window.history.replaceState(null, "", `/wiki/${page.id}?${params.toString()}`);
  }

  async function createLabel(): Promise<void> {
    const name = newLabelName.trim();
    if (!name) return;
    setCreatingLabel(true);
    try {
      const response = await apiFetch("/api/wiki/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await readBody(response);
      if (!response.ok) {
        toast.error((data.error as string) || "Could not create the label");
        return;
      }
      setNewLabelName("");
      await refreshLabels();
      if (data.label) {
        setDraftLabelIds((previous) => new Set(previous).add((data.label as WikiLabelResponse).id));
      }
      toast.success(`Created label ${name}`);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setCreatingLabel(false);
    }
  }

  /**
   * Upload through the API and hand the resulting `/api/wiki/files/{id}` URL
   * back to the editor, which is the only shape content ever references.
   */
  async function uploadAttachment(file: File): Promise<string | null> {
    const form = new FormData();
    form.append("file", file);
    form.append("pageId", page.id);
    form.append("visibility", "private");
    try {
      const response = await apiFetch("/api/wiki/attachments", { method: "POST", body: form });
      const data = await readBody(response);
      if (!response.ok) {
        toast.error((data.error as string) || "Upload failed");
        return null;
      }
      await refreshPage();
      const attachment = data.attachment as WikiAttachmentResponse | undefined;
      return attachment?.url ?? null;
    } catch {
      // A transport failure mid-upload must never reject up into the editor's
      // void upload() — same contract as autosave/postComment.
      toast.error("Network error. Please try again.");
      return null;
    }
  }

  const uploadHint = storageConfigured
    ? undefined
    : "Storage is not configured, so uploads are disabled";

  const stats = useMemo(() => computeStats(draftContent), [draftContent]);
  const outline = useMemo(() => extractOutline(draftContent), [draftContent]);

  function scrollToHeading(text: string): void {
    const headings = document.querySelectorAll<HTMLHeadingElement>(".wiki-document-main h1, .wiki-document-main h2, .wiki-document-main h3");
    for (const heading of headings) {
      if ((heading.textContent ?? "").trim() === text) {
        heading.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "start",
        });
        return;
      }
    }
  }

  return (
    <section aria-label={page.title} className="wiki-document-workspace" data-mode={mode}>
      {canEdit && (
        <>
          <span role="status" className="sr-only">{savePending ? "Saving changes" : "All changes saved"}</span>
          {saveError && (
            <div role="alert" className="wiki-autosave-error">
              <span>{saveError} Keep this page open to preserve your changes.</span>
              <Button size="sm" variant="secondary" onClick={() => void autosave.flush()}>Retry</Button>
            </div>
          )}
        </>
      )}

      <div className="wiki-document-layout" data-pane={paneOpen ? "true" : "false"}>
      <div className="wiki-document-main">
      <WikiEditor
        content={draftContent}
        editable={mode === "edit"}
        onChange={setDraftContent}
        storageReady={storageConfigured && mode === "edit"}
        uploadHint={uploadHint}
        onInsertImage={uploadAttachment}
        onAttachFile={uploadAttachment}
        placeholder="Press '/' for commands…"
        toolbarStart={
          <Button
            size="sm"
            variant="ghost"
            icon={<PanelLeft />}
            aria-label={paneOpen ? "Hide details panel" : "Show details panel"}
            aria-pressed={paneOpen}
            onClick={() => setPaneOpen((open) => !open)}
          />
        }
        documentHeader={
          <header className="wiki-document-heading">
            {mode === "edit" ? (
              <>
                <h1 className="sr-only">{page.title}</h1>
                <Textarea
                  aria-label="Page title"
                  className="wiki-document-title-input"
                  value={draftTitle}
                  data-untitled={draftTitle === "Untitled" || undefined}
                  placeholder="Untitled"
                  rows={1}
                  maxLength={200}
                  autoFocus
                  onFocus={(event) => {
                    if (event.currentTarget.value === "Untitled") event.currentTarget.select();
                  }}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.closest(".wiki-document-body")?.querySelector<HTMLElement>(".ProseMirror")?.focus();
                    }
                  }}
                />
              </>
            ) : <h1 className="wiki-document-title">{page.title}</h1>}
          </header>
        }
      />
      </div>

      <aside className="wiki-pane" data-open={paneOpen ? "true" : "false"}>
        <div className="wiki-pane-close">
          <button
            type="button"
            className="wiki-pane-close-button"
            aria-label="Hide details panel"
            onClick={() => setPaneOpen(false)}
          >
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="wiki-pane-tabs" role="tablist" aria-label="Page panels">
          <button type="button" role="tab" id="wiki-pane-tab-outline" aria-selected={paneTab === "outline"}
            aria-controls="wiki-pane-panel" onClick={() => selectPaneTab("outline")}>Outline</button>
          <button type="button" role="tab" id="wiki-pane-tab-info" aria-selected={paneTab === "info"}
            aria-controls="wiki-pane-panel" onClick={() => selectPaneTab("info")}>Info</button>
          <button type="button" role="tab" id="wiki-pane-tab-assets" aria-selected={paneTab === "assets"}
            aria-controls="wiki-pane-panel" onClick={() => selectPaneTab("assets")}>Assets</button>
          <button type="button" role="tab" id="wiki-pane-tab-comments" aria-selected={paneTab === "comments"}
            aria-controls="wiki-pane-panel" onClick={() => selectPaneTab("comments")}>
            Comments{page.comments.length > 0 && <span className="tabular-nums"> {page.comments.length}</span>}
          </button>
        </div>
        <div className="wiki-pane-body" role="tabpanel" id="wiki-pane-panel" aria-labelledby={`wiki-pane-tab-${paneTab}`}>
        {paneTab === "comments" ? (
          <CommentsPanel
            pageId={page.id}
            initialComments={page.comments}
            canComment={canComment}
            currentUserId={user?.id ?? null}
            canModerate={canDelete}
          />
        ) : paneTab === "outline" ? (
          <OutlinePanel outline={outline} onJump={scrollToHeading} />
        ) : paneTab === "assets" ? (
          <AssetsPanel attachments={page.attachments} storageConfigured={storageConfigured} />
        ) : (
        <>
        <section className="wiki-pane-section wiki-pane-stats" aria-label="Document statistics">
          <div className="wiki-stat-card">
            <span className="wiki-stat-value tabular-nums">{stats.words}</span>
            <span className="wiki-stat-label">Words</span>
          </div>
          <div className="wiki-stat-card">
            <span className="wiki-stat-value tabular-nums">{stats.characters}</span>
            <span className="wiki-stat-label">Characters</span>
          </div>
          <div className="wiki-stat-card">
            <span className="wiki-stat-value tabular-nums">{stats.paragraphs}</span>
            <span className="wiki-stat-label">Paragraphs</span>
          </div>
          <div className="wiki-stat-card">
            <span className="wiki-stat-value tabular-nums">{stats.readTime}</span>
            <span className="wiki-stat-label">Read time</span>
          </div>
        </section>

        <div className="wiki-pane-actors">
          <div className="wiki-pane-actor">
            <span className="wiki-pane-actor-role">Edited by</span>
            <span className="wiki-pane-actor-person">
              <Avatar size="sm" aria-hidden="true">
                <AvatarFallback>{initials(page.updatedByName ?? page.authorName)}</AvatarFallback>
              </Avatar>
              <span>
                {page.updatedByName ?? page.authorName ?? "Unknown"}
                <time dateTime={page.updatedAt}> · {formatRelative(page.updatedAt)}</time>
              </span>
            </span>
          </div>
          <div className="wiki-pane-actor">
            <span className="wiki-pane-actor-role">Created by</span>
            <span className="wiki-pane-actor-person">
              <Avatar size="sm" aria-hidden="true">
                <AvatarFallback>{initials(page.authorName)}</AvatarFallback>
              </Avatar>
              <span>
                {page.authorName ?? "Unknown"}
                <time dateTime={page.createdAt}> · {formatDate(page.createdAt)}</time>
              </span>
            </span>
          </div>
        </div>

        <section className="wiki-pane-section" aria-labelledby="wiki-labels-title">
          <h2 id="wiki-labels-title" className="wiki-pane-heading">
            <TagIcon className="size-3.5" aria-hidden="true" />Labels
            <span className="tabular-nums">{mode === "edit" ? draftLabelIds.size : page.labels.length}</span>
          </h2>
          <div className="wiki-document-labels">
            <TagIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {mode === "view" ? (
              page.labels.length === 0 ? (
                <span className="text-xs text-muted-foreground">No labels</span>
              ) : (
                page.labels.map((label) => (
                  <Badge key={label.id} variant="outline">
                    {label.name}
                  </Badge>
                ))
              )
            ) : (
              <>
                {labels.map((label) => (
                  <label key={label.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <Checkbox
                      aria-label={`Label ${label.name}`}
                      checked={draftLabelIds.has(label.id)}
                      onCheckedChange={(checked) =>
                        setDraftLabelIds((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(label.id);
                          else next.delete(label.id);
                          return next;
                        })
                      }
                    />
                    <span>{label.name}</span>
                  </label>
                ))}
                <span className="flex items-center gap-1.5">
                  <Input
                    aria-label="New label name"
                    placeholder="New label…"
                    value={newLabelName}
                    onChange={(event) => setNewLabelName(event.target.value)}
                    className="h-7 w-32 text-xs"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void createLabel();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Plus />}
                    loading={creatingLabel}
                    disabled={!newLabelName.trim()}
                    onClick={() => void createLabel()}
                  >
                    Add
                  </Button>
                </span>
              </>
            )}
          </div>
        </section>
        </>
        )}
        </div>
      </aside>
      </div>

    </section>
  );
}

function OutlinePanel({
  outline,
  onJump,
}: {
  outline: OutlineEntry[];
  onJump: (text: string) => void;
}) {
  if (outline.length === 0) {
    return (
      <p className="wiki-pane-empty">
        No headings yet. Add a heading in the document and it will appear here.
      </p>
    );
  }
  return (
    <nav aria-label="Document outline" className="wiki-outline">
      <ul>
        {outline.map((entry, index) => (
          <li key={`${entry.text}-${index}`} style={{ paddingInlineStart: `${(entry.level - 1) * 0.875}rem` }}>
            <button
              type="button"
              className="wiki-outline-link"
              data-level={entry.level}
              title={entry.text}
              onClick={() => onJump(entry.text)}
            >
              {entry.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function AssetsPanel({
  attachments,
  storageConfigured,
}: {
  attachments: WikiAttachmentResponse[];
  storageConfigured: boolean;
}) {
  return (
    <section className="wiki-pane-section" aria-labelledby="wiki-attachments-title">
      <h2 id="wiki-attachments-title" className="wiki-pane-heading">
        <Paperclip className="size-3.5" aria-hidden="true" />Attachments
        <span className="tabular-nums">{attachments.length}</span>
      </h2>
      {attachments.length === 0 ? (
        <p className="wiki-pane-empty">
          {storageConfigured
            ? "No files attached. Use the image or attach button in the editor."
            : "No files attached. Uploads are disabled until an administrator configures storage."}
        </p>
      ) : (
        <ul className="wiki-assets">
          {attachments.map((attachment) => {
            const isImage = attachment.mimeType.startsWith("image/");
            return (
              <li key={attachment.id}>
                <a href={attachment.url} className="wiki-asset-row" title={attachment.fileName}>
                  {isImage ? (
                    // Plain <img>: the URL is the permission-checked
                    // /api/wiki/files/{id} redirect, not a remote host.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={attachment.url} alt="" width={48} height={44} className="wiki-asset-thumb" />
                  ) : (
                    <span className="wiki-asset-thumb wiki-asset-thumb-file" aria-hidden="true">
                      <FileDoc className="size-4" />
                    </span>
                  )}
                  <span className="wiki-asset-name">{attachment.fileName}</span>
                  <span className="wiki-asset-meta">
                    <span className="tabular-nums">{formatBytes(attachment.sizeBytes)}</span>
                    <a
                      href={attachment.url}
                      download={attachment.fileName}
                      aria-label={`Download ${attachment.fileName}`}
                      className="wiki-asset-download"
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                    </a>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CommentsPanel({
  pageId,
  initialComments,
  canComment,
  currentUserId,
  canModerate,
}: {
  pageId: string;
  initialComments: WikiCommentResponse[];
  canComment: boolean;
  currentUserId: string | null;
  canModerate: boolean;
}) {
  const [comments, setComments] = useState(initialComments);
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function post(): Promise<void> {
    setPosting(true);
    try {
      const response = await apiFetch(`/api/wiki/pages/${pageId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await readBody(response);
      if (!response.ok) {
        toast.error((data.error as string) || "Could not post the comment");
        return;
      }
      setBody("");
      if (data.comment) setComments((previous) => [...previous, data.comment as WikiCommentResponse]);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setPosting(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setRemovingId(id);
    try {
      const response = await apiFetch(`/api/wiki/comments/${id}`, { method: "DELETE" });
      const data = await readBody(response);
      if (!response.ok) {
        toast.error((data.error as string) || "Could not delete the comment");
        return;
      }
      setComments((previous) => previous.filter((comment) => comment.id !== id));
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className="task-sheet min-w-0" aria-labelledby="wiki-comments-title">
      <div className="task-sheet-toolbar flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <CommentIcon className="size-4" aria-hidden="true" />
          <h2 id="wiki-comments-title">Comments</h2>
        </div>
        <span className="task-sheet-count tabular-nums">{comments.length}</span>
      </div>

      {canComment && (
        <div className="grid gap-2 border-b border-border p-3">
          <Textarea
            aria-label="Write a comment"
            placeholder={canComment ? "Add a comment…" : "Comment"}
            value={body}
            rows={3}
            maxLength={5000}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={posting}
              disabled={!body.trim()}
              onClick={() => void post()}
            >
              Comment
            </Button>
          </div>
        </div>
      )}

      {comments.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {comments.map((comment) => {
            // The server decides this; mirroring it here only hides a button
            // that would come back 403.
            const mayRemove = comment.authorId === currentUserId || canModerate;
            return (
              <li key={comment.id} className="flex items-start gap-3 px-3 py-3">
                <Avatar size="sm" aria-hidden="true">
                  <AvatarFallback>{initials(comment.authorName)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {comment.authorName ?? "Unknown"}
                    </span>
                    <time dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
                </div>
                {mayRemove && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 />}
                    aria-label={`Delete comment by ${comment.authorName ?? "unknown"}`}
                    loading={removingId === comment.id}
                    disabled={removingId !== null && removingId !== comment.id}
                    onClick={() => void remove(comment.id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
