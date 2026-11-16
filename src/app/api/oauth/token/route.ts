import { NextResponse } from "next/server";
import { exchangeAuthCode, mcpUserPayload, MCP_CLIENT_ID, rotateMcpRefreshToken } from "@/lib/oauth";

/**
 * POST /api/oauth/token — public (no web session). Form-urlencoded in, JSON
 * out, exactly the shapes the Go CLI parses (WEB_SPEC §1B/§1C).
 *
 * Error bodies are OAuth-shaped { error, error_description }; access_denied is
 * the only 403, everything else 400.
 */

function oauthError(status: number, error: string, errorDescription: string): NextResponse {
  return NextResponse.json({ error, error_description: errorDescription }, { status });
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return oauthError(400, "invalid_request", "body harus application/x-www-form-urlencoded");
  }
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };

  const grantType = field("grant_type");
  const clientId = field("client_id");

  if (clientId !== MCP_CLIENT_ID) {
    return oauthError(400, "invalid_client", `client_id harus '${MCP_CLIENT_ID}'`);
  }
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(400, "unsupported_grant_type", "grant_type harus authorization_code atau refresh_token");
  }

  if (grantType === "authorization_code") {
    const code = field("code");
    const codeVerifier = field("code_verifier");
    const redirectUri = field("redirect_uri");
    if (!code || !codeVerifier || !redirectUri) {
      return oauthError(400, "invalid_request", "code, code_verifier, dan redirect_uri wajib diisi");
    }

    const outcome = await exchangeAuthCode({ code, codeVerifier, redirectUri });
    if (outcome.status === "invalid_grant") {
      return oauthError(400, "invalid_grant", outcome.errorDescription);
    }
    if (outcome.status === "forbidden") {
      return oauthError(
        403,
        "access_denied",
        "Akun Anda belum memiliki izin / allowance untuk mengakses BMad Workspace ini."
      );
    }
    return NextResponse.json({
      access_token: outcome.tokens.accessToken,
      refresh_token: outcome.tokens.refreshToken,
      expires_in: outcome.tokens.expiresIn,
      token_type: "Bearer",
      user: mcpUserPayload(outcome.user),
    });
  }

  // grant_type === "refresh_token"
  const refreshToken = field("refresh_token");
  if (!refreshToken) {
    return oauthError(400, "invalid_request", "refresh_token wajib diisi");
  }

  const outcome = await rotateMcpRefreshToken(refreshToken);
  if (outcome.status === "invalid_grant") {
    return oauthError(400, "invalid_grant", "refresh token tidak valid atau sudah dipakai");
  }
  if (outcome.status === "forbidden") {
    return oauthError(
      403,
      "access_denied",
      "Akses dicabut: akun Anda tidak lagi memiliki allowance di Web Dashboard."
    );
  }
  return NextResponse.json({
    access_token: outcome.tokens.accessToken,
    refresh_token: outcome.tokens.refreshToken,
    expires_in: outcome.tokens.expiresIn,
    token_type: "Bearer",
    user: mcpUserPayload(outcome.user),
  });
}
