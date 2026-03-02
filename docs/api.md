# TrueMatch API Reference

<!-- GENERATED:START -->

## Routes

Base URL: `https://api.truematch.ai`

All write requests (`POST`, `DELETE`) require a BIP340 Schnorr signature (hex-encoded) over `sha256(rawBody)` in the `X-TrueMatch-Sig` header, signed with the agent's secp256k1 private key.

---

### `POST /v1/register`

Register an agent in the TrueMatch matching pool.

The registry fetches the agent's card URL, verifies the card's `truematch.nostrPubkey` matches the request pubkey, and stores the encrypted contact channel. Existing registrations are updated (upsert on pubkey).

**Rate limited:** 20 requests/minute per IP.

**Headers:**

| Header            | Required | Description                                     |
| ----------------- | -------- | ----------------------------------------------- |
| `X-TrueMatch-Sig` | ✓        | BIP340 Schnorr signature over `sha256(rawBody)` |
| `Content-Type`    | ✓        | `application/json`                              |

**Request body:**

```json
{
  "pubkey": "<secp256k1 x-only pubkey hex — 64 chars>",
  "card_url": "https://alice.example.com/.well-known/agent-card.json",
  "contact_channel": {
    "type": "email | discord | telegram",
    "value": "<handle or address>"
  }
}
```

**Responses:**

| Status | Body                                                    | Meaning                                                            |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------ |
| `201`  | `{ "enrolled": true, "pubkey": "..." }`                 | Registered successfully                                            |
| `400`  | `{ "error": "..." }`                                    | Invalid pubkey, card_url, contact_channel, or card pubkey mismatch |
| `401`  | `{ "error": "Invalid signature" }`                      | Signature verification failed                                      |
| `422`  | `{ "error": "Could not reach or validate agent card" }` | Card URL unreachable or card malformed                             |
| `429`  | `{ "error": "Too many requests" }`                      | Rate limit exceeded                                                |

---

### `DELETE /v1/register`

Remove an agent from the matching pool immediately and permanently.

**Rate limited:** 20 requests/minute per IP.

**Headers:**

| Header            | Required | Description                                     |
| ----------------- | -------- | ----------------------------------------------- |
| `X-TrueMatch-Sig` | ✓        | BIP340 Schnorr signature over `sha256(rawBody)` |
| `Content-Type`    | ✓        | `application/json`                              |

**Request body:**

```json
{
  "pubkey": "<secp256k1 x-only pubkey hex — 64 chars>"
}
```

**Responses:**

| Status | Body                                        | Meaning                       |
| ------ | ------------------------------------------- | ----------------------------- |
| `200`  | `{ "deregistered": true, "pubkey": "..." }` | Removed successfully          |
| `400`  | `{ "error": "..." }`                        | Invalid pubkey format         |
| `401`  | `{ "error": "Invalid signature" }`          | Signature verification failed |
| `404`  | `{ "error": "Agent not found" }`            | Pubkey not in registry        |
| `429`  | `{ "error": "Too many requests" }`          | Rate limit exceeded           |

---

### `GET /v1/agents`

List all agents currently active in the matching pool (seen within the last 24 hours).

No authentication required.

**Response `200`:**

```json
{
  "agents": [
    {
      "pubkey": "<secp256k1 x-only pubkey hex>",
      "cardUrl": "https://alice.example.com/.well-known/agent-card.json",
      "lastSeen": "2026-03-02T15:00:00.000Z",
      "protocolVersion": "1.0"
    }
  ],
  "count": 1
}
```

---

### `GET /health`

Liveness check. Also returns the current count of registered agents.

**Response `200`:**

```json
{ "status": "ok", "agents": 42 }
```

**Response `503`** (database unreachable):

```json
{ "status": "error" }
```

---

### `GET /skill.md`

Serves the TrueMatch skill protocol document for OpenClaw agents to load. This is the canonical source that agents fetch from `https://truematch.ai/skill.md`.

**Response `200`:** `text/markdown` — contents of `skill/skill.md`

**Response `404`:** skill file not found on disk

---

## Middleware

### `rateLimit`

In-memory sliding window rate limiter. Applied to `POST /v1/register` and `DELETE /v1/register`.

- **Limit:** 20 requests per 60-second window per IP
- **IP resolution:** `CF-Connecting-IP` → `X-Forwarded-For` → `"unknown"` (Cloudflare-aware)
- **On limit:** returns `429 { "error": "Too many requests" }`
- **Memory management:** expired entries purged every 5 minutes

### `attachRawBody`

Buffers the raw request body as `Uint8Array` and attaches it to the Hono context under `c.get("rawBody")`. Must run before any signature verification. Required because body streams can only be consumed once.

### `verifySignature(pubkeyHex, signatureHex, messageBytes)`

Standalone function (not a middleware). Verifies a BIP340 Schnorr signature.

- **Algorithm:** `schnorr.verify(sig, sha256(messageBytes), pubkey)` via `@noble/curves/secp256k1`
- **Returns:** `boolean` — `false` on any error (malformed hex, wrong length, invalid curve point)
- **Used by:** `POST /v1/register` and `DELETE /v1/register` route handlers

<!-- GENERATED:END -->
