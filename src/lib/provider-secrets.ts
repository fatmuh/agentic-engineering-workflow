import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * At-rest encryption for provider API keys (`bmad_llm_providers.api_key`).
 *
 * Why this exists: the key has to reach the Go MCP client in clear text — the
 * client turns it into `ANTHROPIC_API_KEY`, so returning it redacted would break
 * `awm_provider_select` outright. That makes the database the one place the
 * secret can be protected: a leaked dump, a backup, or a read-only replica
 * should not hand over live credentials.
 *
 * AES-256-GCM with a key derived from AUTH_SECRET (`sha256`, so any secret
 * length works). The stored form is `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`:
 * versioned so a future algorithm change is detectable, and GCM's tag means a
 * tampered row fails loudly instead of decrypting to garbage.
 *
 * NOT a substitute for not storing secrets. Anyone holding a valid bearer can
 * still read the value through the API; this only narrows the blast radius to
 * "someone with API access" from "anyone with the database file".
 */

const PREFIX = "v1";
const ALGORITHM = "aes-256-gcm";
/** 96-bit IV — the size AES-GCM is specified for; a longer one is hashed. */
const IV_BYTES = 12;

function requireSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set. Add AUTH_SECRET to .env.local");
  }
  return secret;
}

/** sha256 → exactly 32 bytes regardless of the secret's length or format. */
function derivedKey(): Buffer {
  return createHash("sha256").update(requireSecret(), "utf8").digest();
}

/** True when `value` already carries the `v1:` envelope. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * Decrypt a stored value. A value without the envelope is returned as-is: rows
 * written before this module existed (or by hand) stay readable, and the
 * migration that encrypts them is opt-in via a write, exactly like the
 * credential-redaction rule — boot never rewrites user data.
 *
 * A malformed envelope or a tag mismatch throws: that is corruption or
 * tampering, and answering with a wrong key would be worse than failing.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new Error("Stored secret is malformed (expected v1:<iv>:<tag>:<ciphertext>)");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, derivedKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
