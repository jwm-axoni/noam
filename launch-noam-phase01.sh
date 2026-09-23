#!/bin/bash
# Launch the Noam Phase 0/1 Fable goal in a detached screen session.
# Watch it live from Warp with: screen -r noam-phase01
# Or tail the log: tail -f /Users/jm/Projects/Noam/noam-clean/fable-phase01.log
set -u
DIR=/Users/jm/Projects/Noam/noam-clean
PROMPT_FILE="$DIR/fable-goal-phase01.md"
LOG="$DIR/fable-phase01.log"
cd "$DIR" || exit 1
if ! /Users/jm/.local/bin/claude --version >/dev/null 2>&1; then
  echo "claude binary not working" >&2; exit 1
fi
screen -dmS noam-phase01 bash -c "/Users/jm/.local/bin/claude -p --dangerously-skip-permissions --model fable \"\$(cat \"$PROMPT_FILE\")\" 2>&1 | tee \"$LOG\"; echo '--- SESSION DONE ---' | tee -a \"$LOG\""
echo "Launched screen session 'noam-phase01'. Attach with: screen -r noam-phase01"
