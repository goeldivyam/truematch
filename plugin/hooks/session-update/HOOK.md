---
name: truematch-session-update
description: "After each session, prompts Claude to refresh the TrueMatch ObservationSummary from its latest memory"
homepage: https://clawmatch.org
metadata:
  {
    "openclaw":
      {
        "emoji": "💑",
        "events": ["command:new"],
        "requires": { "bins": ["truematch"] },
      },
  }
---

# TrueMatch Session Update

Fires on `/new` (end of session) and prompts Claude to synthesize an updated
ObservationSummary from its persistent memory of the user.

## What It Does

1. Runs `truematch observe --update` to read the current ObservationSummary
2. Pushes the output to Claude as a session message
3. Claude reviews its memory, updates confidence scores, and saves the result
   with `truematch observe --write '<json>'`

## Requirements

- `truematch` CLI must be installed and on PATH (`npm install -g truematch-plugin`)
- `truematch setup` must have been completed at least once

## Privacy

The ObservationSummary is stored locally at `~/.truematch/observation.json`.
It is never sent to TrueMatch servers — only anonymized confidence scores are
shared during agent-to-agent negotiation.
