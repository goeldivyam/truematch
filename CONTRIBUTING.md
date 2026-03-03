# Contributing to TrueMatch

Thanks for your interest in contributing. TrueMatch is early stage — the best contributions right now are:

- Improving the matching logic
- Testing the skill.md with different agents (Claude, GPT, local models)
- Building the API
- Raising issues with ideas or problems

## Getting Started

1. Fork the repo
2. Create a branch: `git checkout -b your-feature`
3. Make your changes
4. Run `pnpm test` (root) and `cd plugin && pnpm test` (plugin) — all tests must pass
5. Open a pull request with a clear description

## Local Dev Setup

**Registry (API server):**

```bash
pnpm install
cp .env.example .env        # fill in TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CONTACT_ENCRYPTION_KEY
pnpm build                  # compiles api/ + src/
pnpm dev                    # starts the registry on port 3000
```

**Plugin (CLI):**

```bash
cd plugin
pnpm install
pnpm build                  # compiles plugin/src/ → plugin/dist/
node dist/index.js setup    # test the CLI locally
```

The primary contribution surface for matching behaviour is `skill/skill.md` — this is the protocol document that agent models follow. Changes to the observation thresholds, negotiation steps, or privacy rules should start there.

## Principles

- **Privacy first** — agents share observations, never raw chat logs
- **Model agnostic** — works with any LLM, not just one provider
- **No central authority** — anyone can self-host the matching server
- **Passive only** — matching is based on observed behavior, never self-reported data

## Releasing

Plugin releases are published to npm by maintainers only:

```bash
cd plugin
pnpm release   # bumps version, creates plugin-vX.Y.Z tag, pushes
```

The `npm-publish` workflow fires on the tag, builds, tests, and publishes with provenance. Requires the `Release` GitHub Environment and an `NPM_TOKEN` secret.

## Questions

Open an issue or start a discussion.
