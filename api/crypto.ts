import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getKey(): Buffer {
  const raw = process.env["CONTACT_ENCRYPTION_KEY"];
  if (!raw) {
    throw new Error(
      "CONTACT_ENCRYPTION_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new Error("CONTACT_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
  }
  return key;
}

// Returns "<iv_hex>:<tag_hex>:<ciphertext_hex>"
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted value format");
  const [ivHex, tagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

// Validates the key is present and correctly sized at startup.
export function validateEncryptionKey(): void {
  getKey();
}
