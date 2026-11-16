import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  api,
  closeDbPool,
  FIXTURE_EMAILS,
  FIXTURE_PASSWORD,
  getPool,
  login,
  seedFixtureUsers,
  type ApiResult,
} from "./helpers";

/**
 * Provider registry (spec-bmad-hardening follow-up) — the write path the
 * `awm_provider_select` tool needed and never had.
 *
 * Before this, `GET /api/llm-providers` seeded two fabricated providers with
 * invented API keys on first read and there was no way to register a real one.
 * These tests pin the replacement: an honest empty list, a working register,
 * an update that does not blank the key, and at-rest encryption (the raw column
 * must never equal what the caller sent).
 *
 * The key still comes back in clear text from GET — the Go client needs it for
 * ANTHROPIC_API_KEY — so the assertion is about the DATABASE, not the wire.
 */

const FIXTURE_PREFIX = "Matrix Provider";

let cookie: string;

function expectStatus(response: ApiResult, status: number): ApiResult {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

interface ProviderBody {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  isTeamShared: boolean;
}

async function register(body: Record<string, unknown>): Promise<ProviderBody> {
  return expectStatus(
    await api("/api/llm-providers", { method: "POST", cookie, body }),
    201,
  ).body as ProviderBody;
}

async function rawKey(id: string): Promise<string | undefined> {
  const { rows } = await getPool().query<{ api_key: string }>(
    `SELECT api_key FROM bmad_llm_providers WHERE id = $1`,
    [id],
  );
  return rows[0]?.api_key;
}

beforeAll(async () => {
  await seedFixtureUsers();
  cookie = await login(FIXTURE_EMAILS.admin, FIXTURE_PASSWORD);
  await getPool().query(`DELETE FROM bmad_llm_providers WHERE name LIKE $1`, [`${FIXTURE_PREFIX}%`]);
});

afterAll(async () => {
  try {
    await getPool().query(`DELETE FROM bmad_llm_providers WHERE name LIKE $1`, [`${FIXTURE_PREFIX}%`]);
  } finally {
    await closeDbPool();
  }
});

test("an empty registry answers with an empty list, not fabricated providers", async () => {
  // The old GET seeded two invented rows on first read. Nothing may appear
  // that this test did not create.
  const before = expectStatus(await api("/api/llm-providers", { cookie }), 200).body as ProviderBody[];
  const seeded = before.filter((provider) => provider.name.includes("LiteLLM Gateway") || provider.name.includes("Anthropic Direct"));
  expect(seeded).toEqual([]);

  const { rows } = await getPool().query<{ name: string }>(
    `SELECT name FROM bmad_llm_providers WHERE name = 'Team LiteLLM Gateway'`,
  );
  expect(rows).toEqual([]);
});

test("registering a provider stores the key encrypted and returns it in clear text", async () => {
  const secret = "sk-ant-api03-matrix-secret-key-value";
  const created = await register({
    name: `${FIXTURE_PREFIX} Anthropic`,
    providerType: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: secret,
    modelId: "claude-opus-5-5",
  });

  expect(created).toMatchObject({
    name: `${FIXTURE_PREFIX} Anthropic`,
    providerType: "anthropic",
    modelId: "claude-opus-5-5",
  });
  // The wire carries it: the Go client needs it for ANTHROPIC_API_KEY.
  expect(created.apiKey).toBe(secret);

  // The column must NOT. This is the whole point of the encryption.
  const stored = await rawKey(created.id);
  expect(stored).toBeDefined();
  expect(stored).not.toBe(secret);
  expect(stored?.startsWith("v1:")).toBe(true);
  expect(stored).not.toContain(secret);
});

test("the list endpoint decrypts for the client and never leaks ciphertext", async () => {
  const secret = "sk-ant-api03-list-secret";
  const created = await register({
    name: `${FIXTURE_PREFIX} Listed`,
    baseUrl: "https://api.anthropic.com",
    apiKey: secret,
    modelId: "claude-sonnet-5-5",
  });

  const list = expectStatus(await api("/api/llm-providers", { cookie }), 200).body as ProviderBody[];
  const mine = list.find((provider) => provider.id === created.id);
  expect(mine?.apiKey).toBe(secret);
  // No row may hand back an envelope instead of a key.
  for (const provider of list) {
    expect(provider.apiKey.startsWith("v1:")).toBe(false);
  }
});

test("updating without a key keeps the stored one; sending one replaces it", async () => {
  const original = "sk-ant-api03-original";
  const created = await register({
    name: `${FIXTURE_PREFIX} Update`,
    baseUrl: "https://api.anthropic.com",
    apiKey: original,
    modelId: "claude-sonnet-5-5",
  });

  const renamed = await register({
    id: created.id,
    name: `${FIXTURE_PREFIX} Update Renamed`,
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-5-5",
  });
  expect(renamed).toMatchObject({ id: created.id, name: `${FIXTURE_PREFIX} Update Renamed` });
  expect(renamed.apiKey).toBe(original); // not blanked

  const replaced = "sk-ant-api03-replaced";
  const withNewKey = await register({
    id: created.id,
    name: `${FIXTURE_PREFIX} Update Renamed`,
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-5-5",
    apiKey: replaced,
  });
  expect(withNewKey.apiKey).toBe(replaced);
  expect(await rawKey(created.id)).not.toContain(replaced);
});

test("a new provider without an apiKey is a 400; bad input is too", async () => {
  const before = expectStatus(await api("/api/llm-providers", { cookie }), 200).body as ProviderBody[];

  expectStatus(
    await api("/api/llm-providers", {
      method: "POST",
      cookie,
      body: { name: `${FIXTURE_PREFIX} NoKey`, baseUrl: "https://x.test", modelId: "m" },
    }),
    400,
  );
  expectStatus(
    await api("/api/llm-providers", {
      method: "POST",
      cookie,
      body: { name: "", baseUrl: "https://x.test", modelId: "m", apiKey: "k" },
    }),
    400,
  );
  expectStatus(
    await api("/api/llm-providers", {
      method: "POST",
      cookie,
      body: { name: `${FIXTURE_PREFIX} BadType`, baseUrl: "https://x.test", modelId: "m", apiKey: "k", providerType: "carrier-pigeon" },
    }),
    400,
  );

  const after = expectStatus(await api("/api/llm-providers", { cookie }), 200).body as ProviderBody[];
  expect(after.length).toBe(before.length);
});

test("a pre-encryption clear-text row still reads through the API", async () => {
  // A row written before encryption existed (or by hand) must not break the list.
  await getPool().query(
    `INSERT INTO bmad_llm_providers (id, name, provider_type, base_url, api_key, model_id)
     VALUES ('prov_matrix_legacy', $1, 'anthropic', 'https://api.anthropic.com', 'sk-legacy-plaintext', 'claude-sonnet-5-5')
     ON CONFLICT (id) DO UPDATE SET api_key = 'sk-legacy-plaintext'`,
    [`${FIXTURE_PREFIX} Legacy`],
  );

  const list = expectStatus(await api("/api/llm-providers", { cookie }), 200).body as ProviderBody[];
  expect(list.find((provider) => provider.id === "prov_matrix_legacy")?.apiKey).toBe("sk-legacy-plaintext");

  // The migration runs through a module-level pool, and `@/lib/providers`
  // reads DATABASE_URL at IMPORT time — which in this process is the dev
  // database. Swapping it to the scratch URL BEFORE the import is the same
  // guard the other specs use, and is not optional: an earlier version of this
  // test omitted it and encrypted two rows in the dev database.
  const previousDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.MATRIX_DB_URL;
  try {
    vi.resetModules();
    const providers = await import("@/lib/providers");
    expect(await providers.encryptStoredKeys()).toBeGreaterThan(0);
    expect(await providers.encryptStoredKeys()).toBe(0); // idempotent
    const db = await import("@/lib/db");
    await db.pool.end();
  } finally {
    process.env.DATABASE_URL = previousDbUrl;
  }

  expect(await rawKey("prov_matrix_legacy")).toMatch(/^v1:/);
  const again = expectStatus(await api("/api/llm-providers", { cookie }), 200).body as ProviderBody[];
  expect(again.find((provider) => provider.id === "prov_matrix_legacy")?.apiKey).toBe("sk-legacy-plaintext");
});

test("the provider routes are gated: no session is a 401", async () => {
  expectStatus(await api("/api/llm-providers"), 401);
  expectStatus(
    await api("/api/llm-providers", { method: "POST", body: { name: "x", baseUrl: "y", modelId: "z", apiKey: "k" } }),
    401,
  );
});
