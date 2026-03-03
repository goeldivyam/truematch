# Negotiation Protocol Decisions

## Session: 2026-03-03

**Question:** What changes to the negotiation protocol would produce faster, higher-quality match proposals?

---

## Dimension Priority Tiers

### Tier 1 — Early Termination Signals (evaluate by round 1-2)

| Dimension     | MVE Confidence           | Research Basis                                                     |
| ------------- | ------------------------ | ------------------------------------------------------------------ |
| dealbreakers  | gate_state: confirmed    | Binary gate — already correct                                      |
| core_values   | >= 0.70                  | Sagiv & Schwartz (1995): top-2 values misalignment is irreversible |
| life_velocity | >= 0.65 (intent aligned) | Carstensen: life phase divergence compounds over time              |

### Tier 2 — High-Weight Signals (primary negotiation, rounds 2-4)

| Dimension            | MVE Confidence         | Research Basis                                             |
| -------------------- | ---------------------- | ---------------------------------------------------------- |
| attachment           | >= 0.60                | Simpson et al. (2007): strongest longitudinal predictor    |
| conflict_resolution  | >= 0.55, no Escalating | Gottman (1994): 93.6% dissolution accuracy                 |
| emotional_regulation | >= 0.55                | Gross (1998): moderating variable for all other dimensions |

### Tier 3 — Important But Later-Resolving (rounds 3-5, not required for MVE)

| Dimension             | Acceptable Floor | Notes                                                         |
| --------------------- | ---------------- | ------------------------------------------------------------- |
| communication         | >= 0.50          | Adaptation possible; weight complementarity over identity     |
| interdependence_model | >= 0.45          | Often inferred from other signals                             |
| humor                 | >= 0.45          | Adaptive vs. maladaptive gap matters more than style identity |

---

## Minimum Viable Evidence (MVE) Threshold

A proposal is warranted at round >= 3 when ALL of the following are true:

1. All Tier 1 dimensions clear their MVE floors
2. All Tier 2 dimensions clear their MVE floors
3. No active incompatibilities detected
4. Pre-termination capability check passes (strongest reason for, against, least confident dimension)

Tier 3 dimensions NOT required for MVE. Include uncertainty as watch_point in narrative instead.

---

## Round-by-Round Proposal Readiness

- **Round 1**: Dealbreakers, values, life phase disclosed. Early termination if any fail. No proposal yet.
- **Round 2**: First peer behavior signals on communication and emotional tone. Proposal only if everything is exceptionally strong with peer attachment disclosure.
- **Round 3**: Earliest proposal window. Requires full MVE check pass.
- **Rounds 4-5**: Primary proposal window. Most negotiations should resolve here.
- **Rounds 6-7**: Extended exploration justified only for one specific uncertain dimension.
- **Round 7 checkpoint**: Forced MVE check. If met, propose. If not, identify single blocking dimension.
- **Rounds 8-10**: Warning zone — something in the protocol has gone wrong if reached without proposal.

---

## Recommended Protocol Changes

### 1. Add MVE Check to Proposal Decision Tree

After round 2, explicitly evaluate MVE threshold before defaulting to another probe question.
If MVE met: proceed to counter-argument pass, then propose.

### 2. Round-4 Proposal Nudge

At round 4, if no proposal and no active incompatibilities: shift default from "ask question" to "evaluate for proposal."

### 3. Relax Epistemic Asymmetry Rule for Tier 3

The gap > 0.30 pause should apply to Tier 1+2 only. Tier 3 asymmetry → include as watch_point, not proposal blocker.

### 4. Round-Budget Awareness

At round 7 (3 remaining): forced MVE check. Either propose (if met) or ask one targeted question on single blocking dimension. No further general conversation.

### 5. Double-Lock Signal in Guidance

Add to skill.md: receiving a peer match_propose when MVE is met is a strong signal to run own proposal evaluation immediately. Peer confidence is evidence, not a constraint.

---

## False Positive vs. False Negative Asymmetry

**False positive cost in TrueMatch:** Lower than typical platforms due to double-lock.

- One-sided premature proposal costs nothing; waits for or fails to receive peer proposal.
- Confirmed premature match attenuated by: 3-round graduated handoff, explicit watch point, observation-based framing, no-superlatives narrative.

**False negative cost:** Higher and compounding.

- Irreversible under 10-round cap — pair cannot retry on same thread.
- High false negative rate causes churn among most committed users (Gresham's Law of matching).
- Round cap + excessive probing = match annihilation mechanism.

**Policy conclusion:** Lower proposal bar. Use double-lock as protection. Early proposals + double-lock = correct risk calibration.

**Research support:** Ambady & Rosenthal (1992) thin slices — diminishing returns after first high-quality observations. Agent enters negotiation with deep prior from months of user behavior. Marginal value of rounds 6-10 is substantially lower than rounds 1-4.
