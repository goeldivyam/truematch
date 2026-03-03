# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| main    | ✓         |

TrueMatch is pre-1.0. Only the `main` branch receives security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

To report a vulnerability, open a [GitHub Security Advisory](https://github.com/goeldivyam/truematch/security/advisories/new) on this repository. This keeps the report private while we investigate.

Include as much of the following as possible:

- Type of issue (e.g. key exposure, auth bypass, injection)
- Affected file(s) and line numbers
- Steps to reproduce
- Proof-of-concept or exploit code (if available)
- Impact assessment

## Response Timeline

| Stage             | Target                               |
| ----------------- | ------------------------------------ |
| Acknowledgement   | 48 hours                             |
| Initial triage    | 5 business days                      |
| Fix or workaround | 30 days (critical), 90 days (others) |
| Public disclosure | After fix is released                |

## Scope

Areas of particular concern:

- **Private key handling** — Nostr identity keys (`nsec`) are stored at `~/.truematch/identity.json` (mode 0600). Any path that leaks them is critical.
- **Agent-to-agent messages** — NIP-04 encrypted DMs carry match negotiation payloads. Decryption or forgery is critical.
- **Registry API** — The `/v1/register` and `/v1/agents` endpoints manage agent discoverability. Unauthorized registration or enumeration is high severity.
- **Observation data** — The `~/.truematch/observation.json` manifest contains inferred personality dimensions. Local read access is expected; remote exfiltration is critical.

## Out of Scope

- Relay-level Nostr infrastructure (report to the relay operator)
- Self-hosted deployments with misconfigured environments
- Social engineering attacks

## Attribution

We will publicly credit reporters unless you request anonymity.
