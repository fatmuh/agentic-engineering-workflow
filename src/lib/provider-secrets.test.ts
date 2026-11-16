import { beforeAll, describe, expect, test } from "vitest";
import { decryptSecret, encryptSecret, isEncrypted } from "./provider-secrets";

// The module derives its key from AUTH_SECRET at call time. The test supplies
// one so it does not depend on .env.local; every case below runs against the
// same value, which is what makes the round-trip assertions meaningful.
beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-only-auth-secret-for-encryption";
});

describe("provider secret encryption", () => {
  test("round-trips a key", () => {
    const key = "sk-ant-api03-super-secret";
    expect(decryptSecret(encryptSecret(key))).toBe(key);
  });

  test("the stored form never contains the plaintext", () => {
    const key = "sk-ant-api03-super-secret";
    const stored = encryptSecret(key);
    expect(stored).not.toContain(key);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored.startsWith("v1:")).toBe(true);
  });

  test("the same plaintext encrypts differently every time (random IV)", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  test("a pre-encryption clear-text row is returned as-is", () => {
    // Rows written before this module existed must keep working.
    expect(decryptSecret("sk-legacy-plaintext")).toBe("sk-legacy-plaintext");
    expect(isEncrypted("sk-legacy-plaintext")).toBe(false);
  });

  test("tampering with the ciphertext fails loudly instead of returning garbage", () => {
    const stored = encryptSecret("sk-secret");
    const parts = stored.split(":");
    const body = Buffer.from(parts[3], "base64");
    body[0] = body[0] ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  test("a malformed envelope throws rather than guessing", () => {
    expect(() => decryptSecret("v1:only-two-parts")).toThrow(/malformed/i);
  });

  test("unicode survives the round trip", () => {
    const key = "kunci-rahasia-ünïcode-🔐";
    expect(decryptSecret(encryptSecret(key))).toBe(key);
  });
});
