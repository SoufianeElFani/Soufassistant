#!/bin/bash

# ha-tools — the one entry point for this app's Home Assistant helper commands.
#
#   ha-tools <command> …      everything but logs: states, services, registries,
#                             history, traces, dashboards …  (ha-tools.cjs)
#   ha-tools logs …           Supervisor journald            (ha-logs.sh)
#
# There is deliberately no list of commands here. ha-tools.cjs builds its table, its
# dispatch and its --help from the command definitions in commands/*.cjs, so adding a
# command cannot leave this script out of date.

set -uo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

# The `ws` module lives in the server's dependencies rather than beside these
# scripts, so the Node commands need NODE_PATH pointed at it.
NODE_MODULES="${HA_TOOLS_NODE_PATH:-/opt/server/node_modules}"

if [ "${1:-}" = "logs" ]; then
    shift
    export HA_TOOLS_CMD="ha-tools logs"
    # Run through bash rather than exec'ing the file, so the command doesn't
    # depend on ha-logs.sh carrying the executable bit.
    exec bash "$SCRIPT_DIR/ha-logs.sh" "$@"
fi

exec env NODE_PATH="$NODE_MODULES" node "$SCRIPT_DIR/ha-tools.cjs" "$@"
