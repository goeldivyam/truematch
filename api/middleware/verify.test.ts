import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash, randomBytes } from "node:crypto";
import { verifySignature } from "./verify.js";

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const privkey = randomBytes(32);
    const pubkey = schnorr.getPublicKey(privkey);
    const message = new TextEncoder().encode("hello truematch");
    const sig = schnorr.sign(sha256(message), privkey);

    expect(
      verifySignature(hexFromBytes(pubkey), hexFromBytes(sig), message),
    ).toBe(true);
  });

  it("returns false for a tampered message", () => {
    const privkey = randomBytes(32);
    const pubkey = schnorr.getPublicKey(privkey);
    const message = new TextEncoder().encode("hello truematch");
    const sig = schnorr.sign(sha256(message), privkey);
    const tampered = new TextEncoder().encode("tampered message");

    expect(
      verifySignature(hexFromBytes(pubkey), hexFromBytes(sig), tampered),
    ).toBe(false);
  });

  it("returns false for a wrong pubkey", () => {
    const privkey = randomBytes(32);
    const message = new TextEncoder().encode("hello truematch");
    const sig = schnorr.sign(sha256(message), privkey);

    const otherPrivkey = randomBytes(32);
    const otherPubkey = schnorr.getPublicKey(otherPrivkey);

    expect(
      verifySignature(hexFromBytes(otherPubkey), hexFromBytes(sig), message),
    ).toBe(false);
  });

  it("returns false for malformed pubkey hex", () => {
    const privkey = randomBytes(32);
    const message = new TextEncoder().encode("hello truematch");
    const sig = schnorr.sign(sha256(message), privkey);

    expect(verifySignature("not-valid-hex", hexFromBytes(sig), message)).toBe(
      false,
    );
  });

  it("returns false for malformed signature hex", () => {
    const privkey = randomBytes(32);
    const pubkey = schnorr.getPublicKey(privkey);
    const message = new TextEncoder().encode("hello truematch");

    expect(
      verifySignature(hexFromBytes(pubkey), "not-valid-hex", message),
    ).toBe(false);
  });
});
