#!/usr/bin/env node
/**
 * MCP contract verification — drives the REAL Go binary over stdio, against a
 * production build on a scratch database, for the tools that otherwise have
 * only API-level coverage.
 *
 * Why this exists separately from the matrix suite: the matrix specs drive the
 * endpoints with fetch(). The MCP client is a different consumer with its own
 * expectations (argument names, JSON-RPC framing, the sentences it prints), and
 * the backlog tools already shipped a bug class that only the binary could
 * reveal — routes that did not exist yet, so every call 404'd on first use.
 *
 * What it checks, end to end through the binary:
 *   awm_project_init → awm_context_report → awm_agent_progress →
 *   awm_task_create_batch → awm_task_update → awm_task_wait_approval →
 *   awm_project_list
 * with the database asserted after each write.
 *
 * Three properties that keep it useful rather than decorative:
 *   1. It REFUSES to run when it cannot actually test anything — no binary, no
 *      built app, or an already-serving port is an explicit failure, not a
 *      silent skip (a check that quietly passes proves nothing).
 *   2. It cleans up after itself on every path, including failure, and on
 *      SIGINT/SIGTERM.
 *   3. It never touches the dev database: it creates and drops its own scratch
 *      database, and gives the binary an isolated HOME.
 *
 * Usage:
 *   npm run test:mcp -- --binary /path/to/bmad-monitor
 *   MCP_BINARY=/path/to/bmad-monitor npm run test:mcp
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { SignJWT } from "jose";
import {
  loadTestEnv,
  baseConnectionString,
  deriveScratchDbName,
  scratchConnectionString,
  createScratchDb,
  dropScratchDb,
} from "./test-db.mjs";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.MCP_VERIFY_PORT || 4337);
const BASE = `http://127.0.0.1:${PORT}`;

function parseArgs(argv) {
  const out = { binary: process.env.MCP_BINARY || "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--binary" && argv[i + 1]) out.binary = argv[++i];
  }
  return out;
}

const { binary } = parseArgs(process.argv.slice(2));

/** A check that cannot run is a failure, never a skip. */
function refuse(message) {
  console.error(`[mcp-verify] CANNOT VERIFY: ${message}`);
  process.exit(2);
}

if (!binary) {
  refuse(
    "no MCP binary given. Pass --binary /path/to/bmad-monitor (or MCP_BINARY). " +
      "Build it from the bmad-monitor-mcp repo: go build -o /tmp/bmad-monitor ./cmd/bmad-monitor",
  );
}
if (!existsSync(binary)) refuse(`binary not found at ${binary}`);
if (!existsSync(resolve(REPO, ".next/BUILD_ID"))) {
  refuse("no production build (.next/BUILD_ID). Run `npm run build` first.");
}

