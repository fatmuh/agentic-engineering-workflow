import { query } from "./db";
import { decryptSecret, encryptSecret, isEncrypted } from "./provider-secrets";

/**
 * Provider registry for the `awm_provider_*` MCP tools (CAP-2 follow-up).
 *
 * Before this module the only route was a `GET` that, on an empty table, seeded
 * TWO FABRICATED providers carrying invented API keys and returned them as if
 * they were real — and every read handed `apiKey` back in clear text. The seed
 * is gone: an empty registry now answers with an empty list, and the caller
 * registers what it actually has.
 *
 * The key itself must still reach the Go client verbatim (it becomes
 * `ANTHROPIC_API_KEY`), so it is decrypted on the way out and encrypted on the
 * way in — see `provider-secrets.ts` for why that is the right boundary.
 */

export interface ProviderRow {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  model_id: string;
  is_team_shared: boolean;
  registered_by: string;
  created_at: Date;
}

/** The provider shape the API and the Go client share (Go: LLMProviderConfig). */
export interface LLMProvider {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  /** Clear text on the wire — the client applies it to the environment. */
  apiKey: string;
  modelId: string;
  isTeamShared: boolean;
  registeredBy: string;
}

/** A provider flow failure the route answers with its own status. */
export class ProviderError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const PROVIDER_TYPES = ["anthropic", "openai_compatible", "proxy"] as const;

export function toProvider(row: ProviderRow): LLMProvider {
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    // Rows written before encryption existed are stored in clear text; that is
    // readable, not an error, so they keep working until their next write.
    apiKey: decryptSecret(row.api_key),
    modelId: row.model_id,
    isTeamShared: row.is_team_shared,
    registeredBy: row.registered_by,
  };
}

export async function listProviders(): Promise<LLMProvider[]> {
  const res = await query<ProviderRow>(
    `SELECT * FROM bmad_llm_providers ORDER BY created_at ASC, id ASC`
  );
  return res.rows.map(toProvider);
}

export async function getProviderById(id: string): Promise<LLMProvider | null> {
  const res = await query<ProviderRow>(`SELECT * FROM bmad_llm_providers WHERE id = $1`, [id]);
  const row = res.rows[0];
  return row ? toProvider(row) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export interface RegisterProviderInput {
  id?: string;
  name?: string;
  providerType?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  isTeamShared?: boolean;
  registeredBy?: string;
}

/**
 * Register a provider, or update the mutable fields of an existing one.
 *
 * `apiKey` is optional on purpose: a client re-registering a provider it no
 * longer has the key for must not blank it. An ABSENT key keeps the stored one;
 * a present one replaces it (re-encrypted).
 *
 * An explicit id wins; otherwise one is generated. Updating keeps `createdAt`
 * and therefore the listing order.
 */
export async function registerProvider(input: RegisterProviderInput): Promise<LLMProvider> {
  const name = optionalString(input.name);
  const baseUrl = optionalString(input.baseUrl);
  const modelId = optionalString(input.modelId);
  if (!name) throw new ProviderError(400, "A provider name is required");
  if (!baseUrl) throw new ProviderError(400, "A baseUrl is required");
  if (!modelId) throw new ProviderError(400, "A modelId is required");

  const providerType = optionalString(input.providerType) ?? "anthropic";
  if (!(PROVIDER_TYPES as readonly string[]).includes(providerType)) {
    throw new ProviderError(400, `providerType must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }

  const apiKey = optionalString(input.apiKey);
  const registeredBy = optionalString(input.registeredBy) ?? "";
  const isTeamShared = input.isTeamShared === true;
  const explicitId = optionalString(input.id);

  if (explicitId) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM bmad_llm_providers WHERE id = $1`,
      [explicitId]
    );
    if (existing.rows[0]) {
      // An update must not drop a key the caller does not carry.
      // COALESCE keeps the stored key when the caller sent none (a masked form
      // cannot round-trip the value). $7 is cast because Postgres cannot infer
      // the type of a NULL parameter inside COALESCE.
      const res = await query<ProviderRow>(
        `UPDATE bmad_llm_providers
            SET name = $2, provider_type = $3, base_url = $4, model_id = $5,
                is_team_shared = $6, registered_by = $8,
                api_key = COALESCE($7::text, api_key)
          WHERE id = $1
          RETURNING *`,
        [
          explicitId,
          name,
          providerType,
          baseUrl,
          modelId,
          isTeamShared,
          apiKey === null ? null : encryptSecret(apiKey),
          registeredBy,
        ]
      );
      return toProvider(res.rows[0]);
    }
    if (apiKey === null) {
      throw new ProviderError(400, "An apiKey is required when registering a new provider");
    }
    const res = await query<ProviderRow>(
      `INSERT INTO bmad_llm_providers
         (id, name, provider_type, base_url, api_key, model_id, is_team_shared, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [explicitId, name, providerType, baseUrl, encryptSecret(apiKey), modelId, isTeamShared, registeredBy]
    );
    return toProvider(res.rows[0]);
  }

  if (apiKey === null) {
    throw new ProviderError(400, "An apiKey is required when registering a new provider");
  }
  const res = await query<ProviderRow>(
    `INSERT INTO bmad_llm_providers
       (id, name, provider_type, base_url, api_key, model_id, is_team_shared, registered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      `prov_${randomId()}`,
      name,
      providerType,
      baseUrl,
      encryptSecret(apiKey),
      modelId,
      isTeamShared,
      registeredBy,
    ]
  );
  return toProvider(res.rows[0]);
}

function randomId(): string {
  // Same shape as the hand-written ids in the old seed (`prov_*`).
  return globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

/**
 * Encrypt any row still holding a clear-text key. Opt-in, like every other
 * migration of user data in this codebase: run by an explicit call, never by
 * boot. Returns how many rows it changed.
 */
export async function encryptStoredKeys(): Promise<number> {
  const res = await query<{ id: string; api_key: string }>(
    `SELECT id, api_key FROM bmad_llm_providers`
  );
  let changed = 0;
  for (const row of res.rows) {
    if (isEncrypted(row.api_key)) continue;
    await query(`UPDATE bmad_llm_providers SET api_key = $2 WHERE id = $1`, [
      row.id,
      encryptSecret(row.api_key),
    ]);
    changed += 1;
  }
  return changed;
}

/** Shared 4xx/500 mapping for the provider routes. */
export function providerErrorResponse(error: unknown): Response {
  if (error instanceof ProviderError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Internal server error";
  return Response.json({ error: message }, { status: 500 });
}
