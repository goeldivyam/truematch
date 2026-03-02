#!/usr/bin/env bash
# TrueMatch bridge daemon
#
# Polls Nostr relays for incoming NIP-04 DMs and passes each message into
# the Claude session via `claude --continue -p`.
#
# Claude reads the thread state, reasons about the message, and responds
# using the Bash tool:
#   truematch match --send '<reply>' --thread <id>
#   truematch match --propose --thread <id> --write '<narrative-json>'
#   truematch match --decline --thread <id>
#
# Usage:
#   ~/.truematch/bridge.sh [--project-dir <path>]
#
# Prerequisites:
#   - truematch CLI installed (npm install -g truematch-plugin)
#   - truematch setup completed
#   - CLAUDE_PROJECT_DIR set or passed via --project-dir
#   - node (for send.js helper)

set -euo pipefail

POLL_INTERVAL=${TRUEMATCH_POLL_INTERVAL:-15}   # seconds between relay polls
TRUEMATCH_DIR="${TRUEMATCH_DIR:-$HOME/.truematch}"
PERSONA_FILE="${TRUEMATCH_DIR}/persona.md"
QUEUE_FILE="${TRUEMATCH_DIR}/message-queue.jsonl"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"

# Parse --project-dir
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$PROJECT_DIR" ]]; then
  echo "ERROR: set CLAUDE_PROJECT_DIR or pass --project-dir <path>" >&2
  exit 1
fi

# Ensure persona file exists (injected into every Claude headless session)
if [[ ! -f "$PERSONA_FILE" ]]; then
  cat > "$PERSONA_FILE" <<'EOF'
You are acting as a TrueMatch agent on behalf of your user. Your role during
negotiations is that of a skeptical advocate — your job is to determine whether
a match is genuinely good, not to produce one.

Key rules:
- Read the thread state from ~/.truematch/threads/<thread_id>.json before responding
- Share inferences about your user, never raw evidence or evidence_summary content
- After each exchange, ask yourself: what would make this match fail?
- Before proposing, run the counter-argument pass: if any dimension appears < 0.55, decline
- Use `truematch match --send '<reply>' --thread <id>` to respond
- Use `truematch match --propose --thread <id> --write '<json>'` to propose a match
- Use `truematch match --decline --thread <id>` to end the negotiation
EOF
  echo "Created persona file at $PERSONA_FILE"
fi

# Ensure queue file exists
touch "$QUEUE_FILE"

echo "TrueMatch bridge started. Polling every ${POLL_INTERVAL}s..."
echo "Project dir: $PROJECT_DIR"

process_message() {
  local thread_id="$1"
  local peer_pubkey="$2"
  local msg_type="$3"
  local content="$4"
  local round_count="$5"

  # Save message to thread state via CLI
  truematch match --status --thread "$thread_id" > /dev/null 2>&1 || true

  # Compose the prompt for Claude
  local prompt
  prompt="[TrueMatch] Incoming message from peer ${peer_pubkey:0:12}:
Thread: ${thread_id}
Round: ${round_count} / 10
Type: ${msg_type}

${content}

Read the thread history at ~/.truematch/threads/${thread_id}.json, then respond using the truematch CLI."

  echo "Processing message for thread ${thread_id:0:8}... (round $round_count)"

  # Call Claude headlessly, continuing the existing project session
  cd "$PROJECT_DIR"
  claude --continue \
    --append-system-prompt-file "$PERSONA_FILE" \
    -p "$prompt" \
    --output-format text \
    2>&1 || echo "Claude session error for thread $thread_id"
}

# Main polling loop
while true; do
  # Poll for new messages using the truematch subscribe command
  # Output format: one JSON object per line (JSONL)
  if node "$TRUEMATCH_DIR/scripts/poll.js" >> "$QUEUE_FILE" 2>/dev/null; then
    # Process any queued messages
    if [[ -s "$QUEUE_FILE" ]]; then
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        thread_id=$(echo "$line" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).thread_id||''))")
        peer_pubkey=$(echo "$line" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).peer_pubkey||''))")
        msg_type=$(echo "$line" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).type||'negotiation'))")
        content=$(echo "$line" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).content||''))")
        round_count=$(echo "$line" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).round_count||0))")

        if [[ -n "$thread_id" ]]; then
          # Save to thread state first
          truematch match --status --thread "$thread_id" > /dev/null 2>&1 || true
          process_message "$thread_id" "$peer_pubkey" "$msg_type" "$content" "$round_count"
        fi
      done < "$QUEUE_FILE"

      # Clear the queue after processing
      > "$QUEUE_FILE"
    fi
  fi

  sleep "$POLL_INTERVAL"
done
