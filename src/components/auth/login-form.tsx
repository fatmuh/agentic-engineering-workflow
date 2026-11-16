"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AuthField, authInputClass } from "./auth-field";
import { PasswordInput } from "./password-input";
import { SocialAuthButtons } from "./social-auth-buttons";
import { focusAuthField, validateAuthField, validateAuthForm, type AuthErrors } from "./validation";

export function LoginForm({ redirectTo = "/" }: { redirectTo?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<AuthErrors>({});
  const [formError, setFormError] = useState("");

  const updateField = (field: "email" | "password", value: string) => {
    if (field === "email") setEmail(value);
    else setPassword(value);
    setFormError("");
    // Revalidate only after submit has identified a problem, not while first typing.
    if (errors[field]) setErrors((current) => ({ ...current, [field]: validateAuthField(field, value) }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (loading) return;
    const form = e.currentTarget;
    const nextErrors = validateAuthForm({ email, password });
    setErrors(nextErrors);
    setFormError("");
    const firstInvalid = Object.keys(nextErrors)[0];
    if (firstInvalid) {
      focusAuthField(form, firstInvalid);
      return;
    }
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Invalid credentials concern the pair; do not blame a particular field.
        setFormError(data.error || "Failed to sign in. Please try again.");
        return;
      }
      toast.success("Signed in successfully");
      if (redirectTo && redirectTo !== "/") {
        // Full-page navigation for cross-flow targets (e.g. the OAuth consent
        // page): unlike router actions it works even when submitted before the
        // client router finishes initializing on a slow-loading dev bundle.
        window.location.assign(redirectTo);
      } else {
        router.push(redirectTo);
        router.refresh();
      }
    } catch {
      setFormError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleFillDemo = () => {
    setEmail("admin@onyx.dev");
    setPassword("password123");
    setErrors({});
    setFormError("");
    toast.info("Demo credentials filled");
  };

  return (
    <>
      {/* Header */}
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-neutral-900 text-white shadow-2xs dark:bg-white dark:text-neutral-900">
          <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
            <path d="M8 1.8a.9.9 0 0 1 .9.9v2.25l1.95-1.12a.9.9 0 0 1 .9 1.56l-1.95 1.12 1.95 1.13a.9.9 0 0 1-.9 1.56L8.9 7.2v2.25a.9.9 0 0 1-1.8 0V7.2l-1.95 1.13a.9.9 0 0 1-.9-1.56l1.95-1.13-1.95-1.12a.9.9 0 0 1 .9-1.56L7.1 4.95V2.7a.9.9 0 0 1 .9-.9z" />
          </svg>
        </div>
        <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-neutral-900 dark:text-neutral-100">
          Sign in to Onyx
        </h1>
        <p className="mt-1 text-[13px] text-neutral-500 dark:text-neutral-400">
          Welcome back. Enter your details to continue.
        </p>
      </div>

      {/* Social OAuth */}
      <div className="mt-6">
        <SocialAuthButtons />
      </div>

      {/* Divider */}
      <div className="relative my-5 flex items-center justify-center">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-neutral-200 dark:border-neutral-800" />
        </div>
        <span className="relative bg-white px-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400 dark:bg-[#121215] dark:text-neutral-500">
          or
        </span>
      </div>

      {/* Email / Password Form */}
      <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
        {/* Survives a no-JS GET fallback submit: the next target stays in the
            query string instead of being dropped (slow hydration on dev). */}
        <input type="hidden" name="next" value={redirectTo} />
        <p role="alert" className="empty:hidden text-xs text-red-700 dark:text-red-300">{formError}</p>
        <AuthField label="Email address" htmlFor="email" error={errors.email}>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => updateField("email", e.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "email-error" : undefined}
            spellCheck={false}
            placeholder="name@company.com"
            required
            className={authInputClass}
          />
        </AuthField>

        <AuthField
          label="Password"
          htmlFor="password"
          error={errors.password}
          action={
            <Link
              href="/forgot-password"
              className="text-[12px] text-neutral-500 transition-colors hover:text-neutral-900 dark:hover:text-neutral-200"
            >
              Forgot?
            </Link>
          }
        >
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => updateField("password", e.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "password-error" : undefined}
            placeholder="••••••••"
            required
          />
        </AuthField>

        <div className="flex items-center justify-between pt-0.5">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              name="remember"
              defaultChecked
              className="size-3.5 rounded border-neutral-300 accent-neutral-900 dark:border-neutral-700 dark:bg-[#16161a] dark:accent-white cursor-pointer"
            />
            <span className="text-[12px] text-neutral-500 dark:text-neutral-400">
              Remember me
            </span>
          </label>
        </div>

        <button
          type="submit"
          aria-disabled={loading}
          aria-busy={loading}
          className="mt-1 flex h-[36px] w-full items-center justify-center rounded-lg bg-neutral-900 text-[13px] font-medium text-white transition-colors hover:bg-neutral-800 active:bg-neutral-950 aria-disabled:opacity-60 aria-disabled:cursor-wait dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100 cursor-pointer shadow-2xs"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>

      {/* Register switch */}
      <p className="mt-5 text-center text-[12.5px] text-neutral-500 dark:text-neutral-400">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-medium text-neutral-900 hover:underline underline-offset-4 dark:text-neutral-100"
        >
          Sign up
        </Link>
      </p>

      {/* Demo Credentials Hint */}
      <div className="mt-5 border-t border-neutral-100 pt-3.5 text-center dark:border-neutral-800/80">
        <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500">
          Demo:{" "}
          <button
            type="button"
            onClick={handleFillDemo}
            className="font-medium text-neutral-700 underline underline-offset-2 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white cursor-pointer"
          >
            admin@onyx.dev
          </button>
          {" "}/ password123
        </p>
      </div>
    </>
  );
}
