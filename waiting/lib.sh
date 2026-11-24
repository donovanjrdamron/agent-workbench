#!/bin/bash
# Shared helpers for the "waiting on you" tracker.
WAIT_DIR="$HOME/.claude/waiting"
mkdir -p "$WAIT_DIR"

# Find the claude process that owns this hook (walk up the process tree).
find_claude_pid() {
  local p=$PPID comm
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    comm=$(ps -o comm= -p "$p" 2>/dev/null)
    case "$comm" in *claude*) echo "$p"; return;; esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
}

# Best session title: /rename title > auto title > folder name.
# Only reads the end of the transcript (they can be hundreds of MB) and caches the result.
session_title() {
  local transcript="$1" cwd="$2" t="" cache="$WAIT_DIR/.titles"
  mkdir -p "$cache"
  local key; key=$(basename "$transcript" .jsonl)
  if [ -f "$transcript" ]; then
    local tailtxt; tailtxt=$(tail -c 3000000 "$transcript" 2>/dev/null | grep -E '"type":"(custom-title|ai-title)"')
    t=$(grep '"type":"custom-title"' <<<"$tailtxt" | tail -1 | jq -r '.customTitle // empty' 2>/dev/null)
    [ -z "$t" ] && t=$(grep '"type":"ai-title"' <<<"$tailtxt" | tail -1 | jq -r '.aiTitle // empty' 2>/dev/null)
  fi
  if [ -n "$t" ] && [ -n "$key" ]; then echo "$t" > "$cache/$key"
  elif [ -n "$key" ] && [ -f "$cache/$key" ]; then t=$(cat "$cache/$key"); fi
  [ -z "$t" ] && t=$(basename "$cwd")
  echo "$t"
}

# Drop entries whose claude process is gone (terminal closed).
prune_dead() {
  local f pid
  for f in "$WAIT_DIR"/*.json; do
    [ -e "$f" ] || continue
    pid=$(jq -r '.pid // empty' "$f" 2>/dev/null)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -f "$f"; fi
  done
}

human_age() {
  local s=$1
  if   [ "$s" -lt 60 ];    then echo "now"
  elif [ "$s" -lt 3600 ];  then echo "$((s/60))m"
  elif [ "$s" -lt 86400 ]; then echo "$((s/3600))h"
  else echo "$((s/86400))d"; fi
}

# Live per-session record the work board reads: ~/.claude/waiting/.sessions/<claude pid>.json
SESS_DIR="$WAIT_DIR/.sessions"
write_session() {   # $1=state(working|waiting) $2=input json
  local pid sid tr cwd
  pid=$(find_claude_pid); [ -z "$pid" ] && return
  sid=$(jq -r '.session_id // empty' <<<"$2"); tr=$(jq -r '.transcript_path // empty' <<<"$2"); cwd=$(jq -r '.cwd // empty' <<<"$2")
  mkdir -p "$SESS_DIR"
  jq -n --arg pid "$pid" --arg sid "$sid" --arg tr "$tr" --arg cwd "$cwd" --arg st "$1" \
        --arg term "${ORCA_TERMINAL_HANDLE:-}" --arg pane "${ORCA_PANE_KEY:-}" --argjson ts "$(date +%s)" \
        '{pid:$pid,sid:$sid,transcript:$tr,cwd:$cwd,state:$st,terminal:$term,pane:$pane,ts:$ts}' > "$SESS_DIR/$pid.json.tmp" \
    && mv "$SESS_DIR/$pid.json.tmp" "$SESS_DIR/$pid.json"
}
