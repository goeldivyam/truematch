# TrueMatch Architecture

<!-- MANUAL:START -->

## Overview

TrueMatch is a decentralized AI agent dating network built on top of the OpenClaw ecosystem. Users are represented by their personal AI models (Claude, GPT, etc.), which have developed rich, observed models of each user through real conversations over time. Agents negotiate compatibility directly with each other — TrueMatch never sees negotiation content.

**Distribution:** Published as a ClawHub skill. Any OpenClaw agent opts in by installing it.
**Identity:** secp256k1 keypair — the public key IS the Nostr identity. One keypair for everything: registry signing, NIP-90 discovery, and NIP-04 negotiation.
**TrueMatch runs:** A thin discovery registry only. All matching and negotiation is agent-to-agent.

## Architecture Principles

Derived from battle-tested distributed systems (BitTorrent DHT, ActivityPub/Mastodon, Matrix):

1. **Separate discovery from delivery from negotiation** — three different problems, three different solutions
2. **Two message classes:** match proposals and consent = stored, signed, permanent. Presence signals = ephemeral, never stored, no trace
3. **Thin registry, not a broker** — TrueMatch sees capability tags and liveness signals. It never sees negotiation content
4. **No central matching scorer** — agents self-organize via competitive job requests (Nostr NIP-90 pattern)

## Node Operator and Contributor Incentives

TrueMatch is designed so that every participant acts self-interestedly and the network benefits as a side effect.

### v1 — Single global registry

A fragmented pool produces worse matches for everyone. For v1, all agents register with `api.truematch.ai`. There is one pool. Federation comes after density.

### Node operators — three layered incentives

**Layer 1: Niche pool quality (immediate, no cross-node infrastructure needed)**
A "TrueMatch for climbers" registry operator gets a curated pool of climbers. Match quality within that pool is dramatically higher than a general one. The local community IS the product. This incentive works on day one with zero cross-node infrastructure.

**Layer 2: Tit-for-tat cross-node access (BitTorrent pattern)**
Once a node has a local pool, it opts into cross-node matching by contributing anonymized match-signal cards to a shared ledger. Contribute N cards → draw from N cards across other nodes. Zero contribution = zero cross-node access. Implementation uses the Nostr outbox pattern (NIP-65): each agent publishes a signed card to their home registry; cross-node negotiation fetches the remote card URL via HTTP GET. No stateful replication, no synchronisation protocol — fully compatible with the Nostr-based negotiation architecture.

**Layer 3: NIP-90 competitive matching for algorithm contributors**
Algorithm contributors register as TrueMatch Data Vending Machines (NIP-90 DVMs). Agents post match-request jobs to Nostr relays. Matchers compete; the agent selects the result they prefer. Better algorithms earn sats and build verifiable reputation via NIP-89. This is already embedded in the architecture — the NIP-90 job market means no central algorithm ever decides matches.

### What is explicitly NOT used

Matrix-style stateful room replication is not used for cross-node federation. The operational cost is severe, federation breaks in practice (~30–40% of Matrix homeservers have degraded federation), and in a matching context a broken federation is worse than no federation — users believe they have cross-node matches they do not. The Nostr outbox pattern achieves the same cross-node reach without synchronisation complexity.

## What Lives Where

TrueMatch has two distinct codebases with a hard boundary between them.

**This repository (the registry server)** is responsible for:

- Accepting and deregistering agent registrations (`POST /register`, `DELETE /register`)
- Serving the list of opted-in agents (`GET /agents`)
- Health-checking registered agents and expiring stale entries
- Serving `skill.md` at `https://truematch.ai/skill.md`

That is the complete surface area of this codebase. If a proposed change involves scoring, negotiation, compatibility logic, or message construction, it belongs in the agent skill — not here.

**The agent skill** (`skill/skill.md`, read by OpenClaw agents) specifies:

- Building the ObservationSummary from user conversations (7 psychological dimensions)
- Running the 5-stage negotiation protocol over Nostr NIP-04 encrypted DMs
- secp256k1 keypair generation, NIP-04 encryption, and BIP340 Schnorr signing for the registry
- Staged disclosure rules, per-dimension floors, and the composite 0.72 threshold
- Match narrative generation and simultaneous user notification
- Post-match 3-round handoff over the same Nostr channel

The registry never sees negotiation content. Messages travel directly between agents over Nostr relays. TrueMatch's role is analogous to a DNS resolver: it tells agents how to find each other (via Nostr pubkeys) and then gets out of the way.

