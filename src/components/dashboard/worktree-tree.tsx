"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { ChatGptIcon, ClaudeIcon, FigmaIcon, GithubIcon, GoogleGeminiIcon, NotionIcon, SlackIcon, StripeIcon } from "@hugeicons/core-free-icons";
import { parseDurationToSeconds, formatSecondsToDuration } from "./agent-board-data";
import { formatTokens, type WorktreeAvatar, type WorktreeNode, type WorktreeState, type WorktreeTool } from "./worktree-tree-data";
import { AlertCircle, Check, ChevronDown, Clock, Minus, Plus, RotateCcw } from "@/components/icons";
import { cn } from "@/lib/utils";

const avatarIcons: Record<WorktreeAvatar, IconSvgElement> = {
  claude: ClaudeIcon,
  gemini: GoogleGeminiIcon,
  openai: ChatGptIcon,
};

const toolIcons: Record<Exclude<WorktreeTool, "hubspot">, IconSvgElement> = {
  slack: SlackIcon,
  notion: NotionIcon,
  github: GithubIcon,
  figma: FigmaIcon,
  stripe: StripeIcon,
};

const stateWord: Record<WorktreeState, string> = {
  waiting: "Needs you",
  failed: "Failed",
  running: "Running",
  done: "Done",
};

function StateBadgeIcon({ state }: { state: WorktreeState }) {
  if (state === "running") return <span aria-hidden="true" className="size-2.5 rounded-full border-[1.5px] border-current/25 border-t-current motion-safe:animate-spin" />;
  if (state === "done") return <Check className="size-2.5" />;
  if (state === "failed") return <AlertCircle className="size-2.5" />;
  return <Clock className="size-2.5" />;
}

function ToolMark({ tool }: { tool: WorktreeTool }) {
  return (
    <span className={cn("worktree-tool", `worktree-tool-${tool}`)} title={tool}>
      {tool === "slack" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path fill="#36c5f0" d="M6 1a1.5 1.5 0 0 1 1.5 1.5V6H6A1.5 1.5 0 0 1 4.5 4.5v-2A1.5 1.5 0 0 1 6 1ZM1 6a1.5 1.5 0 1 1 3 0v1.5H2.5A1.5 1.5 0 0 1 1 6Z" />
          <path fill="#2eb67d" d="M15 6a1.5 1.5 0 0 1-1.5 1.5H10V6a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 15 6Zm-5-5a1.5 1.5 0 1 1 0 3H8.5V2.5A1.5 1.5 0 0 1 10 1Z" />
          <path fill="#ecb22e" d="M10 15a1.5 1.5 0 0 1-1.5-1.5V10H10a1.5 1.5 0 0 1 1.5 1.5v2A1.5 1.5 0 0 1 10 15Zm5-5a1.5 1.5 0 1 1-3 0V8.5h1.5A1.5 1.5 0 0 1 15 10Z" />
          <path fill="#e01e5a" d="M1 10a1.5 1.5 0 0 1 1.5-1.5H6V10a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 1 10Zm5 5a1.5 1.5 0 1 1 0-3h1.5v1.5A1.5 1.5 0 0 1 6 15Z" />
        </svg>
      ) : tool === "figma" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path fill="#f24e1e" d="M8 1H5.5a2.5 2.5 0 0 0 0 5H8Z" />
          <path fill="#ff7262" d="M8 1h2.5a2.5 2.5 0 0 1 0 5H8Z" />
          <path fill="#a259ff" d="M8 6H5.5a2.5 2.5 0 0 0 0 5H8Z" />
          <circle cx="10.5" cy="8.5" r="2.5" fill="#1abcfe" />
          <path fill="#0acf83" d="M8 11H5.5A2.5 2.5 0 1 0 8 13.5Z" />
        </svg>
      ) : tool === "hubspot" ? (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m3 3 5 4m0 0V3m0 4 4 3m-4-3-3 5" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="7" r="2" fill="currentColor" />
          <circle cx="3" cy="3" r="1.5" fill="currentColor" />
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="10" r="1.5" fill="currentColor" />
        </svg>
      ) : <HugeiconsIcon icon={toolIcons[tool]} size={12} strokeWidth={1.6} aria-hidden="true" />}
    </span>
  );
}

function collectParentIds(node: WorktreeNode, into: string[] = []): string[] {
  if (node.children?.length) {
    into.push(node.id);
    for (const child of node.children) collectParentIds(child, into);
  }
  return into;
}

