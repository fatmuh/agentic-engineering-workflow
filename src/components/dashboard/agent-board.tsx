"use client";

import { useEffect, useState, type ComponentType } from "react";
import { AlertCircle, AlertTriangle, Check, ChevronDown, Loader2, Search, Sparkles, Wrench } from "@/components/icons";
import { Button } from "@/components/ui/button-clean";
import { cn } from "@/lib/utils";
import {
  agentColumns,
  agentTaskColumn,
  parseDurationToSeconds,
  formatSecondsToDuration,
  type AgentColumnId,
  type AgentTask,
  type AgentTaskState,
} from "./agent-board-data";

const stateIcons: Record<AgentTaskState, ComponentType<{ className?: string }>> = {
  waiting: AlertTriangle,
  failed: AlertCircle,
  running: Loader2,
  done: Check,
};

/* State color lives on the icon only; the word and time stay muted (Affect UI behavior). */
const stateColor: Record<AgentTaskState, string> = {
  waiting: "text-[var(--agent-waiting)]",
  failed: "text-[var(--agent-failed)]",
  running: "text-[var(--agent-running)]",
  done: "text-[var(--agent-done)]",
};

export function AgentTaskStatus({ state, duration }: { state: AgentTaskState; duration: string }) {
  const Icon = stateIcons[state];
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (state !== "running") return;
    const interval = setInterval(() => {
      setElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [state]);

  const baseSeconds = parseDurationToSeconds(duration);
  const displayDuration = state === "running" ? formatSecondsToDuration(baseSeconds + elapsed) : duration;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] tabular-nums text-muted-foreground">
      <Icon className={cn("size-3 shrink-0", stateColor[state], state === "running" && "motion-safe:animate-spin")} />
      {state === "waiting" && <span>Waiting for you ·&nbsp;</span>}
      {state === "failed" && <span>Failed ·&nbsp;</span>}
      <time>{displayDuration}</time>
    </span>
  );
}

function AgentTaskMeta({ task }: { task: AgentTask }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground/80">
      <span className="flex items-center gap-1" title={`Sources read: ${task.sources}`}>
        <Search className="size-3" />{task.sources}
      </span>
      <span className="flex items-center gap-1" title={`Tool calls: ${task.toolCalls}`}>
        <Wrench className="size-3" />{task.toolCalls}
      </span>
    </span>
  );
}

export function AgentTaskCard({
  task,
  open,
  justMoved,
  onToggle,
  onApprove,
  onReject,
}: {
  task: AgentTask;
  open: boolean;
  justMoved?: boolean;
  onToggle: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const foldId = `agent-fold-${task.id}`;
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
          <AgentTaskStatus state={task.state} duration={task.duration} />
          <span className="flex shrink-0 items-center gap-3">
            <AgentTaskMeta task={task} />
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
            <p className="text-xs text-muted-foreground/80">{task.agent}</p>

            {task.rejectionReason && (
              <div className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                <span className="font-semibold">Catatan Penolakan: </span>
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

            <ol className="mt-2 grid list-none gap-1.5 text-[12.5px] leading-[19px]">
              {task.steps.map((step, index) => (
                <li key={index} className="relative flex items-start justify-between gap-2.5 ps-4">
                  {/* Rail runs bullet-center to bullet-center and stops at the last dot. */}
                  {index < task.steps.length - 1 && (
                    <span aria-hidden="true" className="absolute start-[1.5px] top-[9.5px] bottom-[-15.5px] w-px bg-border" />
                  )}
                  <span aria-hidden="true" className={cn("absolute start-0 top-[7.5px] size-1 rounded-full", index === task.steps.length - 1 ? "bg-foreground" : "bg-muted-foreground/50")} />
                  <span className="min-w-0 text-muted-foreground">{step.text}</span>
                  <time className="shrink-0 text-muted-foreground/70">{step.time}</time>
                </li>
              ))}
            </ol>
            {(task.state === "waiting" || task.state === "failed") && (
              <div className="mt-2.5 flex gap-1.5">
                {task.state === "waiting" && (
                  <Button variant="secondary" size="sm" onClick={() => onReject(task.id)}>
                    Reject
                  </Button>
                )}
                <Button variant="primary" size="sm" onClick={() => onApprove(task.id)}>
                  {task.state === "failed" ? "Retry" : "Approve"}
                </Button>
              </div>
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
  onApprove,
  onReject,
}: {
  id: AgentColumnId;
  label: string;
  tasks: AgentTask[];
  openIds: readonly string[];
  justMovedId?: string | null;
  onToggle: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const laneColor: Record<AgentColumnId, string> = {
    "needs-you": "text-[var(--agent-waiting)]",
    running: "text-[var(--agent-running)]",
    done: "text-[var(--agent-done)]",
  };

  return (
    <section aria-labelledby={`agent-column-${id}`} data-agent-column={id} className="min-w-0 rounded-[14px] bg-muted/50 p-1">
      <header className="flex h-[26px] items-center gap-2 pl-2.5 pr-2">
        <Sparkles className={cn("size-3 shrink-0", laneColor[id])} />
        <h2 id={`agent-column-${id}`} className="flex-1 text-[11px] font-medium text-muted-foreground">{label}</h2>
        <span className="rounded-md bg-foreground/[0.06] px-[5px] text-[11px] leading-[17px] tabular-nums text-muted-foreground" aria-label={`${label}: ${tasks.length} tasks`}>{tasks.length}</span>
      </header>
      <ul className="grid min-w-0 grid-cols-1 list-none gap-1.5">
        {tasks.map(task => (
          <AgentTaskCard key={task.id} task={task} open={openIds.includes(task.id)} justMoved={justMovedId === task.id} onToggle={onToggle} onApprove={onApprove} onReject={onReject} />
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
  onApprove,
  onReject,
}: {
  tasks: AgentTask[];
  openIds: readonly string[];
  justMovedId?: string | null;
  onToggle: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
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
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </div>
  );
}
