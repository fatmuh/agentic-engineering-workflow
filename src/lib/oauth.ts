import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { query } from "./db";
import { getSessionUser, loadUserById, type SessionUser } from "./auth";
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  signMcpAccessToken,
  signMcpRefreshToken,
  verifyMcpAccessToken,
  verifyMcpRefreshToken,
} from "./jwt";

/**
 * OAuth 2.0 + PKCE server-side logic for the BMad Monitor MCP CLI
 * (`bmad-mcp-cli`). Contract: WEB_SPECIFICATION.md §1 — see the spec folder
 * `_bmad-output/specs/spec-oauth-pkce-bmad-mcp/` for the full validated
 * contract this implements.
 *
 * The web session paths (cookies, refresh_tokens) are never touched here:
 * MCP refresh material lives in oauth_refresh_tokens with its own rotation
 * state, mirroring but separate from the web pair.
 */

/** The only client the authorize/token endpoints accept. */
export const MCP_CLIENT_ID = "bmad-mcp-cli";

/** Authorization codes live 60 seconds — enough for one browser round-trip. */
export const AUTH_CODE_TTL_SECONDS = 60;

/** Grace window for concurrent refresh races, matching the web pair. */
const MCP_REFRESH_GRACE_SECONDS = 30;

/** RFC 8252 loopback redirect: 127.0.0.1 literal host, dynamic port, /callback path. */
const LOOPBACK_REDIRECT_REGEX = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/;

/** Mirror jwt.ts: a missing signing key is a boot failure, not a per-request 500. */
function requireAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set. Add AUTH_SECRET to .env.local");
  return secret;
}
const AUTH_SECRET = requireAuthSecret();

export interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export type AuthorizeParamsResult =
  | { ok: true; params: AuthorizeParams }
  | { ok: false; error: string; errorDescription: string };

/** True only for a safe loopback callback URL (never use others as a redirect target). */
export function isSafeRedirectUri(redirectUri: string): boolean {
  const match = LOOPBACK_REDIRECT_REGEX.exec(redirectUri);
  return !!match && Number(match[1]) <= 65535;
}

/** Validate the /oauth/authorize query exactly as the CLI sends it. */
export function parseAuthorizeParams(raw: {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}): AuthorizeParamsResult {
  const fail = (error: string, errorDescription: string): AuthorizeParamsResult => ({
    ok: false,
    error,
    errorDescription,
  });

  if (raw.response_type !== "code") return fail("invalid_request", "response_type harus 'code'");
  if (raw.client_id !== MCP_CLIENT_ID)
    return fail("invalid_client", `client_id harus '${MCP_CLIENT_ID}'`);

  const redirectUri = raw.redirect_uri ?? "";
  if (!isSafeRedirectUri(redirectUri))
    return fail("invalid_request", "redirect_uri harus loopback http://127.0.0.1:<port>/callback");

  if (!raw.state) return fail("invalid_request", "state wajib diisi");
  if (!raw.code_challenge) return fail("invalid_request", "code_challenge wajib diisi");
  if (raw.code_challenge_method !== "S256")
    return fail("invalid_request", "code_challenge_method harus 'S256'");

  return {
    ok: true,
    params: {
      responseType: raw.response_type,
      clientId: raw.client_id,
      redirectUri,
      state: raw.state,
      codeChallenge: raw.code_challenge,
      codeChallengeMethod: raw.code_challenge_method,
    },
  };
}

/** Rebuild the /oauth/authorize URL (for the /login `next` round-trip). */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const qs = new URLSearchParams({
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
  });
  return `/oauth/authorize?${qs.toString()}`;
}

/**
 * Stateless CSRF token binding the consent form to one session + one
 * authorize request. HMAC over (userId, redirect_uri, state) so a form from
 * one authorize request cannot be replayed against another.
 */
export function consentCsrf(userId: string, redirectUri: string, state: string): string {
  return createHmac("sha256", AUTH_SECRET)
    .update(`${userId}|${redirectUri}|${state}`)
    .digest("hex");
}

