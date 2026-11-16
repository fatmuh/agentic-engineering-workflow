import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { getSessionUser } from "@/lib/auth";
import {
  buildAuthorizeUrl,
  consentCsrf,
  parseAuthorizeParams,
} from "@/lib/oauth";

export const metadata: Metadata = {
  title: "Otorisasi MCP — Onyx",
};

/**
 * This page is deliberately blocking: it reads searchParams + the session
 * cookie and may redirect to /login before any shell renders, so it cannot
 * produce an instant static shell (Next 16 Cache Components validation).
 */
export const instant = false;

/** First value of a search param (the CLI never repeats keys). */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function NoticeCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <AuthShell>
      <div className="space-y-3">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <div className="text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          {children}
        </div>
      </div>
    </AuthShell>
  );
}

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parsed = parseAuthorizeParams({
    response_type: single(sp.response_type),
    client_id: single(sp.client_id),
    redirect_uri: single(sp.redirect_uri),
    state: single(sp.state),
    code_challenge: single(sp.code_challenge),
    code_challenge_method: single(sp.code_challenge_method),
  });

  if (!parsed.ok) {
    return (
      <NoticeCard title="Permintaan Otorisasi Tidak Valid">
        <p>
          {parsed.errorDescription} (<code className="text-xs">{parsed.error}</code>).
        </p>
        <p>Jalankan ulang login dari BMad Monitor untuk meminta URL otorisasi yang baru.</p>
      </NoticeCard>
    );
  }

  const params = parsed.params;
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(buildAuthorizeUrl(params))}`);
  }

  if (user.status !== "Active") {
    return (
      <NoticeCard title="Belum Ada Izin">
        <p>
          Akun Anda belum memiliki izin / allowance untuk mengakses BMad Workspace
          ini. Hubungi admin tim.
        </p>
      </NoticeCard>
    );
  }

  const csrf = consentCsrf(user.id, params.redirectUri, params.state);
  const hidden = {
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    client_id: params.clientId,
    csrf,
  };
  const hiddenInputs = Object.entries(hidden).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));

  return (
    <AuthShell>
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-widest text-neutral-400 dark:text-neutral-500">
            Otorisasi Aplikasi
          </p>
          <h1 className="text-lg font-semibold tracking-tight">BMad Monitor MCP</h1>
        </div>

        <p className="text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          Aplikasi <span className="font-medium text-neutral-900 dark:text-neutral-100">bmad-mcp-cli</span>{" "}
          di perangkat ini meminta akses ke akun{" "}
          <span className="font-medium text-neutral-900 dark:text-neutral-100">{user.email}</span>.
        </p>

        <ul className="space-y-1.5 rounded-lg border border-neutral-200/80 bg-neutral-50/60 p-3 text-[12.5px] leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400">
          <li>· Melaporkan progres agent dan pohon agent ke dashboard</li>
          <li>· Membuat project serta tiket Kanban atas nama Anda</li>
          <li>· Membaca vault provider LLM tim dan pribadi</li>
          <li>· Menunggu persetujuan task yang Anda review di web</li>
        </ul>

        <form action="/api/oauth/authorize" method="POST" className="space-y-2.5">
          <input type="hidden" name="decision" value="authorize" />
          {hiddenInputs}
          <button
            type="submit"
            className="mt-1 flex h-[36px] w-full items-center justify-center rounded-lg bg-neutral-900 text-[13px] font-medium text-white transition-colors hover:bg-neutral-800 active:bg-neutral-950 cursor-pointer shadow-2xs dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
          >
            Authorize
          </button>
        </form>
        <form action="/api/oauth/authorize" method="POST">
          <input type="hidden" name="decision" value="deny" />
          {hiddenInputs}
          <button
            type="submit"
            className="flex h-[36px] w-full items-center justify-center rounded-lg border border-neutral-200 text-[13px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 active:bg-neutral-100 cursor-pointer dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Tolak
          </button>
        </form>

        <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500">
          Menolak mengembalikan Anda ke terminal tanpa memberikan akses.
        </p>
      </div>
    </AuthShell>
  );
}