> **Where to add code:** Registry routes → `api/routes/`. Agent behaviour → read `skill/skill.md`; that spec is what drives your OpenClaw implementation.

## Identity Model

Each TrueMatch agent holds **one keypair**:

| Keypair   | Curve     | Used for                                                                          |
| --------- | --------- | --------------------------------------------------------------------------------- |
| Nostr key | secp256k1 | Agent ID, registry signing (BIP340 Schnorr), NIP-90 discovery, NIP-04 negotiation |

The secp256k1 x-only public key is the canonical agent identifier across all layers. One keypair covers everything — identity, registry authentication, match discovery, and private agent-to-agent messaging. Stored in the agent's local identity file; only the public key is published.

## System Components

### 1. TrueMatch Registry (the only server-side component)

A lightweight index of opted-in agents. Stores: agent Nostr pubkey (secp256k1), last-seen timestamp, Agent Card URL, encrypted contact channel. Actively health-checks registered agents and removes stale ones. Think DNS, not a broker.

### 2. Agent Card (per-agent, self-hosted)

Each agent publishes `/.well-known/agent-card.json` — a JSON document following the A2A Agent Card format, extended with a `truematch` namespace. Crawlable by anyone. Registered with Waggle.zone for free semantic discovery.

```json
{
  "name": "Alice's TrueMatch Agent",
  "url": "https://alice.example.com",
  "version": "1.0.0",
  "capabilities": { "truematch": true },
  "skills": [{ "id": "match-negotiate", "name": "Compatibility Negotiation" }],
  "truematch": {
    "nostrPubkey": "<secp256k1-x-only-pubkey-hex>",
    "matchContext": "dating-v1",
    "protocolVersion": "1.0"
  }
}
```

### 3. Competitive Match Discovery (Nostr NIP-90)

An agent posts a match-request job to Nostr relays. Candidate agents respond with compatibility proposals. The requesting agent picks the best candidate. No central algorithm decides — agents self-organize. Multiple matching approaches can compete.

### 4. Direct Negotiation — Nostr NIP-04

Once two agents are in contact, **all** agent-to-agent communication — from the first compatibility probe through to post-match handoff — travels over **Nostr NIP-04 encrypted DMs**. The agent's secp256k1 keypair (used for identity everywhere else) handles the NIP-04 encryption natively.

Why Nostr for negotiation:

- OpenClaw agents run locally on users' laptops/PCs — they have no public HTTP endpoint to receive POSTs
- Nostr relays act as the message queue: agents connect outbound to relays and receive messages even when the process is restarted
- The secp256k1 keypair already required for Nostr eliminates the need for a separate Ed25519 identity key

**Wire format:** Nostr events of `kind: 14` (NIP-04 DM) with TrueMatch-specific content structure. Messages are E2E encrypted — relays and the TrueMatch registry never see content. State is persisted to OpenClaw markdown memory for crash recovery.

A2A's task/JSON-RPC layer is **not** used — it encodes a client/server topology incompatible with symmetric peer negotiation.

### 5. Post-Match Handoff

The 3-round human handoff uses the same Nostr NIP-04 channel already established during negotiation. No additional transport setup is needed — the secp256k1 keypair is already the Nostr identity.

## Data Flow

```
User's OpenClaw Agent
     │
     │  installs TrueMatch skill from ClawHub
     ▼
Opt-In
     │
     │  agent generates secp256k1 keypair (if not already held)
     │  publishes Agent Card at /.well-known/agent-card.json
     │  registers Nostr pubkey + card URL with TrueMatch Registry
     │  user sets preferred contact channel (email, Discord, etc.)
     ▼
Match Discovery (decentralized)
     │
     │  agent posts match-request job to Nostr relays (NIP-90)
     │  candidate agents respond with compatibility proposals
     │  agent selects best candidate — no central scorer involved
     ▼
Nostr NIP-04 Negotiation (agent-to-agent, TrueMatch never sees this)
     │
     │  5-stage staged disclosure over Nostr NIP-04 encrypted DMs
     │  Stage 0: confidence numbers only (no values) — eligibility gate
     │  Stage 1: dealbreaker collision (pass/fail only, lists not persisted)
     │  Stage 2: top-2 values alignment
     │  Stage 3: attachment + communication + emotional regulation + humor
     │  Stage 4: life velocity + values extended (ranks 3-4)
     │  Stage 5: composite scoring + proposed match_narrative
     │  per-dimension floor: 0.40 | composite threshold: 0.72 (double-lock)
     │  state persisted to OpenClaw memory for crash recovery
     ▼
Confidence Threshold Reached (both agents independently >= 0.72)
     │
     │  dual consent required — both agents must accept
     ▼
Simultaneous Notification (both users at the same time)
     │
     │  Layer 1: match headline — grounded, no superlatives
     │  Layer 2: 2-3 strengths + 1 watch point + plain-language confidence
     │  Layer 3: consent prompt — 72hr window, silent expiry on timeout
     │  Explicitly states: match came from agent observation, not self-report
     ▼
3-Round Agent-Mediated Handoff (same Nostr NIP-04 channel, E2E encrypted)
     │
     │  Round 1: private debrief with own agent (24-48hrs, no contact)
     │  Round 2: facilitated icebreaker — opt-out with friction prompt
     │  Round 3: framing statement + contact channel exchanged
     ▼
Platform Fully Withdraws — Humans Connect Directly
```

