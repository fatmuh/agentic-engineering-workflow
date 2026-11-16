/**
 * Server-startup hook (Next.js instrumentation convention).
 *
 * The demo board (`prj_default`) is seeded here — once per server process, and
 * only if that project is still empty. It deliberately lives outside every read
 * path: listing projects or reading a new project's board must never write, and
 * must never plant demo tasks in a project that is not `prj_default`.
 *
 * `register` runs in both the Node.js and Edge runtimes; the seed needs `pg`,
 * so only the Node.js runtime imports it. That guard works because Turbopack
 * inlines `process.env.NEXT_RUNTIME`, so the dynamic import is compiled out of
 * the edge bundle rather than merely skipped at runtime — if that inlining ever
 * stops, this check degrades to a runtime no-op and `pg` would follow the
 * import into edge. The built edge chunk carries no `pg` reference today.
 *
 * Booting does NOT wait on the seed: `register()` returns immediately and the
 * seeding continues in the background. Next awaits `register()` before the
 * server is ready, so awaiting here would put a cold database (10s connect
 * timeout plus the v2–v7 bootstrap) on the readiness path for every request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Framework already skips `register` during `next build`; kept explicit so the
  // build-time behaviour is visible here rather than implied by Next internals.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  void seedInBackground();
}

/**
 * Seed the demo board without blocking startup.
 *
 * Two failure modes to survive:
 *   - The database is unreachable or slow at boot. The read APIs stay correct
 *     without demo data, so this logs and returns; a restart retries.
 *   - The process died between the task insert and the node insert, leaving
 *     `prj_default` with tasks and no tree. The plain probe would then see rows
 *     and skip forever, so the node half is re-run unconditionally after it.
 */
async function seedInBackground(): Promise<void> {
  try {
    const { seedDefaultProjectData } = await import("./lib/bmad");
    await seedDefaultProjectData();
    // Repairs a seed that stopped between its two inserts. Cheap when there is
    // nothing to do: one count query plus the existing ON CONFLICT DO NOTHING.
    await seedDefaultProjectData("present");
  } catch (error) {
    console.warn(
      "[bmad] demo seed skipped at startup:",
      error instanceof Error ? error.message : error
    );
  }
}
