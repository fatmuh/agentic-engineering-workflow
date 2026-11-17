import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
  // Dev via static Cloudflare tunnel or Tailscale
  // (Tailscale MagicDNS hosts are machine.<tailnet>.ts.net — two labels, so
  // only `**.ts.net` matches them; `*.ts.net` covers exactly one label.)
  allowedDevOrigins: [
    "*.mocci.web.id",
    "**.mocci.web.id",
    "127.0.0.1",
    "localhost",
    "vesper.tailf6c5fc.ts.net",
    "*.tail6bb223.ts.net",
    "**.ts.net",
  ],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default function config(phase: string): NextConfig {
  return {
    ...nextConfig,
    // The Docker image runs the self-contained server from .next/standalone.
    // Only the Dockerfile sets this, so `next start` and the test harnesses
    // keep using the regular build.
    ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
    // Keep production builds from changing the running dev server's artifacts.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
  };
}
