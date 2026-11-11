/**
 * Reseed the BMad demo project, tasks, and agent hierarchy.
 *
 * Usage:
 *   node scripts/seed-bmad.mjs           # Seed if empty
 *   node scripts/seed-bmad.mjs --reset   # Truncate and re-seed
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";

function loadEnvLocal(path = ".env.local") {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // Rely on process.env
  }
}

loadEnvLocal(new URL("../.env.local", import.meta.url).pathname);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Add it to .env.local");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const isReset = process.argv.includes("--reset");

async function main() {
  const client = await pool.connect();
  try {
    if (isReset) {
      console.log("Resetting BMad tables...");
      await client.query("DELETE FROM bmad_agent_nodes WHERE project_id = 'prj_default'");
      await client.query("DELETE FROM bmad_tasks WHERE project_id = 'prj_default'");
      await client.query("DELETE FROM bmad_projects WHERE id = 'prj_default'");
    }

    // 1. Ensure Project
    await client.query(
      `INSERT INTO bmad_projects (id, name, git_remote_url, workspace_path)
       VALUES ('prj_default', 'Agentic Engineering Workflow', 'https://github.com/fatmuh/agentic-engineering-workflow', '/home/ubuntu/agentic-engineering-workflow')
       ON CONFLICT (id) DO NOTHING`
    );

    // 2. Ensure Tasks
    const existingTasks = await client.query("SELECT count(*) FROM bmad_tasks WHERE project_id = 'prj_default'");
    if (parseInt(existingTasks.rows[0]?.count ?? "0", 10) === 0) {
      await client.query(
        `INSERT INTO bmad_tasks
          (id, project_id, title, description, stage, priority, approval_status, assigned_agent, steps, checklists, context_files, sources, tool_calls, duration)
         VALUES
          (
            'TASK-101',
            'prj_default',
            'Implementasi Autentikasi OAuth 2.0 PKCE & Whitelist',
            'Membuat handler otorisasi loopback dan endpoint validasi user allowance untuk CLI BMad Monitor.',
            'ready_for_review',
            'high',
            'pending',
            'bmad-architect',
            $1::jsonb, $2::jsonb, $3::jsonb, 8, 14, '5m 20s'
          ),
          (
            'TASK-102',
            'prj_default',
            'Analisis Dampak Kode (Code Impact Analysis) pada Auth System',
            'Identifikasi breaking changes dan deprecation modul basic auth lama.',
            'in_progress',
            'medium',
            'approved',
            'bmad-analyst',
            $4::jsonb, $5::jsonb, $6::jsonb, 12, 19, '3m 45s'
          ),
          (
            'TASK-103',
            'prj_default',
            'Setup Telemetri Token Usage pada AffectUI Agent Tree',
            'Mengganti metrik cost dolar dengan token breakdown (input, output, cache read/write).',
            'completed',
            'high',
            'approved',
            'bmad-dev',
            $7::jsonb, $8::jsonb, $9::jsonb, 23, 31, '12m 10s'
          )
         ON CONFLICT (id) DO NOTHING`,
        [
          JSON.stringify([
            { text: "Membaca spesifikasi WEB_SPECIFICATION.md", time: "5m lalu" },
            { text: "Membuat endpoint /oauth/authorize dan /api/oauth/token", time: "3m lalu" },
            { text: "Menunggu persetujuan reviewer di Web Dashboard", time: "sekarang" },
          ]),
          JSON.stringify([
            { title: "Verifikasi allowance check di web", completed: true },
            { title: "Callback loopback redirect uri", completed: true },
            { title: "Code challenge S256 validation", completed: false },
          ]),
          JSON.stringify([{ path: "docs/WEB_SPECIFICATION.md", description: "Spesifikasi Auth" }]),
          JSON.stringify([
            { text: "Scanning dependency graph codebase", time: "3m lalu" },
            { text: "Menemukan 2 file terdampak breaking change", time: "1m lalu" },
            { text: "Menyusun strategi migrasi backward compatibility", time: "sekarang" },
          ]),
          JSON.stringify([
            { title: "Scan internal/auth/legacy", completed: true },
            { title: "Drafting mitigation strategy", completed: false },
          ]),
          JSON.stringify([{ path: "src/lib/auth.ts" }]),
          JSON.stringify([
            { text: "Merestrukturisasi komponen WorktreeCard", time: "12m lalu" },
            { text: "Menghubungkan payload tokenUsage dari API", time: "8m lalu" },
            { text: "Verifikasi tampilan responsive dark/light mode", time: "2m lalu" },
          ]),
          JSON.stringify([
            { title: "Format token number display (k/M)", completed: true },
            { title: "Hover tooltip detail cache read/write", completed: true },
          ]),
          JSON.stringify([{ path: "src/components/dashboard/worktree-tree.tsx" }]),
        ]
      );
      console.log("Seeded 3 BMad tasks.");
    }

    // 3. Ensure Agent Tree Nodes
    const existingNodes = await client.query("SELECT count(*) FROM bmad_agent_nodes WHERE project_id = 'prj_default'");
    if (parseInt(existingNodes.rows[0]?.count ?? "0", 10) === 0) {
      await client.query(
        `INSERT INTO bmad_agent_nodes
          (id, project_id, task_id, parent_id, name, role, status, action, duration_ms, token_usage, model_used, artifacts, tools)
         VALUES
          (
            'node-root-orchestrator',
            'prj_default',
            'TASK-101',
            NULL,
            'BMad Master Orchestrator',
            'orchestrator',
            'running',
            'Mengkoordinasikan analisis arsitektur dan eksekusi task sprint',
            84000,
            $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb
          ),
          (
            'node-bmad-analyst-01',
            'prj_default',
            'TASK-102',
            'node-root-orchestrator',
            'BMad Analyst',
            'analyst',
            'running',
            'Menganalisis file context docs/PRD.md dan mengidentifikasi dependensi domain',
            42000,
            $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb
          ),
          (
            'node-bmad-architect-01',
            'prj_default',
            'TASK-101',
            'node-root-orchestrator',
            'BMad Architect',
            'architect',
            'waiting_approval',
            'Menyiapkan rancangan solusi arsitektur dan security gates',
            36000,
            $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb
          ),
          (
            'node-bmad-dev-01',
            'prj_default',
            'TASK-103',
            'node-bmad-architect-01',
            'BMad Developer',
            'developer',
            'completed',
            'Slicing komponen UI dan menyatukan telemetri token usage',
            28000,
            $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb
          ),
          (
            'node-bmad-qa-01',
            'prj_default',
            NULL,
            'node-bmad-architect-01',
            'BMad QA Engineer',
            'qa',
            'running',
            'Menjalankan skenario verifikasi e2e permission gate dan kanban stage',
            27000,
            $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb
          )
         ON CONFLICT (id) DO NOTHING`,
        [
          JSON.stringify({ inputTokens: 42100, outputTokens: 9800, cacheReadTokens: 18200, cacheWriteTokens: 3400, totalTokens: 73500 }),
          JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5-5", contextWindow: 200000 }),
          JSON.stringify(["sprint-plan.md", "architecture-rfc.md"]),
          JSON.stringify(["bash", "read_file", "search"]),
          JSON.stringify({ inputTokens: 18400, outputTokens: 4200, cacheReadTokens: 9100, cacheWriteTokens: 1200, totalTokens: 32900 }),
          JSON.stringify({ provider: "anthropic", model: "claude-haiku-5-5", contextWindow: 200000 }),
          JSON.stringify(["docs/PRD.md", "dependency-graph.json"]),
          JSON.stringify(["read_file", "grep"]),
          JSON.stringify({ inputTokens: 24500, outputTokens: 6100, cacheReadTokens: 12400, cacheWriteTokens: 2100, totalTokens: 45100 }),
          JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5-5", contextWindow: 200000 }),
          JSON.stringify(["security-matrix.md"]),
          JSON.stringify(["read_file", "write_file"]),
          JSON.stringify({ inputTokens: 12500, outputTokens: 5800, cacheReadTokens: 4200, cacheWriteTokens: 800, totalTokens: 23300 }),
          JSON.stringify({ provider: "anthropic", model: "claude-haiku-5-5", contextWindow: 200000 }),
          JSON.stringify(["src/components/dashboard/worktree-tree.tsx"]),
          JSON.stringify(["edit_file", "bash"]),
          JSON.stringify({ inputTokens: 14200, outputTokens: 3900, cacheReadTokens: 6100, cacheWriteTokens: 900, totalTokens: 25100 }),
          JSON.stringify({ provider: "anthropic", model: "claude-haiku-5-5", contextWindow: 200000 }),
          JSON.stringify(["e2e/permissions-matrix.spec.ts"]),
          JSON.stringify(["bash", "read_file"]),
        ]
      );
      console.log("Seeded 5 BMad agent tree nodes.");
    }
    console.log("BMad database seed successfully ensured!");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Failed to seed BMad database:", err);
  process.exit(1);
});
