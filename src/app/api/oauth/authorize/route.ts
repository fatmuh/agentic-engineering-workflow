import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  insertAuthCode,
  isSafeRedirectUri,
  parseAuthorizeParams,
  verifyConsentCsrf,
} from "@/lib/oauth";

/**
 * Consent decision endpoint (form target of /oauth/authorize). Not part of the
 * CLI contract — the CLI only ever GETs the page; this exists so the browser
 * submits the Authorize/Tolak choice and lands on the loopback callback via a
 * plain 302 the CLI's listener receives.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const get = (name: string): string | undefined => {
    const value = form?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  // Never redirect to an unvalidated redirect_uri — that would be an open
  // redirect; answer in-page instead.
  const redirectUri = get("redirect_uri") ?? "";
  if (!isSafeRedirectUri(redirectUri)) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "redirect_uri tidak valid" },
      { status: 400 }
    );
  }

  const parsed = parseAuthorizeParams({
    response_type: "code", // implied by the consent form the page rendered
    client_id: get("client_id"),
    redirect_uri: redirectUri,
    state: get("state"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
  });
  if (!parsed.ok) {
    const url = new URL(redirectUri);
    url.searchParams.set("error", parsed.error);
    url.searchParams.set("error_description", parsed.errorDescription);
    return NextResponse.redirect(url, 302);
  }

  const params = parsed.params;
  const callbackWith = (error: string, description: string): NextResponse => {
    const url = new URL(params.redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    return NextResponse.redirect(url, 302);
  };

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "session_expired", error_description: "Sesi web berakhir — muat ulang halaman otorisasi." },
      { status: 403 }
    );
  }

  if (!verifyConsentCsrf(user.id, params.redirectUri, params.state, get("csrf") ?? "")) {
    return callbackWith("invalid_request", "Token keamanan form tidak valid — muat ulang halaman otorisasi.");
  }

  if (get("decision") !== "authorize") {
    return callbackWith("access_denied", "Anda menolak permintaan otorisasi BMad Monitor.");
  }

  // Allowance gate re-checked at decision time, not just page render.
  if (user.status !== "Active") {
    return callbackWith("access_denied", "Akun Anda belum memiliki izin / allowance untuk mengakses BMad Workspace ini.");
  }

  const code = await insertAuthCode({
    userId: user.id,
    codeChallenge: params.codeChallenge,
    redirectUri: params.redirectUri,
    clientId: params.clientId,
  });

  const url = new URL(params.redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", params.state);
  return NextResponse.redirect(url, 302);
}