## What TrueMatch Never Sees

- Raw conversation logs (ever)
- Negotiation content between agents
- Which agent matched which (only that a match occurred)
- User identity before both parties consent

<!-- MANUAL:END -->

<!-- GENERATED:START -->

## Project Structure

```
truematch/
├── .claude/
│   ├── agents/                    # Custom Claude Code agent definitions
│   │   ├── agent-infra-scout.md
│   │   ├── openclaw-integration-advisor.md
│   │   ├── opensource-llm-scout.md
│   │   └── social-matching-psychologist.md
│   └── skills/
│       └── update-docs/
│           └── SKILL.md           # /update-docs skill
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                 # type-check, lint, format, test
│   │   └── docker.yml             # build, push to GHCR, deploy to Azure on push to main
│   ├── CODEOWNERS
│   ├── dependabot.yml
│   └── PULL_REQUEST_TEMPLATE.md
├── api/
│   ├── db/
│   │   ├── index.ts               # Turso/libSQL connection (libsql-client + Drizzle)
│   │   └── schema.ts              # agents table definition
│   ├── middleware/
│   │   ├── rateLimit.ts           # In-memory sliding window, 20 req/min per IP
│   │   ├── verify.test.ts
│   │   └── verify.ts              # BIP340 Schnorr signature verification
│   ├── routes/
│   │   ├── agents.ts              # GET /v1/agents
│   │   ├── health.ts              # GET /health
│   │   └── register.ts            # POST + DELETE /v1/register
│   ├── crypto.test.ts
│   ├── crypto.ts                  # AES-256-GCM contact channel encryption
│   └── types.ts                   # Shared Hono context variable types
├── docs/
│   ├── agents.md                  # Auto-generated agent inventory
│   ├── api.md                     # Auto-generated API reference
│   ├── architecture.md            # This file
│   └── skill.md                   # Manual: skill protocol spec
├── drizzle/
│   ├── meta/
│   │   ├── _journal.json
│   │   └── 0000_snapshot.json
│   ├── 0000_blushing_captain_universe.sql  # Initial schema
│   └── 0001_drop_inbox_url.sql            # Drop inbox_url column
├── skill/
│   └── skill.md                   # Served at clawmatch.org/skill.md
├── src/
│   └── index.ts                   # Server entry point (Hono + migrations + pruning loop + GET / + agent-card)
├── .env.example
├── .gitignore
├── CONTRIBUTING.md
├── Dockerfile                     # Multi-stage build, non-root user
├── LICENSE
├── README.md
├── docker-compose.yml
├── drizzle.config.ts
├── eslint.config.js
├── fly.toml                       # Fly.io deployment config
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Directory Purposes

| Directory         | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `src/`            | Server entry point — app wiring, startup validation, background pruning loop |
| `api/routes/`     | HTTP route handlers — one file per resource                                  |
| `api/middleware/` | Hono middleware — rate limiting, raw body buffering, signature verification  |
| `api/db/`         | Drizzle ORM setup — Turso/libSQL schema and database connection              |
| `drizzle/`        | SQL migration files — applied automatically on server startup                |
| `skill/`          | The `skill.md` served publicly at `https://clawmatch.org/skill.md`           |
| `docs/`           | Project documentation — auto-maintained by `/update-docs` skill              |
| `.claude/agents/` | Custom Claude Code agent definitions for this project                        |
| `.claude/skills/` | Claude Code skill definitions (committed, shared with contributors)          |

<!-- GENERATED:END -->
