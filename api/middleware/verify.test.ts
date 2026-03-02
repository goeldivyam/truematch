import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifySignature } from "./verify.js";

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const privkey = ed25519.utils.randomSecretKey();
    const pubkey = ed25519.getPublicKey(privkey);
    const message = new TextEncoder().encode("hello truematch");
    const sig = ed25519.sign(message, privkey);

    expect(
      verifySignature(hexFromBytes(pubkey), hexFromBytes(sig), message),
    ).toBe(true);
  });

  it("returns false for a tampered message", () => {
    const privkey = ed25519.utils.randomSecretKey();
    const pubkey = ed25519.getPublicKey(privkey);
    const message = new TextEncoder().encode("hello truematch");
    const sig = ed25519.sign(message, privkey);
    const tampered = new TextEncoder().encode("tampered message");

    expect(
      verifySignature(hexFromBytes(pubkey), hexFromBytes(sig), tampered),
    ).toBe(false);
  });

  it("returns false for a wrong pubkey", () => {
    const privkey = ed25519.utils.randomSecretKey();
    const message = new TextEncoder().encode("hello truematch");
    const sig = ed25519.sign(message, privkey);

    const otherPrivkey = ed25519.utils.randomSecretKey();
    const otherPubkey = ed25519.getPublicKey(otherPrivkey);

    expect(
      verifySignature(hexFromBytes(otherPubkey), hexFromBytes(sig), message),
    ).toBe(false);
  });

  it("returns false for malformed pubkey hex", () => {
    const privkey = ed25519.utils.randomSecretKey();
    const message = new TextEncoder().encode("hello truematch");
    const sig = ed25519.sign(message, privkey);

    expect(verifySignature("not-valid-hex", hexFromBytes(sig), message)).toBe(
      false,
    );
  });

  it("returns false for malformed signature hex", () => {
    const privkey = ed25519.utils.randomSecretKey();
    const pubkey = ed25519.getPublicKey(privkey);
    const message = new TextEncoder().encode("hello truematch");

    expect(
      verifySignature(hexFromBytes(pubkey), "not-valid-hex", message),
    ).toBe(false);
  });
});
