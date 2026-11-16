import { NextResponse } from "next/server";
import { guardBmadApi } from "@/lib/oauth";
import { listProviders, providerErrorResponse, registerProvider } from "@/lib/providers";

/**
 * GET /api/llm-providers — the `awm_provider_list` tool.
 *
 * Read-only, and honest about emptiness: an empty registry answers `[]`. It
 * used to seed two fabricated providers with invented API keys on first read,
 * which is the same "fake data presented as live" failure the board had.
 *
 * `apiKey` IS returned in clear text, deliberately: the Go client turns it into
 * `ANTHROPIC_API_KEY`, so redacting it here would break `awm_provider_select`.
 * The database stores it encrypted — see `src/lib/provider-secrets.ts`.
 */
export async function GET(req: Request) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await listProviders());
  } catch (err: unknown) {
    return providerErrorResponse(err);
  }
}

/**
 * POST /api/llm-providers — register or update a provider.
 *
 * Body: `{ id?, name, providerType?, baseUrl, apiKey?, modelId, isTeamShared?,
 * registeredBy? }`. `apiKey` is required for a NEW provider and optional for an
 * update, where an absent key keeps the stored one rather than blanking it.
 */
export async function POST(req: Request) {
  const denied = await guardBmadApi(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
    }
    const fields = body as Record<string, unknown>;
    for (const field of ["id", "name", "providerType", "baseUrl", "apiKey", "modelId", "registeredBy"] as const) {
      const value = fields[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return NextResponse.json({ error: `${field} must be a string` }, { status: 400 });
      }
    }
    const provider = await registerProvider(fields);
    return NextResponse.json(provider, { status: 201 });
  } catch (err: unknown) {
    return providerErrorResponse(err);
  }
}