export function verifyConsentCsrf(
  expectedUserId: string,
  redirectUri: string,
  state: string,
  presented: string
): boolean {
  const expected = consentCsrf(expectedUserId, redirectUri, state);
  const a = Buffer.from(expected);
  const b = Buffer.from(presented ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mint and persist a single-use authorization code (PKCE challenge attached). */
export async function insertAuthCode(input: {
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO oauth_codes (code, code_challenge, code_challenge_method, redirect_uri, client_id, user_id, expires_at)
     VALUES ($1, $2, 'S256', $3, $4, $5, now() + interval '60 seconds')`,
    [code, input.codeChallenge, input.redirectUri, input.clientId, input.userId]
  );
  return code;
}

export interface McpTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Contract field: seconds until the access token expires. */
  expiresIn: number;
}

/** Sign an MCP pair and persist the refresh material as sha256(jti), web-free. */
export async function issueMcpTokenPair(user: SessionUser): Promise<McpTokenPair> {
  const jti = randomUUID();
  const [accessToken, refreshToken] = await Promise.all([
    signMcpAccessToken({ id: user.id, email: user.email, role: user.role }),
    signMcpRefreshToken(user.id, jti),
  ]);
  await query(
    `INSERT INTO oauth_refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [
      user.id,
      createHash("sha256").update(jti).digest("hex"),
      new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_SECONDS * 1000),
    ]
  );
  return { accessToken, refreshToken, expiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS };
}

/** Contract user payload — isAllowed is the allowance gate (users.status). */
export function mcpUserPayload(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isAllowed: user.status === "Active",
    teamId: user.team,
  };
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export type ExchangeOutcome =
  | { status: "ok"; user: SessionUser; tokens: McpTokenPair }
  | { status: "invalid_grant"; errorDescription: string }
  | { status: "forbidden" };

/**
 * Consume one authorization code and verify PKCE S256 + redirect_uri.
 * The code is consumed atomically BEFORE the verifier is checked, so a code
 * whose exchange fails PKCE is still spent (no verifier brute-force).
 */
export async function exchangeAuthCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ExchangeOutcome> {
  const claimed = await query<{
    code_challenge: string;
    redirect_uri: string;
    client_id: string;
    user_id: string;
  }>(
    `UPDATE oauth_codes SET consumed_at = now()
     WHERE code = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING code_challenge, redirect_uri, client_id, user_id`,
    [input.code]
  );

  if (claimed.rowCount !== 1) {
    return { status: "invalid_grant", errorDescription: "code tidak dikenal, kedaluwarsa, atau sudah dipakai" };
  }
  const row = claimed.rows[0];

  if (input.redirectUri !== row.redirect_uri) {
    return { status: "invalid_grant", errorDescription: "redirect_uri tidak cocok" };
  }
  if (sha256Base64Url(input.codeVerifier) !== row.code_challenge) {
    return { status: "invalid_grant", errorDescription: "PKCE S256 tidak cocok" };
  }

  const user = await loadUserById(row.user_id);
  if (!user || user.status !== "Active") return { status: "forbidden" };

  const tokens = await issueMcpTokenPair(user);
  return { status: "ok", user, tokens };
}

/** Revoke every live MCP refresh token of a user (reuse detection, deactivation). */
export async function revokeAllMcpUserTokens(
  userId: string,
  reason: "reuse" | "deactivated" | "logout" = "reuse"
): Promise<void> {
  await query(
    `UPDATE oauth_refresh_tokens SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason]
  );
}

export type McpRefreshOutcome =
  | { status: "ok"; user: SessionUser; tokens: McpTokenPair }
  | { status: "invalid_grant" }
  | { status: "forbidden" };

/**
 * Rotate an MCP refresh token — mirrors the web rotateRefreshToken flow:
 * one atomic claim, 30s grace for races, reuse beyond grace revokes the
 * family, and a non-Active user loses every MCP token immediately.
 */
export async function rotateMcpRefreshToken(token: string): Promise<McpRefreshOutcome> {
  const claims = await verifyMcpRefreshToken(token);
  if (!claims) return { status: "invalid_grant" };

  const hash = createHash("sha256").update(claims.jti).digest("hex");

  const claimed = await query<{ user_id: string }>(
    `UPDATE oauth_refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated'
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
     RETURNING user_id`,
    [hash, new Date(Date.now())]
  );

  if (claimed.rowCount === 1) {
    const user = await loadUserById(claims.sub);
    if (!user || user.status !== "Active") {
      await revokeAllMcpUserTokens(claims.sub, "deactivated");
      return { status: "forbidden" };
    }
    return { status: "ok", user, tokens: await issueMcpTokenPair(user) };
  }

  const rows = await query<{
    user_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    revoked_reason: string | null;
    grace_eligible: boolean | null;
  }>(
    `SELECT user_id, expires_at, revoked_at, revoked_reason,
            (revoked_reason = 'rotated' AND now() - revoked_at <= interval '${MCP_REFRESH_GRACE_SECONDS} seconds') AS grace_eligible
     FROM oauth_refresh_tokens WHERE token_hash = $1`,
    [hash]
  );
  const row = rows.rows[0];
  if (!row) return { status: "invalid_grant" };
  if (row.expires_at.getTime() <= Date.now()) return { status: "invalid_grant" };

  if (row.grace_eligible) {
    const user = await loadUserById(claims.sub);
    if (!user || user.status !== "Active") {
      await revokeAllMcpUserTokens(row.user_id, "deactivated");
      return { status: "forbidden" };
    }
    return { status: "ok", user, tokens: await issueMcpTokenPair(user) };
  }

  // Replay of a spent/revoked token beyond grace — reuse detection.
  console.warn(
    JSON.stringify({ event: "mcp_refresh_reuse_detected", userId: row.user_id })
  );
  await revokeAllMcpUserTokens(row.user_id, "reuse");
  return { status: "invalid_grant" };
}

/**
 * Dual-auth guard for the BMad REST endpoints: a valid MCP Bearer (aud
 * bmad-mcp, stateless — no DB lookup by design) OR a valid web session
 * cookie (the Agent Board path). Returns a 401 Response to send, or null
 * when the request may proceed.
 */
export async function guardBmadApi(req: Request): Promise<Response | null> {
  const header = req.headers.get("authorization");
  if (header) {
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Stateless by decision: the MCP access token is a 30-day JWT whose
    // revocation story is the refresh grant + allowance gate, not a denylist.
    const claims = await verifyMcpAccessToken(token);
    return claims ? null : Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await getSessionUser();
  return session ? null : Response.json({ error: "Unauthorized" }, { status: 401 });
}
