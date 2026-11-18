#!/bin/bash
# UserPromptSubmit: you're back in this session (now working).  SessionEnd: session closed.
source "$HOME/.claude/scripts/waiting/lib.sh"
input=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$input")
[ -n "$sid" ] && rm -f "$WAIT_DIR/$sid.json"
case "$(jq -r '.hook_event_name // empty' <<<"$input")" in
  SessionEnd) pid=$(find_claude_pid); [ -n "$pid" ] && rm -f "$SESS_DIR/$pid.json" ;;
  *) write_session working "$input" ;;
esac
exit 0
