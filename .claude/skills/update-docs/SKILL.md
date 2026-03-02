---
name: update-docs
description: Scans the codebase and updates project documentation to reflect the current state of the code. Run periodically after shipping features, adding routes, or changing the skill protocol. Never run automatically — always requires explicit invocation.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Bash(git log *), Bash(git diff *), Bash(find * -not -path */.git/*)
argument-hint: "[scope: all|api|readme|agents — defaults to all]"
---

# Update Docs

Scan the TrueMatch codebase and update all documentation to reflect the current state of the code.

## Live Context

Recent commits:
!`git log --oneline -20 2>/dev/null || echo "(no git history)"`

Files changed since last tag (or last 10 commits if no tags):
!`git diff --name-only $(git describe --tags --abbrev=0 2>/dev/null || git rev-parse HEAD~10 2>/dev/null || echo HEAD) HEAD 2>/dev/null | head -40 || echo "(could not determine changed files)"`

Scope requested: $ARGUMENTS (if empty, run all sections)

---

## What This Skill Does

1. Audits every `docs/` file against the actual codebase
2. Regenerates stale auto-managed sections using `<!-- GENERATED:START/END -->` markers
3. Leaves all `<!-- MANUAL:START/END -->` blocks and unmarked narrative untouched
4. Creates stub files for expected docs that don't exist yet
5. Prints a structured summary of every change made

---

## Step 1 — Inventory the Codebase

Read the following and build an internal picture of what exists:

**Code:**
- `api/routes/` — every route file: HTTP methods, paths, handler names, JSDoc summaries
- `api/middleware/` — every middleware: what it does, headers/errors it handles
- `skill/` — skill.md and any supporting files: what protocol it defines
- Root: `README.md`, `CONTRIBUTING.md`, `package.json` (or equivalent manifest)

**Docs:**
- `docs/` — every file (note which have `<!-- GENERATED -->` markers and which don't)
- `.claude/agents/` — agent definition files (name and description frontmatter)

For each source file extract:
- Exported functions / route handlers / middleware names
- JSDoc / docstring summaries if present
- File-level purpose comment if present

---

## Step 2 — Evaluate Each Doc File Against the Doc Contract

### `docs/architecture.md`

**Auto-maintained sections:**
- Directory tree of all non-trivial project files (regenerate from filesystem every run)
- One-line description of each top-level directory's purpose
- Data flow diagram in ASCII or Mermaid: `agent → API → matching logic → notification`

**Never overwrite:** anything between `<!-- MANUAL:START -->` / `<!-- MANUAL:END -->`

**Staleness trigger:** any file in `api/routes/` or `api/middleware/` not mentioned in `architecture.md`

---

### `docs/api.md`

**Auto-maintained sections:**
- One entry per route in `api/routes/`: method, path, description, request body, response shape
- One entry per middleware in `api/middleware/`: purpose, what it injects or modifies
- Wrap the entire generated block in `<!-- GENERATED:START -->` / `<!-- GENERATED:END -->`

**When a route has no JSDoc:** insert `<!-- TODO: add description for METHOD /path -->`

**Staleness trigger:** any route in code with no corresponding entry in `docs/api.md`

---

### `docs/skill.md`

**This is a MANUAL document.** It describes the TrueMatch skill protocol that external agents load from `https://truematch.ai/skill.md`. Never overwrite it.

- If it doesn't exist: create a stub with the structure below and `<!-- TODO -->` placeholders
- If it exists: read it, check for internal consistency (e.g. mentions routes that no longer exist), but do not edit — report issues only

Stub structure if creating:
```markdown
# TrueMatch Skill Protocol

<!-- TODO: Describe the registration flow -->

## Registration

<!-- TODO -->

## Matching Protocol

<!-- TODO -->

## Privacy Guarantees

<!-- TODO: What data is shared between agents vs. withheld -->
```

---

### `docs/agents.md`

**Fully auto-generated** from `.claude/agents/` frontmatter on every run.

For each `.md` file in `.claude/agents/`:
- Extract the `name` (or derive from filename) and `description` fields
- Write one entry: agent name as heading, description as paragraph, intended use cases if present

Wrap the entire file content in `<!-- GENERATED:START -->` / `<!-- GENERATED:END -->`

**Staleness trigger:** any agent file not listed in `docs/agents.md`

---

### `README.md`

**Sections to leave alone:** tagline, problem/solution narrative, "How It Works", status, contributing, license.

**One auto-maintained section:** `## API Endpoints` — a simple list derived from `docs/api.md`. Only update this list if routes have been added or removed. If the section doesn't exist yet in README.md and routes exist, add it before the "## Status" section.

---

### `CONTRIBUTING.md`

**Do not auto-edit.** Only flag issues for human review:
- If a directory path mentioned in `CONTRIBUTING.md` no longer exists in the filesystem, report it as STALE
- Do not rewrite any content

---

## Step 3 — Apply Updates Using Marker-Based Replacement

**For files with `<!-- GENERATED:START -->` / `<!-- GENERATED:END -->` markers:**
1. Find the markers
2. Replace only the content between them
3. Leave everything outside untouched

**For files without markers:**
- If empty or a new stub: write full content with markers around generated sections
- If existing content with no markers: append generated section at the bottom with a notice:
  ```
  <!-- NOTE: This file predates doc automation. Add GENERATED markers around the section above to enable targeted auto-updates. -->
  ```

**For fully MANUAL files (`docs/skill.md`):**
- Only create if missing; never overwrite

---

## Step 4 — Generate the Directory Tree (for `docs/architecture.md`)

Produce an accurate project tree. Exclude: `.git/`, `node_modules/`, `*.lock`, `__pycache__/`, `.DS_Store`

Format as a fenced code block under the heading `## Project Structure` in `docs/architecture.md`.

---

## Step 5 — Write a Doc Run Summary

Print this at the end of every run (do not save to a file, just output):

```
## Doc Update Summary — [DATE]

### Files Updated
- [filename] — [what changed]

### Files Created (stubs)
- [filename] — [why it was created]

### Files Reviewed, No Changes Needed
- [filename]

### Stale Items Flagged for Human Review
- [description of issue]

### Missing Documentation (not yet created)
- [description]
```

---

## Marker Reference

| Marker | Meaning |
|---|---|
| `<!-- GENERATED:START -->` | Begin auto-managed block — replaced on every run |
| `<!-- GENERATED:END -->` | End auto-managed block |
| `<!-- MANUAL:START -->` | Begin human-authored block — never overwrite |
| `<!-- MANUAL:END -->` | End human-authored block |
| `<!-- TODO: ... -->` | Placeholder when information cannot be auto-derived |

---

## Doc Quality Rules

Derived from how Pydantic AI, vLLM, DSPy, and AutoGPT maintain documentation:

1. **Explain before showing** — prose before code blocks, not after
2. **Document only public/user-facing behavior** — skip internal implementation details
3. **Link, don't duplicate** — one doc explains, others link to it (prevents drift)
4. **Mark experimental features** — use `> [!WARNING] Experimental` admonition
5. **Every route needs a description** — use TODO markers for gaps, but never leave a route undocumented
6. **Deprecation notes are permanent** — once deprecated, the note stays even after removal ("Removed in vX.Y")

---

## Idempotency Contract

Running this skill twice in a row on an unchanged codebase must produce zero diff.
If a second run would produce a diff, the markers are being respected inconsistently — stop and report the conflict rather than overwriting.

---

## How to Run Periodically

This skill has no built-in scheduler. Recommended approaches:

**Manually after each release:**
```bash
claude -p "/update-docs"
```

**GitHub Actions (scheduled weekly or post-merge):**
```yaml
- name: Update docs
  run: claude -p "/update-docs"
```

**Post-merge git hook (`.git/hooks/post-merge`):**
```bash
#!/bin/sh
claude -p "/update-docs"
```
