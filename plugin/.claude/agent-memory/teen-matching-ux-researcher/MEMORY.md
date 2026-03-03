# Teen Matching UX Researcher — Agent Memory

## Key Research Reports (with dates)

- Pew Research Center, "Teens, Social Media and Technology 2024" (Dec 2024) — teens avg 240 push notifications/day
- Common Sense Media, teen notification volume study (cited 2024) — 50% of 11-17yo get 237+ notifications/day
- Morning Consult, Gen Z AI Trust (2024–2025) — 62% of Gen Z wary of AI; 43% mistrust vs 26% trust AI acting autonomously
- Smashing Magazine, "Designing For Agentic AI: Practical UX Patterns" (Feb 2026) — concrete agent UX pattern library
- Smashing Magazine, "Design Guidelines For Better Notifications UX" (Jul 2025) — fewer notifications = higher satisfaction
- UXmatters, "Designing for Autonomy: UX Principles for Agentic AI" (Dec 2025) — Autonomy Dial framework
- UXmatters, "Designing Calm: UX Principles for Reducing Users' Anxiety" (May 2025) — "silence is not calming; it is ambiguous"; "forgiving interactions" reduce anxiety
- UX Magazine, "Secrets of Agentic UX" (2025) — asynchronous agent patterns, supervisor/worker model
- ScienceDirect, "Key role of design and transparency in trust in AI agents" (2025)
- allaboutai.com, "Gen Z's Approach to AI and Privacy" (2025) — 70% concerned about data use
- Facebook internal research (cited in Smashing Jul 2025): fewer notifications improved long-term engagement
- Capgemini, "Rise of Agentic AI: How Trust Is the Key" (Jul 2025) — trust in fully autonomous AI agents dropped 43% to 27% in one year; 63% found agents needed more supervision than expected
- CIO.com, "Agentic AI Has Big Trust Issues" (2025) — only 8% comfortable with full autonomy; black-box reasoning is primary trust failure
- First Page Sage, "Agentic AI Statistics: 2026 Report" (2025-2026) — 7,800+ user survey; 18% followed up after successful completions; 54% trust manual results more than agentic
- NNGroup, "Designing for Long Waits and Interruptions" (evergreen, 2024-2025) — 10 second threshold before users lose confidence; progress indicator extends tolerance 2.5x
- NNGroup, "Progress Indicators Make a Slow System Less Insufferable" (evergreen) — users with progress bar waited 22.6s vs 9s without
- wingedapp.com, "Match Messaging Mastery: The Essential Guide for 2025" (2025) — OkCupid data: specificity lifts reply rates 32%
- DatingPro.com, "Post-Match Silence in Dating Apps" (2025) — post-match silence is the dominant retention failure in dating apps
- contentgrip.com / Hinge, "AI Convo Starters" (Dec 2025) — AI as confidence booster, not replacement; AI suggests, user speaks in own voice
- ContextSDK, "The Psychology Behind Successful Push Notifications" (2025) — personalized notifications 2.25x reaction rate (9% vs 4%)
- tearthemdown.substack.com, "6 Product Lessons from BeReal" (2024-2025) — users should see value before being asked to act; onboarding carousels are skipped

## Confirmed Behavioral Patterns

### Agentic AI Notification Design

- "Intent Preview" before any autonomous action: agent states what it WILL do before doing it
- Interrupt threshold: only interrupt for (a) uncertainty requiring user input, (b) out-of-scope conditions, (c) confirmed significant outcomes — NOT intermediate steps
- Post-action format: Action + Reasoning tied to user preference + Recovery option (e.g., Undo)
- Notification fatigue: start low-volume, increase only if user pulls for more; digest > individual alerts
- "Silence creates anxiety, invisibility breeds uncertainty" — agents need passive status presence, not active pings
- Progressive modes: Observe & Suggest / Plan & Propose / Act Autonomously (Autonomy Dial)

### Gen Z / Teen AI Trust

- 43% mistrust vs 26% trust AI acting on their behalf autonomously (Morning Consult 2024-2025)
- Trust maintained: transparency about data, tangible value delivered, user retains control
- Trust broken: surveillance without consent, black-box decisions, persistent data without disclosure
- 70% of Gen Z express concern about how AI uses their personal data
- 18% stopped using a brand/service because of distrust in their AI use — highest of any generation
- Comfort with AI dropped sharply: 47% to 34% among 18-24yo between 2024 and 2025 (YouGov)

### Dating App UX Context

- Hinge AI Core Discovery lifted matches 15% — kept AI invisible, surfaced as "better matches"
- Hinge Convo Starters (Dec 2025): AI suggests, user speaks in their own voice — AI as confidence booster not replacement
- Bumble AI (Feb 2026): profile/photo feedback — advisory not autonomous
- Hinge CEO leaving to start "AI-first dating app" Overtone (Dec 2025) — signals industry direction
- 60% of daters use AI tools as of 2025 (SoulMatcher, 2025)
- Dating fatigue affects 50% of users (Psychology Today, cited 2024)
- Post-match silence (gap between match and first message) is the dominant retention failure — DatingPro.com 2025
- "Aha moment" structure for match reveal: [user's own observed behavior] + [how that mirrors the match] = recognition, not information
- "Want a quick look?" outperforms "Want to see more?" — exploration framing reduces hesitation vs. decision framing

## Key TrueMatch-Relevant Patterns (link to detailed notes)

- See: `autonomous-agent-notification-ux.md` — full framework for start/update/match notification design
- See: `gen-z-ai-trust.md` — trust calibration patterns specific to teen audience

## Regulatory Notes

- COPPA applies to under-13; 13-17 protected by various state laws (TX, FL, UT age verification laws 2024)
- EU DSA designates platforms used by minors as higher-risk category
- Teen-facing matching apps face heightened regulatory scrutiny — transparency requirements may be legally mandated, not just best practice
