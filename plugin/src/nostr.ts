import {
  SimplePool,
  finalizeEvent,
  verifyEvent,
  type Event,
} from "nostr-tools";
import { nip04 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import type { TrueMatchMessage } from "./types.js";

// Public Nostr relays — agents must publish to ≥ 2 relays per spec
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://nostr.mom",
];

// NIP-04 kind for encrypted DMs
const KIND_ENCRYPTED_DM = 4;

async function encryptMessage(
  senderNsec: string,
  recipientNpub: string,
  message: TrueMatchMessage,
): Promise<string> {
  const plaintext = JSON.stringify(message);
  return nip04.encrypt(senderNsec, recipientNpub, plaintext);
}

async function decryptMessage(
  recipientNsec: string,
  senderNpub: string,
  ciphertext: string,
): Promise<TrueMatchMessage> {
  const plaintext = await nip04.decrypt(recipientNsec, senderNpub, ciphertext);
  return JSON.parse(plaintext) as TrueMatchMessage;
}

export async function publishMessage(
  senderNsec: string,
  recipientNpub: string,
  message: TrueMatchMessage,
  relays: string[] = DEFAULT_RELAYS,
): Promise<void> {
  const ciphertext = await encryptMessage(senderNsec, recipientNpub, message);

  const eventTemplate = {
    kind: KIND_ENCRYPTED_DM,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientNpub]],
    content: ciphertext,
  };

  const secretKeyBytes = hexToBytes(senderNsec);
  const signedEvent = finalizeEvent(eventTemplate, secretKeyBytes);

  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signedEvent));
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    if (succeeded === 0) {
      throw new Error("Failed to publish to any relay");
    }
  } finally {
    pool.close(relays);
  }
}

export async function subscribeToMessages(
  recipientNsec: string,
  recipientNpub: string,
  onMessage: (from: string, message: TrueMatchMessage) => Promise<void>,
  relays: string[] = DEFAULT_RELAYS,
  since?: number,
): Promise<() => void> {
  const pool = new SimplePool();
  // Deduplicate events delivered by multiple relays
  const seenEventIds = new Set<string>();

  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [KIND_ENCRYPTED_DM],
      "#p": [recipientNpub],
      since: since ?? Math.floor(Date.now() / 1000) - 60 * 60, // last hour
    },
    {
      onevent: async (event: Event) => {
        // NIP-01: verify event signature before processing
        if (!verifyEvent(event)) return;
        // Skip duplicates (same event from multiple relays)
        if (seenEventIds.has(event.id)) return;
        seenEventIds.add(event.id);

        const senderNpub = event.pubkey;
        try {
          const message = await decryptMessage(
            recipientNsec,
            senderNpub,
            event.content,
          );
          // Only process TrueMatch protocol messages
          if (
            typeof message === "object" &&
            message !== null &&
            "truematch" in message &&
            message.truematch === "2.0"
          ) {
            await onMessage(senderNpub, message);
          }
        } catch {
          // Ignore messages that fail to decrypt or parse
        }
      },
    },
  );

  return () => {
    sub.close();
    pool.close(relays);
  };
}

export async function checkRelayConnectivity(
  relays: string[] = DEFAULT_RELAYS,
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  await Promise.all(
    relays.map(async (relay) => {
      try {
        const ws = new WebSocket(relay);
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => {
            ws.close();
            resolve();
          };
          ws.onerror = () => reject(new Error("connection failed"));
          setTimeout(() => {
            ws.close();
            reject(new Error("timeout"));
          }, 5000);
        });
        results[relay] = true;
      } catch {
        results[relay] = false;
      }
    }),
  );
  return results;
}
