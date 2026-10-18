#!/bin/bash

# ha-tools — one entry point for this app's Home Assistant helper commands.
#
#   ha-tools history|stats|lovelace …   WebSocket helpers      (ha-tools.cjs)
#   ha-tools logs …                     Supervisor journald    (ha-logs.sh)
#   ha-tools ws …                       states, services, registries, traces …
#                                       (ha-tools.cjs, commands/*.cjs)
#
# Each subcommand is also installed under its own name — ha-history, ha-stats,
# ha-lovelace, ha-logs, ha-ws-client — as a symlink back to this script. The
# name it was invoked as picks the subcommand (busybox style), so both spellings
# are the same command and neither can drift from the other. `ha-ws-client` used
# to be a separate third-party Go binary; its commands are now implemented here,
# and the name is kept so every documented spelling still works.

set -uo pipefail

SELF="$(basename "$0")"
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

# The `ws` module lives in the server's dependencies rather than beside these
# scripts, so the Node subcommands need NODE_PATH pointed at it.
NODE_MODULES="${HA_TOOLS_NODE_PATH:-/opt/server/node_modules}"

usage() {
    cat << 'USAGE'
Usage: ha-tools <command> [args]

Home Assistant helpers for this app. Commands with a name on the right are also
available under that name — the two spellings are the same command.

Inspect:
  timeline <entity_id…> [...]   Several entities' state changes on one clock (ha-timeline)
  history <entity_id> [...]     State-change history over a date range      (ha-history)
  stats <entity_id> [...]       Long-term statistics over a date range      (ha-stats)
  logs [source] [...]           Core/host/Supervisor/app logs               (ha-logs)

Automations:
  automation list               Every automation: entity_id, id, alias, state
  automation show <id>          The config HA currently has loaded
  automation yaml <id>          Its block in automations.yaml, with line numbers
  trace-watch <id> [...]        Block until it actually fires, then report the trace

Automations & scripts — running work and traces (both domains; --domain or script.x):
  running                       Every automation and script executing now, and for how long
  traces [id]                   Stored traces, newest first
  trace-latest <id>             The newest run's full trace
  trace-summary <id>            Run counts, latest run, what started it
  trace-timeline <id> [run]     Every step in order, with its place in the config
  trace-stuck <id> [run]        Where an unfinished run is waiting, and on what
  trace, trace-vars, trace-actions, trace-trigger, trace-debug <id> [run]

Change and verify:
  config-check                  Validate the config, incl. per-entity errors HA
                                only logs (exits 1 if anything is wrong)
  reload [domain]               Reload automations (default) or another domain;
                                --expect <entity_id> asserts it actually exists
  lovelace <list|get|save|...>  Dashboards — WebSocket only, REST 404s      (ha-lovelace)
  ws <command> …                Entity states, service calls, templates, registries,
                                logbook, live monitoring — `ha-tools ws --help` lists
                                them all                                 (ha-ws-client)

Times print in Home Assistant's timezone with an explicit offset (the container
clock is UTC and is not what the user means by "local"); pass --utc for UTC.

Run any command with --help for its own options, e.g. `ha-tools logs --help`.

Examples:
  ha-tools timeline light.hall binary_sensor.stairs --days 3 --between 22:00-07:00
  ha-tools history sensor.temperature --days 7 --format tsv
  ha-tools automation show automation.hall_light_off
  ha-tools config-check && ha-tools reload automation
  ha-tools reload template --expect cover.nick_blind   # ...and prove it exists
  ha-tools trace-watch automation.hall_light_off --timeout 2h
  ha-tools running                                      # what is executing, and for how long
  ha-tools trace-stuck script.nick_blind_creep_open     # which branch is waiting, and on what
  ha-tools logs --errors -n 500
USAGE
}

# Invoked under an alias? Turn the alias back into its subcommand.
case "$SELF" in
    ha-history)  set -- history  "$@" ;;
    ha-stats)    set -- stats    "$@" ;;
    ha-timeline) set -- timeline "$@" ;;
    ha-lovelace) set -- lovelace "$@" ;;
    ha-logs)     set -- logs     "$@" ;;
    ha-ws-client) set -- ws      "$@" ;;
esac

if [ $# -eq 0 ]; then
    usage
    exit 0
fi
sub="$1"
shift

# Echo the command back the way it was typed in usage/error messages.
if [ "$SELF" = "ha-tools" ]; then
    export HA_TOOLS_CMD="ha-tools $sub"
else
    export HA_TOOLS_CMD="$SELF"
fi

case "$sub" in
    history|stats|timeline|lovelace|automation|config-check|reload|trace-watch| \
    running|traces|trace|trace-latest|trace-summary|trace-vars|trace-timeline|trace-trigger| \
    trace-actions|trace-debug|trace-stuck|automation-config|blueprint-inputs| \
    ping|state|states|states-json|states-filter|config|services|call|template|fire-event| \
    device-health|compare|entities|devices|areas|logbook|history-full|attrs|syslog| \
    stats-multi|context|watch|monitor|monitor-multi|analyze|ws-history|ws-stats|ws-timeline)
        exec env NODE_PATH="$NODE_MODULES" node "$SCRIPT_DIR/ha-tools.cjs" "$sub" "$@"
        ;;
    ws)
        exec env NODE_PATH="$NODE_MODULES" node "$SCRIPT_DIR/ha-tools.cjs" ws "$@"
        ;;
    logs)
        # Run through bash rather than exec'ing the file, so the subcommand
        # doesn't depend on ha-logs.sh carrying the executable bit.
        exec bash "$SCRIPT_DIR/ha-logs.sh" "$@"
        ;;
    -h|--help|help)
        usage
        exit 0
        ;;
    *)
        echo "ha-tools: unknown command '$sub'" >&2
        echo "Run 'ha-tools --help' for the list." >&2
        exit 2
        ;;
esac
