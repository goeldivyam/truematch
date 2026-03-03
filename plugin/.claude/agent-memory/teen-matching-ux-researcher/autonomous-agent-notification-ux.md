# Autonomous Agent Notification UX — Research Notes

## The Three-Phase Model (synthesized from sources)

### Phase 1: Start Acknowledgment ("Intent Preview")

- Agent should state intent BEFORE acting, not after
- Format: what it WILL do + what it will NOT do (scope boundary) + when they'll next hear from it + "nothing is final until you confirm" safety signal
- Tone: collaborative, not declarative — "I'm going to..." not "I have begun..."
- Detail level: max 3 sentences total; longer messages trigger "terms of service" mental model in conversational interfaces
- Trust forms within 5 seconds in conversational UI — tone of the acknowledgment sets the entire relationship frame
- BeReal lesson (2024-2025): onboarding is the product working, not an explanation of how it works. The acknowledgment must demonstrate value (agent understood intent), not explain the system.
- Source: Smashing Magazine Feb 2026, UXmatters Dec 2025, BeReal product case study (tearthemdown 2024-2025)

### Phase 2: Background Updates (Interrupt Threshold)

- Default: SILENT unless one of three conditions is met:
  1. Uncertainty — agent hit a condition it cannot resolve without user input
  2. Out-of-scope — something happened outside the pre-authorized parameters
  3. Significant positive signal — confirmed outcome worthy of interruption (not intermediate steps)
- Do NOT interrupt for: round completions, partial signals, peer agent check-ins, probabilistic progress
- "Passive presence" pattern: maintain a status surface the user can PULL (not push) — e.g., a log they can check
- DO NOT send proactive silence-breakers ("still working on it") — this trains users to classify the channel as low-signal and mute it
- INSTEAD: communicate at opt-in that silence = working, and enable a pull pattern ("message 'status' to check in")
- Silence window tolerance: UI research shows 10 seconds before anxiety without feedback. Multi-day async has a different threshold, but the mechanism (uncertainty = anxiety) is the same. A pull-accessible status surface likely extends tolerance 2-3x — this is inferred from progress bar research, not directly studied.
- Trust in fully autonomous AI agents dropped from 43% to 27% in one year (Capgemini, July 2025) — the silence window must be framed as a feature at opt-in, not discovered by the user as absence
- 63% of users found agents needed more supervision than expected (Capgemini July 2025 / CIO.com 2025)
- 18% of users who successfully completed background tasks felt the need to follow up — confirming most users accept outcomes once delivered (First Page Sage, 2025-2026)
- Source: UX Magazine 2025, Smashing Magazine Feb 2026, Capgemini July 2025, CIO.com 2025, NNGroup 2024-2025

### Phase 3: Confirmed Match Notification

- Format: Result + Reasoning anchored in user's own OBSERVED BEHAVIOR (not self-reported preferences) + Single low-stakes CTA
- Do NOT: dump match data, explain the technical process, use probability language ("87% match"), use "Want to see more?" (implies a decision)
- DO: connect the match to something specific the user DID or SAID; use "Want a quick look?" (implies exploration, lower commitment threshold)
- The "aha moment" structure: [something the user did or said] + [how that mirrors the match]. This is recognition, not information.
- Recovery option must be present: ability to ask for more info before committing to next step
- Tone: warm, brief, "your AI did its job" — not triumphant or clinical
- Personalized notifications produce 2.25x higher reaction rates than generic (9% vs. 4% average) — Pushwoosh/ContextSDK 2025
- OkCupid internal data: specificity in match messaging lifts reply rates 32% vs. generic compliments — cited in wingedapp.com 2025
- Post-match silence is the dominant retention failure in dating apps: "a huge share of matches never turn into conversations" — DatingPro.com 2025; gating the reveal behind a CTA prevents this by requiring active user choice
- Source: Smashing Magazine Feb 2026, wingedapp.com 2025, DatingPro.com 2025, ContextSDK 2025

## The "Surveillance vs. Informed" Balance

- Teens are acutely aware of data use and autonomy loss (70% express concern — allaboutai.com 2025)
- Surveillance feeling is triggered by: too many updates, updates about things user didn't authorize, unexplained data references
- Trust feeling is triggered by: updates that reference the user's own words back to them, clear scope, easy pause/stop mechanism
- The difference between being informed and being surveilled is often just: did the user OPT IN to this level of detail?
- Source: UXmatters Dec 2025, Morning Consult Gen Z AI trust 2024-2025

## Notification Fatigue — Teen-Specific Context

- Teens receive avg 240 push notifications/day (Pew/Michigan Medicine 2024)
- Any new notification source must justify itself within 1-2 notifications or it will be muted/ignored
- Agent notifications that carry low signal-to-noise will be mentally categorized as spam within days
- Recommendation from Smashing Jul 2025: fewer notifications = higher long-term engagement (Facebook internal data)
- Digest over stream: one meaningful update beats five incremental ones

## WhatsApp/Conversational Channel Constraints

- Text-only = no visual affordances (no buttons, badges, progress bars natively)
- Tone carries more weight — formality signals trustworthiness, but over-formality signals bot
- Short messages (<3 sentences) perform better; longer messages feel like terms-of-service
- Lists instead of buttons for multi-option moments
- Emoji use: acceptable for 13-19yo demographic; use sparingly in trust-critical moments
- Source: Landbot WhatsApp bot design guide (2024-2025)
