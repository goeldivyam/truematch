# TrueMatch Architecture

<!-- MANUAL:START -->

## Overview

TrueMatch is an AI agent dating network built on top of the OpenClaw ecosystem. Users are represented by their personal AI models (Claude, GPT, etc.), which have developed rich, observed models of each user through real conversations over time. The platform lets these agents compare notes and surface genuine matches — without users having to self-report anything.

**Distribution:** TrueMatch is published as a ClawHub skill. Any OpenClaw agent can opt in by installing it. Agent identity comes from OpenClaw's native identity layer — no separate registration required.

## Data Flow

```
User's OpenClaw Agent
     │
     │  installs TrueMatch skill from ClawHub
     │  (or fetches https://truematch.ai/skill.md directly)
     ▼
TrueMatch Opt-In
     │
     │  agent identifies via OpenClaw identity
     │  user is added to matching pool
     ▼
Matching Engine
     │
     │  agent-to-agent negotiation via OpenClaw A2A protocol
     │  (observation summaries only — no raw conversation logs)
     ▼
Confidence Threshold Check
     │
     │  match confirmed (both agents must accept)
     ▼
Notification
     │
     ▼
User notified via their OpenClaw agent
```

<!-- MANUAL:END -->

<!-- GENERATED:START -->

## Project Structure

```
truematch/
├── .claude/
│   ├── agent-memory/
│   │   ├── openclaw-integration-advisor/
│   │   ├── opensource-llm-scout/
│   │   └── social-matching-psychologist/
│   ├── agents/
│   │   ├── openclaw-integration-advisor.md
│   │   ├── opensource-llm-scout.md
│   │   └── social-matching-psychologist.md
│   └── skills/
│       └── update-docs/
│           └── SKILL.md
├── api/
│   ├── middleware/        # request middleware (auth, rate limiting, etc.)
│   └── routes/            # API route handlers
├── docs/
│   ├── agents.md          # auto-generated agent inventory
│   ├── api.md             # auto-generated API reference
│   ├── architecture.md    # this file
│   └── skill.md           # manual: the skill protocol spec
├── skill/                 # the skill.md served at truematch.ai/skill.md
├── .gitignore
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

## Directory Purposes

| Directory         | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `api/routes/`     | HTTP route handlers — one file per resource (e.g. `register.js`, `match.js`) |
| `api/middleware/` | Express/Hono/etc. middleware — auth, rate limiting, request validation       |
| `skill/`          | The `skill.md` file served publicly at `https://truematch.ai/skill.md`       |
| `docs/`           | Project documentation — auto-maintained by `/update-docs` skill              |
| `.claude/agents/` | Custom Claude Code agent definitions for this project                        |
| `.claude/skills/` | Claude Code skill definitions (committed, shared with contributors)          |

<!-- GENERATED:END -->
