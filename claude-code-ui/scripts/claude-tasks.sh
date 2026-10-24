#!/bin/bash
# claude-tasks — thin exec wrapper, mirroring ha-tools.sh. No extra NODE_PATH
# is needed here (the script uses only Node's built-in `http`), unlike
# ha-tools, which needs the `ws` module from the server's own node_modules.
set -uo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
exec node "$SCRIPT_DIR/claude-tasks.cjs" "$@"
