"use client";

import { useEffect, useState, type ComponentType } from "react";
import { Check, ChevronDown, Clock, Loader2, Minus, X, Zap } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
  agentColumns,
  agentTaskColumn,
  formatClock,
  formatDateTime,
  formatRunTime,
  runMillis,
  taskTimeline,
  type AgentColumnId,
  type AgentTask,
  type AgentTaskState,
} from "./agent-board-data";
import { formatTokens } from "./worktree-tree-data";

const stateIcons: Record<AgentTaskState, ComponentType<{ className?: string }>> = {
  backlog: Minus,
  todo: Clock,
  running: Loader2,
  done: Check,
  wontdo: X,
};

/* State color lives on the icon only; the word and time stay muted (Affect UI behavior). */
const stateColor: Record<AgentTaskState, string> = {
  backlog: "text-muted-foreground",
  todo: "text-muted-foreground",
  running: "text-[var(--agent-running)]",
  done: "text-[var(--agent-done)]",
  wontdo: "text-muted-foreground",
};

const stateLabel: Record<AgentTaskState, string> = {
  backlog: "Backlog",
  todo: "To do",
  running: "Running",
  done: "Done",
  wontdo: "Won't do",
};

/** `Date.now()`, re-read every second while `live`, so a running card counts up
 *  from the task's real start rather than from when the page was opened. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [live]);
  return now;
}

/** The card's status line: state, how long it ran, and when it started or finished. */
export function AgentTaskStatus({ task }: { task: AgentTask }) {
  const { state } = task;
  const Icon = stateIcons[state];
  const now = useNow(state === "running");
  const ran = runMillis(task, now);
  const parts: string[] = [stateLabel[state]];
  if (ran !== null && (state === "running" || state === "done")) parts.push(formatRunTime(ran));
  if (state === "running" && task.startedAt) parts.push(`started ${formatClock(task.startedAt, new Date(now))}`);
  if (state === "done" && task.completedAt) parts.push(`finished ${formatClock(task.completedAt, new Date(now))}`);
  if (state === "wontdo" && task.completedAt) parts.push(`closed ${formatClock(task.completedAt, new Date(now))}`);

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] tabular-nums text-muted-foreground">
      <Icon className={cn("size-3 shrink-0", stateColor[state], state === "running" && "motion-safe:animate-spin")} />
      <span>{parts.join(" · ")}</span>
    </span>
  );
}

/** Tokens the task's agents spent. Shown once the task has run, even at zero:
 *  zero then means no session reported against it, which is worth seeing. */