function WorktreeCard({ node, open, onToggle }: {
  node: WorktreeNode;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const childCount = node.children?.length ?? 0;
  const isRunning = node.state === "running";
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setElapsed(s => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  const baseSeconds = parseDurationToSeconds(node.time);
  const displayTime = isRunning ? formatSecondsToDuration(baseSeconds + elapsed) : node.time;

  return (
    <div
      data-worktree-card={node.id}
      onClick={childCount ? () => onToggle(node.id) : undefined}
      className={cn("worktree-card", childCount > 0 && "cursor-pointer")}
    >
      <div className="worktree-heading flex items-center gap-2">
        <span className={cn("worktree-avatar", `worktree-avatar-${node.avatar}`)}>
          <HugeiconsIcon icon={avatarIcons[node.avatar]} size={16} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="worktree-name block text-[0.8125rem] font-medium leading-[1.154] text-foreground">{node.agent}</span>
          <span className="worktree-model block text-[0.6875rem] leading-[1.273]">{node.model}</span>
        </span>
      </div>
      <span className={cn("worktree-status", `worktree-status-${node.state}`)}>
        <StateBadgeIcon state={node.state} />
        {stateWord[node.state]}
      </span>
      <p className="worktree-task">
        <span aria-hidden="true" className="worktree-tools">{node.tools.map(tool => <ToolMark key={tool} tool={tool} />)}</span>
        {" "}{node.task}
      </p>
      <div className="worktree-meta mt-auto flex min-h-4 items-center gap-1 text-[0.6875rem] tabular-nums">
        {node.tokenUsage ? (
          <span
            className="font-medium text-foreground"
            title={`Total Tokens: ${node.tokenUsage.totalTokens.toLocaleString()} (Input: ${node.tokenUsage.inputTokens.toLocaleString()}, Output: ${node.tokenUsage.outputTokens.toLocaleString()}${node.tokenUsage.cacheReadTokens ? `, Cache Read: ${node.tokenUsage.cacheReadTokens.toLocaleString()}` : ""}${node.tokenUsage.cacheWriteTokens ? `, Cache Write: ${node.tokenUsage.cacheWriteTokens.toLocaleString()}` : ""})`}
          >
            {formatTokens(node.tokenUsage.totalTokens)}
          </span>
        ) : (
          <span className="text-foreground">{node.cost}</span>
        )}
        <span className="worktree-model">· {displayTime}</span>
        {childCount > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`worktree-fold-${node.id}`}
            aria-label={open ? `Fold the sub-agents of ${node.agent}` : `Show ${childCount} sub-agents of ${node.agent}`}
            onClick={event => { event.stopPropagation(); onToggle(node.id); }}
            className="worktree-fold ms-auto inline-flex cursor-pointer items-center gap-0.5 rounded px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {childCount}
            <span className="t-acc-chevron"><ChevronDown className="size-2.5" /></span>
          </button>
        )}
      </div>
      {childCount > 0 && <span aria-hidden="true" className="worktree-port" />}
    </div>
  );
}

