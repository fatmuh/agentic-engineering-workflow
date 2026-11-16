import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Sign in — Onyx",
};

/**
 * This page reads searchParams (the `next` redirect target), so it cannot
 * produce an instant static shell — same as /oauth/authorize (Next 16 Cache
 * Components validation).
 */
export const instant = false;

/**
 * After signing in, return the user where they were heading (e.g. the OAuth
 * consent page at /oauth/authorize, or a protected page the proxy bounced them
 * from). Only same-app paths are honored — a bare relative path or an absolute
 * URL would be an open redirect.
 */
function safeNext(raw: string | undefined): string | undefined {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : undefined;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <AuthShell>
      <LoginForm redirectTo={safeNext(next) ?? "/"} />
    </AuthShell>
  );
}