function AgentTaskTokens({ task }: { task: AgentTask }) {
  const total = task.tokens.totalTokens;
  if (total === 0 && !task.startedAt) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground/80" title={`${total.toLocaleString()} tokens`}>
      <Zap className="size-3" aria-hidden="true" />
      {formatTokens(total)}
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground/80">{label}</dt>
      <dd className="min-w-0 tabular-nums text-muted-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function AgentTaskCard({
  task,
  open,
  justMoved,
  onToggle,
}: {
  task: AgentTask;
  open: boolean;
  justMoved?: boolean;
  onToggle: (id: string) => void;
}) {
  const foldId = `agent-fold-${task.id}`;
  const timeline = taskTimeline(task);
  // Only decides "today" vs a dated label; it does not need to tick.
  const clock = useNow(false);
  return (
    <li
      data-agent-task={task.id}
      data-state={task.state}
      data-open={open ? "true" : "false"}
      data-just-moved={justMoved ? "true" : undefined}
      className="t-acc min-w-0 rounded-[10px] bg-card shadow-xs ring-1 ring-black/[0.08] transition-[translate,scale,box-shadow] duration-150 ease-out hover:-translate-y-px hover:shadow-md active:scale-[0.99] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:shadow-none motion-reduce:active:scale-100 dark:ring-white/[0.08]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={foldId}
        onClick={() => onToggle(task.id)}
        className="flex w-full min-w-0 cursor-pointer flex-col items-stretch gap-1.5 rounded-[10px] p-3 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{task.title}</span>
        <span className={cn("min-w-0 text-sm leading-normal text-muted-foreground [overflow-wrap:anywhere]", !open && "line-clamp-3")}>{task.description}</span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <AgentTaskStatus task={task} />
          <span className="flex shrink-0 items-center gap-3">
            <AgentTaskTokens task={task} />
            <span className="t-acc-chevron shrink-0 text-muted-foreground/60">
              <ChevronDown className="size-3.5" />
            </span>
          </span>
        </span>
      </button>
      <div id={foldId} className="t-acc-panel">
        <div className="t-acc-panel-inner" inert={!open}>
          {/* Padding lives on this child, not on .t-acc-panel-inner —
              vertical padding on the 0fr grid item leaves a residual strip. */}
          <div className="px-3 pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <DetailRow label="Agent">{task.agent}</DetailRow>
              {(() => {
                // Closed tasks only: their run time ends at completedAt, not now.
                const ran = runMillis(task, 0);
                return ran !== null && task.state !== "running" ? <DetailRow label="Took">{formatRunTime(ran)}</DetailRow> : null;
              })()}
              {(task.startedAt || task.tokens.totalTokens > 0) && (
                <DetailRow label="Tokens">
                  {task.tokens.totalTokens.toLocaleString()} total · {task.tokens.inputTokens.toLocaleString()} in · {task.tokens.outputTokens.toLocaleString()} out
                  {(task.tokens.cacheReadTokens || task.tokens.cacheWriteTokens)
                    ? ` · ${(task.tokens.cacheReadTokens ?? 0).toLocaleString()} cache read · ${(task.tokens.cacheWriteTokens ?? 0).toLocaleString()} cache write`
                    : ""}
                </DetailRow>
              )}
            </dl>

            {task.rejectionReason && (
              <div className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                <span className="font-semibold">Rejection note: </span>
                {task.rejectionReason}
              </div>
            )}

            {task.contextFiles && task.contextFiles.length > 0 && (
              <div className="mt-2 text-xs">
                <span className="font-medium text-muted-foreground">Context files: </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {task.contextFiles.map((file, i) => (
                    <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground" title={file.description}>
                      {file.path}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {task.checklists && task.checklists.length > 0 && (
              <div className="mt-2 text-xs">
                <span className="font-medium text-muted-foreground">Checklists: </span>
                <ul className="mt-1 grid gap-1">
                  {task.checklists.map((item, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <span className={cn("size-2 rounded-full", item.completed ? "bg-emerald-500" : "border border-muted-foreground/50")} />
                      <span className={cn(item.completed && "line-through opacity-70")}>{item.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Real times only: created/started/finished come from the
                task's recorded timestamps, steps keep a time only when one
                was stored as a timestamp. */}
            {timeline.length > 0 && (
              <ol className="mt-2 grid list-none gap-1.5 text-[12.5px] leading-[19px]">
                {timeline.map((entry, index) => (
                  <li key={index} className="relative flex items-start justify-between gap-2.5 ps-4">
                    {/* Rail runs bullet-center to bullet-center and stops at the last dot. */}
                    {index < timeline.length - 1 && (
                      <span aria-hidden="true" className="absolute start-[1.5px] top-[9.5px] bottom-[-15.5px] w-px bg-border" />
                    )}
                    <span aria-hidden="true" className={cn("absolute start-0 top-[7.5px] size-1 rounded-full", index === timeline.length - 1 ? "bg-foreground" : "bg-muted-foreground/50")} />
                    <span className="min-w-0 text-muted-foreground">{entry.text}</span>
                    {entry.at && (
                      <time dateTime={entry.at} title={formatDateTime(entry.at)} className="shrink-0 tabular-nums text-muted-foreground/70">
                        {formatClock(entry.at, new Date(clock))}
                      </time>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function AgentBoardColumn({
  id,
  label,
  tasks,
  openIds,
  justMovedId,
  onToggle,
}: {
  id: AgentColumnId;
  label: string;
  tasks: AgentTask[];
  openIds: readonly string[];
  justMovedId?: string | null;
  onToggle: (id: string) => void;
}) {
  const laneColor: Record<AgentColumnId, string> = {
    todo: "bg-muted-foreground/50",
    running: "bg-[var(--agent-running)]",
    done: "bg-[var(--agent-done)]",
  };

  return (
    <section aria-labelledby={`agent-column-${id}`} data-agent-column={id} className="min-w-0 rounded-[14px] bg-muted/50 p-1">
      <header className="flex h-[26px] items-center gap-2 pl-2.5 pr-2">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", laneColor[id])} />
        <h2 id={`agent-column-${id}`} className="flex-1 text-[11px] font-medium text-muted-foreground">{label}</h2>
        <span className="rounded-md bg-foreground/[0.06] px-[5px] text-[11px] leading-[17px] tabular-nums text-muted-foreground" aria-label={`${label}: ${tasks.length} tasks`}>{tasks.length}</span>
      </header>
      <ul className="grid min-w-0 grid-cols-1 list-none gap-1.5">
        {tasks.map(task => (
          <AgentTaskCard key={task.id} task={task} open={openIds.includes(task.id)} justMoved={justMovedId === task.id} onToggle={onToggle} />
        ))}
        {!tasks.length && <li className="px-3 py-8 text-center text-xs text-muted-foreground">No tasks here</li>}
      </ul>
    </section>
  );
}

export function AgentBoard({
  tasks,
  openIds,
  justMovedId,
  onToggle,
}: {
  tasks: AgentTask[];
  openIds: readonly string[];
  justMovedId?: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div aria-label="Agent task board" className="grid min-w-0 grid-cols-1 items-start gap-2 lg:grid-cols-3">
      {agentColumns.map(column => (
        <AgentBoardColumn
          key={column.id}
          {...column}
          tasks={tasks.filter(task => agentTaskColumn(task.state) === column.id)}
          openIds={openIds}
          justMovedId={justMovedId}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