function TreeNode({ node, parentId, depth, openIds, focusedId, onToggle, onFocusNode }: {
  node: WorktreeNode;
  parentId: string | null;
  depth: number;
  openIds: readonly string[];
  focusedId: string;
  onToggle: (id: string) => void;
  onFocusNode: (id: string) => void;
}) {
  const hasChildren = !!node.children?.length;
  const open = hasChildren && openIds.includes(node.id);
  const foldId = `worktree-fold-${node.id}`;

  return (
    <li
      role="treeitem"
      data-tree-node={node.id}
      data-parent-id={parentId ?? undefined}
      data-has-children={hasChildren ? "true" : "false"}
      data-state={node.state}
      data-open={hasChildren ? String(open) : undefined}
      aria-level={depth + 1}
      aria-selected={focusedId === node.id}
      aria-expanded={hasChildren ? open : undefined}
      aria-controls={hasChildren ? foldId : undefined}
      tabIndex={focusedId === node.id ? 0 : -1}
      onFocus={event => { if (event.target === event.currentTarget) onFocusNode(node.id); }}
      className={cn("t-acc worktree-node", depth === 0 && "worktree-root")}
    >
      <WorktreeCard node={node} open={open} onToggle={id => { onFocusNode(id); onToggle(id); }} />
      {hasChildren && (
        <div id={foldId} className="t-acc-panel worktree-children" aria-hidden={!open}>
          <div className="t-acc-panel-inner" inert={!open}>
            <ul role="group" aria-label={`${node.agent} sub-agents`} className={depth === 0 ? "worktree-columns" : "worktree-branches"}>
              {node.children!.map(child => (
                <TreeNode key={child.id} node={child} parentId={node.id} depth={depth + 1} openIds={openIds} focusedId={focusedId} onToggle={onToggle} onFocusNode={onFocusNode} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
/** Gap between the canvas top and the stage (matches .worktree-stage); zoom maths measure from it. */
const STAGE_TOP = 24;
const FOCUS_MARGIN = 24;

interface ViewState { x: number; y: number; scale: number }
const HOME: ViewState = { x: 0, y: 0, scale: 1 };

/**
 * A pan/zoom canvas: the tree keeps its natural size and may overflow the
 * frame. Drag to pan; Ctrl/Cmd + scroll (or pinch) or the buttons to zoom.
 * Plain scroll is left alone so the page still scrolls past it.
 */
function WorktreeViewport({ style, children }: { style: CSSProperties; children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewState>(HOME);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ id: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  // (qx, qy) is the zoom anchor, measured from the stage's top-centre at scale 1.
  const zoomAt = useCallback((factor: number, qx: number, qy: number) => {
    setView(current => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      const k = scale / current.scale;
      return { scale, x: qx - (qx - current.x) * k, y: qy - (qy - current.y) * k };
    });
  }, []);

  const zoomFromCenter = (factor: number) => {
    const el = viewportRef.current;
    zoomAt(factor, 0, el ? el.clientHeight / 2 - STAGE_TOP : 0);
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    // Not React's onWheel: that listener is passive and cannot stop the page zooming.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = Math.max(-100, Math.min(100, event.deltaY));
      zoomAt(Math.exp(-delta * 0.0025), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - STAGE_TOP);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-worktree-controls]")) return;
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return; // still a click
      d.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
    }
    setView(current => ({ ...current, x: d.originX + dx, y: d.originY + dy }));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (d.moved) {
      // The release would otherwise count as a click and fold a card.
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      setPanning(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomFromCenter(1.2); }
    else if (event.key === "-") { event.preventDefault(); zoomFromCenter(1 / 1.2); }
    else if (event.key === "0") { event.preventDefault(); setView(HOME); }
  };

  // Keyboard focus can land on a card that is panned out of sight; bring it back.
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const el = viewportRef.current;
    if (!el || !target.matches("[data-tree-node]")) return;
    const card = target.querySelector<HTMLElement>(":scope > [data-worktree-card]") ?? target;
    const frame = el.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const shift = (min: number, max: number, lo: number, hi: number) =>
      min < lo + FOCUS_MARGIN ? lo + FOCUS_MARGIN - min : max > hi - FOCUS_MARGIN ? hi - FOCUS_MARGIN - max : 0;
    const dx = shift(box.left, box.right, frame.left, frame.right);
    const dy = shift(box.top, box.bottom, frame.top, frame.bottom);
    if (dx || dy) setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  return (
    <div
      ref={viewportRef}
      className="worktree-canvas"
      data-panning={panning ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={event => { if (suppressClick.current) { event.stopPropagation(); event.preventDefault(); } }}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocusCapture}
    >
      <div
        className="worktree-stage"
        style={{ ...style, transform: `translate(-50%, 0) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        {children}
      </div>
      <div data-worktree-controls role="group" aria-label="Zoom" className="worktree-controls">
        <button type="button" aria-label="Zoom out" title="Zoom out (-)" disabled={view.scale <= MIN_SCALE} onClick={() => zoomFromCenter(1 / 1.2)}><Minus className="size-3.5" /></button>
        <span aria-live="polite" className="worktree-zoom-level" title="Ctrl + scroll to zoom, drag to pan">{Math.round(view.scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={view.scale >= MAX_SCALE} onClick={() => zoomFromCenter(1.2)}><Plus className="size-3.5" /></button>
        <button type="button" aria-label="Reset view" title="Reset view (0)" onClick={() => setView(HOME)}><RotateCcw className="size-3.5" /></button>
      </div>
    </div>
  );
}

export function WorktreeTree({ run }: { run: WorktreeNode }) {
  const [openIds, setOpenIds] = useState<string[]>(() => collectParentIds(run));
  const [focusedId, setFocusedId] = useState(run.id);
  const treeRef = useRef<HTMLUListElement | null>(null);
  const toggle = (id: string) =>
    setOpenIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const items = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-node]") ?? [])
      .filter(element => !element.closest("[inert]"));
    const current = items.findIndex(element => element.dataset.treeNode === focusedId);
    if (current === -1) return;
    const node = items[current];
    const focusAt = (index: number) => items[Math.max(0, Math.min(items.length - 1, index))]?.focus();
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); focusAt(current + 1); break;
      case "ArrowUp": event.preventDefault(); focusAt(current - 1); break;
      case "ArrowRight":
        event.preventDefault();
        if (node.dataset.hasChildren === "true" && node.dataset.open !== "true") toggle(node.dataset.treeNode!);
        else if (node.dataset.hasChildren === "true") focusAt(current + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (node.dataset.hasChildren === "true" && node.dataset.open === "true") toggle(node.dataset.treeNode!);
        else items.find(item => item.dataset.treeNode === node.dataset.parentId)?.focus();
        break;
      case "Enter":
      case " ":
        if (node.dataset.hasChildren === "true") { event.preventDefault(); toggle(node.dataset.treeNode!); }
        break;
      case "Home": event.preventDefault(); focusAt(0); break;
      case "End": event.preventDefault(); focusAt(items.length - 1); break;
    }
  };

  return (
    <WorktreeViewport style={{ "--worktree-column-count": Math.max(1, run.children?.length ?? 0) } as CSSProperties}>
      <ul ref={treeRef} role="tree" aria-label="Agent run" onKeyDown={onKeyDown} className="worktree-tree">
        <TreeNode node={run} parentId={null} depth={0} openIds={openIds} focusedId={focusedId} onToggle={toggle} onFocusNode={setFocusedId} />
      </ul>
    </WorktreeViewport>
  );
}
