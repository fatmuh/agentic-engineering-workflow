import { afterAll, beforeAll, expect, test } from "vitest";
import { api, closeDbPool, FIXTURE_EMAILS, FIXTURE_PASSWORD, getPool, login, seedFixtureUsers } from "./helpers";

/**
 * Task telemetry for the board (schema v11 + task list): when a task ran and
 * how many tokens it took. Everything goes through the booted app's HTTP API
 * the MCP client uses (batch upsert, PATCH, agent-tree step, task list).
 */

const FIXTURE_NAME_PREFIX = "Matrix Task Telemetry";
let cookie: string;

interface TaskBody {
  id: string;
  stage: string;
  startedAt: string | null;
  completedAt: string | null;
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

async function newProject(label: string): Promise<string> {
  const res = await api("/api/projects", { method: "POST", cookie, body: { name: `${FIXTURE_NAME_PREFIX} ${label} ${Date.now()}` } });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function upsert(projectId: string, id: string, stage: string) {
  const res = await api(`/api/projects/${projectId}/tasks/batch`, {
    method: "POST", cookie, body: [{ id, title: id, description: "", stage, assignedAgent: "sims-implement" }],
  });
  expect(res.status).toBe(201);
}

async function task(projectId: string, id: string): Promise<TaskBody> {
  const res = await api(`/api/projects/${projectId}/tasks`, { cookie });
  expect(res.status).toBe(200);
  const found = (res.body as TaskBody[]).find(t => t.id === id);
  expect(found).toBeDefined();
  return found!;
}

beforeAll(async () => {
  await seedFixtureUsers();
  cookie = await login(FIXTURE_EMAILS.admin, FIXTURE_PASSWORD);
});

afterAll(async () => {
  try {
    await getPool().query(`DELETE FROM bmad_projects WHERE name LIKE $1`, [`${FIXTURE_NAME_PREFIX}%`]);
  } finally {
    await closeDbPool();
  }
});

test("a task's start and finish are recorded as its stage moves, whichever endpoint moves it", async () => {
  const projectId = await newProject("times");

  await upsert(projectId, "f-01", "ready_for_review");
  let t = await task(projectId, "f-01");
  expect(t.startedAt).toBeNull();
  expect(t.completedAt).toBeNull();

  await upsert(projectId, "f-01", "in_progress");
  t = await task(projectId, "f-01");
  expect(t.startedAt).not.toBeNull();
  expect(t.completedAt).toBeNull();
  const started = t.startedAt;

  // Republishing while it runs keeps the original start.
  await upsert(projectId, "f-01", "in_progress");
  expect((await task(projectId, "f-01")).startedAt).toBe(started);

  const patched = await api(`/api/projects/${projectId}/tasks/f-01`, { method: "PATCH", cookie, body: { stage: "completed" } });
  expect(patched.status).toBe(200);
  t = await task(projectId, "f-01");
  expect(t.startedAt).toBe(started);
  expect(t.completedAt).not.toBeNull();
  expect(Date.parse(t.completedAt!)).toBeGreaterThanOrEqual(Date.parse(started!));
  const finished = t.completedAt;

  // Staying closed keeps the finish time; reopening clears it and restarts.
  await upsert(projectId, "f-01", "completed");
  expect((await task(projectId, "f-01")).completedAt).toBe(finished);
  await upsert(projectId, "f-01", "in_progress");
  t = await task(projectId, "f-01");
  expect(t.completedAt).toBeNull();
  expect(Date.parse(t.startedAt!)).toBeGreaterThanOrEqual(Date.parse(finished!));
});

test("a task's tokens are its linked nodes plus their descendants, not the rest of the session", async () => {
  const projectId = await newProject("tokens");
  await upsert(projectId, "f-01", "in_progress");
  await upsert(projectId, "f-02", "ready_for_review");

  const step = async (node: Record<string, unknown>) => {
    const res = await api(`/api/projects/${projectId}/agent-tree/step`, {
      method: "POST", cookie,
      body: { role: "developer", status: "running", action: "", durationMs: 0, modelUsed: { provider: "Anthropic", modelId: "m" }, artifacts: [], tools: [], ...node },
    });
    expect(res.status).toBeLessThan(300);
  };
  const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });

  // Session node (not linked): its tokens belong to no task.
  await step({ id: "cc-s1", name: "Claude Code s1", role: "orchestrator", tokenUsage: usage(1000, 100) });
  // The per-task node the hook opens, and a subagent under it.
  await step({ id: "cc-s1-task-f-01", parentId: "cc-s1", taskId: "f-01", name: "Task f-01", tokenUsage: usage(300, 30) });
  await step({ id: "cc-s1-ag1", parentId: "cc-s1-task-f-01", taskId: "f-01", name: "Subagent Explore", tokenUsage: usage(50, 5) });
  // A skill under the subagent, without its own task link.
  await step({ id: "cc-s1-ag1-skill-x", parentId: "cc-s1-ag1", name: "x", tokenUsage: usage(10, 1) });

  const t1 = await task(projectId, "f-01");
  expect(t1.tokenUsage).toMatchObject({ inputTokens: 360, outputTokens: 36, totalTokens: 396 });
  const t2 = await task(projectId, "f-02");
  expect(t2.tokenUsage.totalTokens).toBe(0);
});
