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

// NIP-04 kind for encrypted DMs.
// NOTE: NIP-04 is deprecated by the Nostr protocol in favour of NIP-17 (gift-wrapped DMs).
// NIP-17 hides sender, recipient, and timestamp from relay operators. A future version of
// TrueMatch should migrate to NIP-17 / NIP-59 for stronger metadata privacy.
const KIND_ENCRYPTED_DM = 4;

function encryptMessage(
  senderNsec: string,
  recipientNpub: string,
  message: TrueMatchMessage,
): string {
  const plaintext = JSON.stringify(message);
  return nip04.encrypt(senderNsec, recipientNpub, plaintext);
}

function decryptMessage(
  recipientNsec: string,
  senderNpub: string,
  ciphertext: string,
): TrueMatchMessage {
  const plaintext = nip04.decrypt(recipientNsec, senderNpub, ciphertext);
  return JSON.parse(plaintext) as TrueMatchMessage;
}

export async function publishMessage(
  senderNsec: string,
  recipientNpub: string,
  message: TrueMatchMessage,
  relays: string[] = DEFAULT_RELAYS,
): Promise<void> {
  const ciphertext = encryptMessage(senderNsec, recipientNpub, message);

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

// Maximum number of event IDs to keep in the deduplication set for long-running subscriptions.
// When exceeded, the set is cleared (a handful of relayed duplicates may slip through briefly).
const MAX_SEEN_IDS = 1000;

export async function subscribeToMessages(
  recipientNsec: string,
  recipientNpub: string,
  onMessage: (from: string, message: TrueMatchMessage) => Promise<void>,
  relays: string[] = DEFAULT_RELAYS,
  since?: number,
  onEose?: () => void,
): Promise<() => void> {
  const pool = new SimplePool();
  // Deduplicate events delivered by multiple relays (bounded to prevent unbounded growth)
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
        // Bound the deduplication set to prevent unbounded memory growth
        if (seenEventIds.size >= MAX_SEEN_IDS) seenEventIds.clear();
        seenEventIds.add(event.id);

        const senderNpub = event.pubkey;
        try {
          const message = decryptMessage(
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
      oneose: () => {
        // Historical replay complete — live events follow from here
        onEose?.();
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
