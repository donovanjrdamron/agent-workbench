#!/bin/bash
# SessionStart (startup|resume): a new or resumed session is open and waiting on you. Without this, a session turned
# back on from the work board or Studio looks offline until you type in it.
source "$HOME/.claude/scripts/waiting/lib.sh"
write_session waiting "$(cat)"
exit 0
