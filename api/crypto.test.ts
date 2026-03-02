import { describe, expect, it, beforeEach } from "vitest";

// Set required env var before importing crypto module
beforeEach(() => {
  process.env["CONTACT_ENCRYPTION_KEY"] =
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes base64
});

// Dynamic import so env is set before module initialises
async function getCrypto() {
  return await import("./crypto.js");
}

describe("encrypt / decrypt", () => {
  it("round-trips a plaintext value", async () => {
    const { encrypt, decrypt } = await getCrypto();
    const original = "user@example.com";
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it("produces different ciphertexts for the same input (random IV)", async () => {
    const { encrypt } = await getCrypto();
    const a = encrypt("same-value");
    const b = encrypt("same-value");
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext", async () => {
    const { encrypt, decrypt } = await getCrypto();
    const encoded = encrypt("my-discord-handle");
    const parts = encoded.split(":");
    // flip last byte of ciphertext
    const tampered = parts[2]!.slice(0, -2) + "ff";
    expect(() => decrypt(`${parts[0]}:${parts[1]}:${tampered}`)).toThrow();
  });
});
