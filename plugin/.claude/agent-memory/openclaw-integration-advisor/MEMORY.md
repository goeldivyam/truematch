# OpenClaw Integration Advisor Memory

## Key Architecture Facts (verified from source/docs)

### Cron Subsystem

- jobs.json lives at `~/.openclaw/cron/jobs.json` (state dir, NOT openclaw.json)
- NO file watcher on jobs.json. Reloaded on each timer tick via mtime comparison (`storeFileMtimeMs`)
- Manual edits to jobs.json are only safe when Gateway is STOPPED. Gateway can overwrite concurrent manual edits.
- Preferred mutation path: `openclaw cron add/edit` CLI or cron tool call API
- Per-job JSONL run logs at `~/.openclaw/cron/runs/<jobId>.jsonl`
- Verify scheduling: `openclaw cron list` shows `nextWakeAtMs`; `openclaw cron runs --id <jobId>` for history
- `cron.jobs` is NOT a valid openclaw.json key — causes validation error. Scheduler settings (cron.enabled, cron.maxConcurrentRuns) go in openclaw.json; job definitions go in jobs.json via CLI.
- See: cron-jobs.md

### sessionTarget Options

- `"main"`: enqueues system event into primary session heartbeat prompt. No new session created.
- `"isolated"`: spawns dedicated session namespaced `cron:<jobId>`. Each run gets a fresh session. No prior conversation carry-over.
- `announce` delivery is ONLY valid for isolated jobs.

### Isolated Session Delivery

- `delivery.mode: "announce"` posts via channel adapter directly (no main agent involvement)
- `delivery.channel`: whatsapp / telegram / discord / slack / signal / imessage / last
- `delivery.to`: channel-specific recipient (e.g., WhatsApp: "+15551234567")
- `delivery.bestEffort: true` downgrades delivery failures from error to ok status
- WhatsApp example: `--channel whatsapp --to "+15551234567"` in CLI

### Known Cron Bugs (historical, verify if fixed in your version)

- Issue #6217: isolated + agentTurn + deliver silently failed (fixed by PR #8540, ~Feb 2026)
- Issue #11994: isolated + agentTurn never fired; `nextWakeAtMs` null. Fixed in version 2026.2.6-3. Required full restart + wakeMode: 'now'.
- Issue #22298: isolated + announce fails with "pairing required" (1008 error). Fixed by PR #22838 (scope-upgrade auto-approval for loopback).
- Issue #3520: isolated session inherits delivery channel from main session history (fixed PR #10776, Feb 7 2026)
- Issue #13420: announce delivery ignores configured channel, routes to wrong channel. Fixed (closed "not planned" Feb 2026 via related PRs).
- If cron not firing: check `nextWakeAtMs` in `openclaw cron list`. If null, known scheduler bug — full restart required.

### Skill Loading

- Discovery locations (precedence high to low): workspace/skills > ~/.openclaw/skills > bundled
- Extra dirs via `skills.load.extraDirs` in openclaw.json (lowest precedence)
- `skills.load.watch: true` (default) watches skill folders for SKILL.md changes — picks up on next agent turn
- Changes to SKILL.md in watched dirs: hot-reloaded (no restart needed), effective on next agent turn
- Session snapshots: skills snapshot taken at session start, reused for that session's turns

### npm Package / Plugin Skill Discovery

- `npm install -g <package>` does NOT auto-register skills with OpenClaw
- Plugin system uses `openclaw.plugin.json` manifest. Plugins ship skills by listing skill dirs in manifest.
- OpenClaw scans: plugins.load.paths, .openclaw/extensions/, ~/.openclaw/extensions/, bundled
- Correct install path: `openclaw plugins install <package>` — extracts to ~/.openclaw/extensions/<id>/, enables in config
- After plugin install: GATEWAY RESTART REQUIRED to load plugin and its skills
- Alternatively: place SKILL.md folder into ~/.openclaw/skills/ manually (picked up by watcher without restart)

### Cron Schedule Schema (verified)

- Valid schedule types: `"at"` (one-shot), `"every"` (interval), `"cron"` (expression). "interval" is NOT valid.
- Correct 30-min interval: `{ "kind": "every", "everyMs": 1800000 }`
- The jobs.json in the TrueMatch repo uses `{ "type": "interval", "minutes": 30 }` — this is invalid schema. Must be `kind`, not `type`, and must use `everyMs` in ms.

### agent:bootstrap Hook (verified)

- Fires BEFORE workspace bootstrap files are injected. Allows hooks to mutate `context.bootstrapFiles`.
- Confirmed hooks: `agent:bootstrap`, `gateway:startup`, `command:new`, `command:reset`, `command:stop`, `message:received`, `message:transcribed`, `message:preprocessed`, `message:sent`, `tool_result_persist`
- Whether agent:bootstrap fires in isolated cron sessions is NOT documented. Treat as uncertain — do not rely on it firing in isolated runs.
- AgentSkills base spec does NOT include lifecycle hooks. agent:bootstrap is OpenClaw-specific.

### Announce Delivery Behavior (verified)

- Announce delivery fires ONLY when the isolated run produces meaningful content. Heartbeat-only responses (HEARTBEAT_OK with no real content) are silently dropped.
- If isolated run already sent to target via message tool, delivery is skipped (dedup).
- This means: announce on a background matching loop WILL fire on most runs (agent produces output reporting on what it did), NOT only on confirmed matches.

## Source References

- Cron docs: https://docs.openclaw.ai/automation/cron-jobs
- Skills docs: https://docs.openclaw.ai/tools/skills
- Skills config: https://github.com/openclaw/openclaw/blob/main/docs/tools/skills-config.md
- Cron source analysis: https://deepwiki.com/openclaw/openclaw/2.5-cron-service
- Skills source analysis: https://deepwiki.com/openclaw/openclaw/6.4-skills-system
- Plugin docs: https://www.learnclawdbot.org/docs/plugin
