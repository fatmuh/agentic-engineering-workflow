import { describe, expect, it } from "vitest";
import { agentTaskColumn, bmadTaskToAgentTask, formatClock, formatRunTime, runMillis, stageState } from "./agent-board-data";

const base = { id: "f-01", title: "T", description: "", assignedAgent: "sims-implement" };

describe("board lanes", () => {
  it("places tasks by stage, with no approval lane", () => {
    expect(stageState("backlog")).toBe("backlog");
    expect(stageState("ready_for_review")).toBe("todo");
    expect(stageState("in_progress")).toBe("running");
    expect(stageState("analysis")).toBe("running");
    expect(stageState("completed")).toBe("done");
    expect(stageState("rejected")).toBe("wontdo");
    expect(stageState("something-new")).toBe("todo");
    expect(["backlog", "todo"].map(s => agentTaskColumn(s as never))).toEqual(["todo", "todo"]);
    expect(agentTaskColumn("running")).toBe("running");
    expect(["done", "wontdo"].map(s => agentTaskColumn(s as never))).toEqual(["done", "done"]);
  });

  // A pending approval used to put a ready task in "Needs You".
  it("ignores the approval status", () => {
    const task = bmadTaskToAgentTask({ ...base, stage: "ready_for_review", approvalStatus: "pending" } as never);
    expect(task.state).toBe("todo");
  });

  it("carries run times and tokens, defaulting to none", () => {
    const task = bmadTaskToAgentTask({ ...base, stage: "ready_for_review" });
    expect(task.startedAt).toBeNull();
    expect(task.tokens.totalTokens).toBe(0);
  });
});

describe("run time", () => {
  const started = "2026-11-17T07:00:00.000Z";
  const now = Date.parse("2026-11-17T07:12:03.000Z");

  it("counts a running task from its real start, not from page load", () => {
    expect(runMillis({ state: "running", startedAt: started, completedAt: null }, now)).toBe(723_000);
  });

  it("ends a finished task at its finish time", () => {
    const done = { state: "done" as const, startedAt: started, completedAt: "2026-11-17T07:05:00.000Z" };
    expect(runMillis(done, now)).toBe(300_000);
    expect(runMillis({ ...done, startedAt: null }, now)).toBeNull();
  });

  it("formats seconds, minutes and hours", () => {
    expect(formatRunTime(45_000)).toBe("45s");
    expect(formatRunTime(723_000)).toBe("12m 03s");
    expect(formatRunTime(7_500_000)).toBe("2h 05m");
  });

  it("shows the date only when the time is not today", () => {
    const today = new Date("2026-11-17T09:00:00");
    expect(formatClock("2026-11-17T08:05:00", today, "en-GB")).toBe("08:05");
    expect(formatClock("2026-11-16T23:40:00", today, "en-GB")).toBe("16 Nov, 23:40");
  });
});

describe("timeline", () => {
  const base = { state: "done" as const, startedAt: null, completedAt: null, createdAt: null };

  // "now" was stored when the task was created and read as current forever.
  it("drops frozen relative times and the old placeholder step", async () => {
    const { taskTimeline } = await import("./agent-board-data");
    const entries = taskTimeline({
      ...base,
      createdAt: "2026-11-17T07:04:15.000Z",
      completedAt: "2026-11-17T07:12:01.000Z",
      steps: [
        { text: "Task created by BMad agent", time: "now" },
        { text: "Reading the spec", time: "5m ago" },
      ],
    });
    expect(entries).toEqual([
      { text: "Created", at: "2026-11-17T07:04:15.000Z" },
      { text: "Reading the spec", at: null },
      { text: "Finished", at: "2026-11-17T07:12:01.000Z" },
    ]);
  });

  it("orders real step times between start and finish", async () => {
    const { taskTimeline } = await import("./agent-board-data");
    const entries = taskTimeline({
      ...base,
      createdAt: "2026-11-17T07:00:00.000Z",
      startedAt: "2026-11-17T07:01:00.000Z",
      completedAt: "2026-11-17T07:09:00.000Z",
      steps: [{ text: "Promoted from backlog BKL-1", time: "2026-11-17T07:00:30.000Z" }],
    });
    expect(entries.map(e => e.text)).toEqual(["Created", "Promoted from backlog BKL-1", "Started", "Finished"]);
  });
});