let failures = 0;
function check(ok, label, detail = "") {
  if (ok) {
    console.log(`[mcp-verify] ok   ${label}`);
  } else {
    failures += 1;
    console.error(`[mcp-verify] FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

loadTestEnv();
if (!process.env.AUTH_SECRET) refuse("AUTH_SECRET is not set (needed to mint the MCP token)");

const base = baseConnectionString();
const scratchName = deriveScratchDbName();
const scratchUrl = scratchConnectionString(base, scratchName);

let server;
let cli;
let home;
let workdir;
let pool;

async function stopServer() {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function cleanup() {
  if (home) rmSync(home, { recursive: true, force: true });
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (cli) {
    try {
      cli.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await stopServer();
  await pool?.end().catch(() => {});
  await sleep(800);
  await dropScratchDb({ name: scratchName, base, quiet: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

// Refuse to talk to a stranger: a server already on this port would be served
// from a different database and every assertion below would be meaningless.
try {
  await fetch(BASE, { signal: AbortSignal.timeout(1500) });
  refuse(`port ${PORT} is already serving — kill the orphan first (or set MCP_VERIFY_PORT)`);
} catch (error) {
  if (error.message?.includes("already serving")) throw error;
  // Connection refused / timeout — the port is free, which is what we want.
}

try {
await createScratchDb({ name: scratchName, base });
pool = new pg.Pool({ connectionString: scratchUrl, max: 2 });
pool.on("error", () => {});

server = spawn(process.execPath, [resolve(REPO, "scripts", "e2e-server.mjs")], {
  cwd: REPO,
  env: {
    ...process.env,
    E2E_SCRATCH_DB_NAME: scratchName,
    DATABASE_URL: scratchUrl,
    E2E_BASE_DATABASE_URL: base,
    E2E_PORT: String(PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
server.stderr.on("data", (chunk) => {
  const line = chunk.toString().trim();
  if (line && !line.startsWith("[matrix-boot]")) console.error(`[mcp-verify:boot] ${line}`);
});

const isReady = async () => {
  try {
    const page = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(2000) });
    if (!page.ok) return false;
    const probe = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mcp-verify-probe@example.test", password: "probe" }),
      signal: AbortSignal.timeout(8000),
    });
    return probe.status === 401;
  } catch {
    return false;
  }
};
for (let i = 0; i < 480 && !(await isReady()); i++) await sleep(250);
if (!(await isReady())) throw new Error("app never became ready (see the boot log above)");

const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
const token = await new SignJWT({ email: "mcp-verify@example.test", role: "Admin", type: "access" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("mcp-verify-subject")
  .setAudience("bmad-mcp")
  .setIssuer("onyx-auth")
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(secret);

// A real git repo, so awm_project_init derives an identity from a remote
// instead of falling back to a path key.
workdir = `/tmp/mcp-verify-repo-${Date.now()}`;
mkdirSync(workdir, { recursive: true });
const runGit = (args) =>
  new Promise((resolveRun) => {
    const child = spawn("git", args, { cwd: workdir, stdio: "ignore" });
    child.on("exit", resolveRun);
    child.on("error", resolveRun);
  });
await runGit(["init", "-q"]);
await runGit(["remote", "add", "origin", "https://github.com/example/mcp-verify.git"]);

home = `/tmp/mcp-verify-home-${Date.now()}`;
mkdirSync(`${home}/.bmad-monitor`, { recursive: true });
writeFileSync(
  `${home}/.bmad-monitor/config.json`,
  JSON.stringify({
    defaultServerUrl: BASE,
    credentials: {
      accessToken: token,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: { id: "mcp-verify-subject", email: "mcp-verify@example.test", name: "MCP Verify", role: "admin", isAllowed: true },
      serverUrl: BASE,
    },
  }),
);

cli = spawn(binary, ["--bridge=false"], {
  cwd: workdir,
  env: { HOME: home, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  stdio: ["pipe", "pipe", "pipe"],
});
cli.stderr.on("data", () => {});

const pending = new Map();
let nextId = 1;
let buffer = "";
const timeoutHandle = setTimeout(() => {
  console.error("[mcp-verify] FAIL the binary stopped responding on stdio");
  failures += 1;
  void cleanup().finally(() => process.exit(1));
}, 120_000);

cli.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message.id != null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    } catch {
      // Non-JSON noise on stdout is itself a protocol bug worth seeing.
      console.error(`[mcp-verify:stdout] ${line.slice(0, 200)}`);
    }
  }
});

const call = (method, params) =>
  new Promise((resolveCall) => {
    const id = nextId++;
    pending.set(id, resolveCall);
    cli.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const notify = (method) => cli.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

const tool = async (name, args) => {
  const response = await call("tools/call", { name, arguments: args });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  const text = (response.result.content ?? []).map((part) => part.text).join("\n");
  if (response.result.isError) throw new Error(`${name} returned isError: ${text}`);
  return text;
};

notify("notifications/initialized");
const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-verify", version: "1" },
});
if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
check(Boolean(init.result?.serverInfo?.name), "initialize succeeds", JSON.stringify(init.result?.serverInfo));

// 1. Project identity derived from the repo's own remote.
const initOut = await tool("awm_project_init", {});
const projectId = initOut.match(/ID Project: (\S+)/)?.[1];
check(Boolean(projectId), "awm_project_init returns a project id", initOut.split("\n")[0]);
if (!projectId) throw new Error("no project id — the rest of the run would be meaningless");

// 2. Context files land in the table the board reads.
await tool("awm_context_report", {
  projectId,
  files: [{ path: "docs/PRD.md", description: "PRD", fileSizeBytes: 1024 }],
});
const contextRows = await pool.query(
  `SELECT count(*)::int AS n FROM bmad_context_files WHERE project_id = $1`,
  [projectId],
);
check(contextRows.rows[0].n >= 1, "awm_context_report persists context files", JSON.stringify(contextRows.rows[0]));

// 3. Agent progress creates the node the Worktree tab renders.
await tool("awm_agent_progress", {
  projectId,
  nodeId: "mcp-verify-analyst",
  name: "BMad Analyst",
  role: "analyst",
  status: "running",
  action: "Menganalisis requirement",
});
const nodeRows = await pool.query(
  `SELECT name, status FROM bmad_agent_nodes WHERE project_id = $1 AND id = 'mcp-verify-analyst'`,
  [projectId],
);
check(
  nodeRows.rows.length === 1 && nodeRows.rows[0].status === "running",
  "awm_agent_progress creates the agent-tree node",
  JSON.stringify(nodeRows.rows[0]),
);

// 4. Batch task create.
await tool("awm_task_create_batch", {
  projectId,
  tasks: [
    { id: "TASK-MCP-VERIFY", title: "Verifikasi tool MCP", description: "Dibuat lewat stdio", stage: "ready_for_review", priority: "high" },
  ],
});
const createdRows = await pool.query(
  `SELECT stage, title FROM bmad_tasks WHERE project_id = $1 AND id = 'TASK-MCP-VERIFY'`,
  [projectId],
);
check(
  createdRows.rows.length === 1 && createdRows.rows[0].stage === "ready_for_review",
  "awm_task_create_batch creates the task",
  JSON.stringify(createdRows.rows[0]),
);

// 5. Stage update.
await tool("awm_task_update", { projectId, taskId: "TASK-MCP-VERIFY", stage: "in_progress" });
const updatedRows = await pool.query(
  `SELECT stage FROM bmad_tasks WHERE project_id = $1 AND id = 'TASK-MCP-VERIFY'`,
  [projectId],
);
check(
  updatedRows.rows[0]?.stage === "in_progress",
  "awm_task_update moves the stage",
  JSON.stringify(updatedRows.rows[0]),
);

// 6. A human approves through the dashboard's own endpoint — the click the
//    tool is supposed to observe — then the binary must see it.
const approval = await fetch(`${BASE}/api/projects/${projectId}/tasks/TASK-MCP-VERIFY`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ approvalStatus: "approved" }),
});
check(approval.ok, "the dashboard approves over HTTP", `HTTP ${approval.status}`);

const waitOut = await tool("awm_task_wait_approval", {
  projectId,
  taskId: "TASK-MCP-VERIFY",
  timeoutSeconds: 5,
});
// The tool answers in Indonesian ("telah di-APPROVE oleh reviewer").
check(/di-approve/i.test(waitOut), "awm_task_wait_approval reports the approval", waitOut.split("\n")[0]);

// 7. The registry lists it.
const listOut = await tool("awm_project_list", {});
check(listOut.includes(projectId), "awm_project_list includes the project", `${listOut.split("\n").length} lines`);

clearTimeout(timeoutHandle);
console.log(
  failures === 0
    ? "[mcp-verify] ALL CHECKS PASSED"
    : `[mcp-verify] ${failures} CHECK(S) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  failures += 1;
  console.error(`[mcp-verify] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
