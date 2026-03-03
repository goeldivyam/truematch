# Social Matching Psychologist — Agent Memory

## Key Files

- `skill/skill.md` — Full agent negotiation protocol spec (served at clawmatch.org/skill.md)
- `plugin/src/types.ts` — All TypeScript types (9 dimensions, NegotiationState, etc.)
- `plugin/src/observation.ts` — DIMENSION_FLOORS, isEligible, eligibility logic
- `plugin/src/signals.ts` — Signal engine (timing, quiet periods, dimension labels)
- `plugin/src/negotiation.ts` — Thread state machine (MAX_ROUNDS=10, double-lock)
- `docs/architecture.md` — Architecture overview and data flow diagram

## Accepted Frameworks

### Dimension Taxonomy (Tier 1 / 2 / 3)

Established in session 2026-03-03. See `negotiation-protocol.md` for full detail.

- Tier 1 (earliest termination signals): dealbreakers, core_values, life_velocity
- Tier 2 (high-weight, rounds 2-4): attachment, conflict_resolution, emotional_regulation
- Tier 3 (important but later-resolving): communication, interdependence_model, humor

### Minimum Viable Evidence (MVE) Threshold

Formalized 2026-03-03. Proposal warranted at round >=3 when Tier 1+2 dims clear MVE floors.
Details in `negotiation-protocol.md`.

### Proposal Round Window

- Round 3: earliest defensible proposal
- Rounds 4-5: primary proposal window
- Rounds 6-7: justified only for a single remaining uncertain dimension
- Rounds 8-10: warning zone — protocol failure if reached without proposal

### False Positive vs. False Negative Asymmetry

Double-lock mechanism structurally protects against worst false positive outcomes.
Current protocol over-weights false positive prevention, systematically inflating false negatives.
Recommendation: lower proposal bar; use double-lock as the protection mechanism.

## Foundational Research Citations

- Simpson et al. (2007, JPSP) — attachment as strongest longitudinal predictor
- Gottman (1994) — conflict style predicts dissolution with 93.6% accuracy
- Sagiv & Schwartz (1995, EJSP) — values alignment predicts satisfaction independently of personality
- Ambady & Rosenthal (1992, Psych Bulletin) — thin slices; diminishing returns after first good observations
- Gross (1998, Review of General Psychology) — emotional regulation as moderating variable
- Carstensen (1992, Psych & Aging) — socioemotional selectivity; life phase divergence compounds
- Martin (2007) — adaptive vs. maladaptive humor more important than style identity
- Baxter & Montgomery (1996) — connection-autonomy dialectic (interdependence_model basis)
- Bartholomew & Horowitz (1991) — 4-category attachment model (used in dimension 1)
- Schwartz (1992) — values theory (used in dimension 2)

## Opt-In Psychology Decisions (Session 2026-03-03)

- Largest opt-in barrier: loss of self-presentation control (Leary & Kowalski 1990), not privacy fear
- Required minimum at opt-in moment: (1) one demonstrated behavioral observation, (2) one-sentence
  identity privacy guarantee, (3) one-sentence exit guarantee
- Mechanism: surfacing one high-confidence behavioral observation before "start truematch" activates
  self-verification (Swann 1990) and reduces abstract-benefit anxiety
- HARD CONSTRAINT: no form, questionnaire, or self-report prompt at opt-in — contradicts premise
- Open gap: signal engine needs to flag highest-confidence dimension for opt-in surfacing

## Match Notification Structure Decision (Session 2026-03-03)

Notification now has 4 layers (was 3), in this order:

1. Recognition hook — one behavioral observation about the USER, from highest-confidence dim
2. Headline — one sentence grounded in observed alignment (was layer 1)
3. Evidence — 2-3 strengths, 1 watch point, confidence summary (was layer 2)
4. Consent question — "What's one thing you'd want to know about them?" (changed from "curious about")

Peer reveal at notification: one behavioral fact about peer that mirrors/complements recognition hook;
no identifying information. Rationale: Aron et al. (1992) inclusion-of-other-in-self — self-similarity
on core dimensions accelerates felt connection.

Schema gap: PendingNotification in types.ts needs `recognition_dimension` + `recognition_hook_text`
fields. HandoffState needs `proposal_round` field to calibrate Round 1 debrief by confidence level.

## Quick Match / Minimum Viable Profile (Session 2026-03-03)

4-dimension MVP for quick-match pool entry (separate from full 9-dim eligibility):

