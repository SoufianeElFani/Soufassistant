#!/bin/bash
# team-notes — thin exec wrapper, mirroring claude-tasks.sh. No extra NODE_PATH
# is needed here (the script uses only Node's built-in `http`).
set -uo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
exec node "$SCRIPT_DIR/team-notes.cjs" "$@"