- dealbreakers: 0.60 (hard gate, unchanged)
- attachment: 0.55 (Simpson et al. 2007 — strongest longitudinal predictor)
- conflict_resolution: 0.55 (Gottman 1994 — 93.6% accuracy on single dimension)
- core_values: 0.50 (lowered from 0.55 — Sagiv & Schwartz 1995)
  Deferred to negotiation: emotional_regulation, life_velocity, communication, humor, interdependence_model
  Implementation: add isMinimumViable() to observation.ts alongside isEligible()
  Key principle (Ambady & Rosenthal 1992): depth on right 2 dims beats breadth across all 9

## Watch Point / False Positive Framing Decision (Session 2026-03-03)

For early proposals (rounds 3-4), watch point must name the confidence gap explicitly, not a known
friction point. Example: "My read on [dim] is still forming — worth exploring early."
Rationale: contrast effect (Kahneman 2011) — expectations set without epistemic humility make
subsequent friction feel like betrayal. Anchoring uncertainty upfront recalibrates without deflating.
Rule: still exactly 1 watch point regardless of proposal round. Multiple watch points trigger
alarm response per Holmes & Rempel (1989) trust research.
Protocol connection: the answer to pre-termination check Q3 ("least confident dimension and why")
must be sourced directly as the watch point for early proposals. Currently unconnected in skill.md.

## Protocol Review Findings (Session 2026-03-03 — Full Review)

See `protocol-review-2026-03-03.md` for full issue table and rationale.

### Critical Issues

- docs/skill.md MISSING the recognition hook entirely — notification starts with headline, no personal
  observation. This breaks the aha moment premise for any agent following the public spec.
- docs/skill.md curiosity question wording: "most curious about" vs SKILL.md "want to know about them"
  — SKILL.md version is better (other-directed). Needs sync.

### Important Issues (unresolved)

- isMinimumViable() in observation.ts does NOT match SKILL.md proposal MVE definition.
  Code checks: dealbreakers + attachment + conflict_resolution + core_values (4 dims)
  SKILL.md checks: T1 pass + T2 floors (includes emotional_regulation). Undocumented asymmetry.
- core_values floor hardcoded 0.5 in isMinimumViable() line 84 — should reference DIMENSION_FLOORS
- emotional_regulation excluded from MVE without documentation or agent-facing explanation
- Opening message requires inferred intent disclosure with no confidence gate; should require
  confidence ≥ 0.65 on life_velocity before disclosing intent (already correct in types.ts comment,
  not enforced in SKILL.md)
- Recognition hook in notification: no constraint on which dimension is used. emotional_regulation
  and conflict_resolution can produce unsafe/critical-sounding observations. Needs priority order:
  prefer core_values, humor, life_velocity for hook; emotion dims only if observation is positive.
- Signal threshold formula: MIN_SIGNAL_CONFIDENCE (0.40) dominates for low-floor dims (humor,
  life_velocity, interdependence_model) — floor\*0.75 formula does nothing for them. Raises risk
  of generic signals. Consider raising floor to 0.45 and adding min observation_count gate.
- No pickOptInSignal() in signals.ts — opt-in recognition hook has no implementation path.
  Need separate function that ignores delta/quiet period and returns highest-confidence dim >= 0.45.
- Round 1 debrief not calibrated to proposal_round — HandoffState has proposal_round field but
  SKILL.md doesn't branch on it for Round 1 debrief content.
- Expired match: consenting user gets no status update. Agent should surface brief update at expiry
  ("that match didn't move forward — continuing to look").
- dealbreaker_gate_state "positively observed open" path: types.ts comment mentions it but SKILL.md
  gives Claude no instruction on how to reach confirmed state without naming a constraint.
  Genuinely dealbreaker-free users are effectively blocked from pool entry.
- Icebreaker in Round 2 disconnected from curiosity question quality — needs branching rule:
  specific probe → use directly; vague response → fall back to values/communication style.

### Minor Issues (unresolved)

- "Grown since last named" signal text is false on first signal — needs wording branch
- Round 3 pacing unspecified in post-match handoff
- observation_span_days "2 days" semantics ambiguous — means spans 3 calendar days; needs doc
- Single notification example in SKILL.md is startup-founder specific — Claude will overfit to it

## Open Research Questions

- What is the actual round distribution for proposed vs. non-proposed threads in simulate.mjs?
- Is the 0.74 composite threshold independently validated or set heuristically?
- How does the protocol handle asymmetric confidence between agents (one high, one low)?
- At what proposal round does the watch point shift from "known friction" to "confidence gap" framing?
  Current answer: rounds 3-4 = gap framing; rounds 5+ = known friction framing. Needs validation.
- Does raising MIN_SIGNAL_CONFIDENCE to 0.45 + adding observation_count gate materially improve
  signal specificity without delaying the cold-start retention anchor?
