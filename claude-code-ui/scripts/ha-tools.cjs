#!/usr/bin/env node
/*
 * ha-tools (Node half) — the dispatcher.
 *
 * Not run directly: `ha-tools.sh` execs this for every command except `logs`. It is
 * a table lookup and nothing else; the commands are definitions in commands/*.cjs,
 * and lib/ha-command.cjs gives each of them the same argument parsing, --help
 * (stdout, exit 0, with examples), usage errors (stderr, exit 2), HA-timezone clock
 * and output shapes. So there is one way to run a command, one help screen (below,
 * generated from the table), and one JSON contract:
 *
 *   --json   one line: {"success":true|false,"command":…,"data":…,"count"?:…,"timezone"?:…}
 *            `success` always agrees with the exit code
 *
 * There is one name, `ha-tools`. (The third-party `ha-ws-client` binary this app
 * once downloaded, and the `ha-history` / `ha-stats` / … shortcuts, are gone: more
 * than one name for a tool is a choice an agent has to make for no benefit.)
 */
const { execute } = require('./lib/ha-command.cjs');

const MODULES = ['basic', 'registry', 'history', 'monitor', 'automation', 'lovelace', 'traces'];
const DEFS = {};
for (const mod of MODULES) {
  for (const def of require(`./commands/${mod}.cjs`).commands) DEFS[def.name] = def;
}

// `logs` is a bash script (it speaks to the Supervisor's journald endpoints), so it
// has no definition here; it is listed so the one help screen covers everything.
const LOGS = { summary: 'Core / host / Supervisor / app logs, from the journal (`ha-tools logs --help`).' };

// The order is the order of usefulness when something is wrong, not alphabetical.
const CATEGORIES = [
  ['Automations & scripts', ['running', 'trace-stuck', 'trace-timeline', 'trace-summary', 'traces', 'trace-latest', 'trace',
    'trace-vars', 'trace-actions', 'trace-trigger', 'trace-watch', 'automation-config', 'blueprint-inputs', 'automation']],
  ['Change and verify', ['config-check', 'reload', 'lovelace']],
  ['History', ['history', 'stats', 'stats-multi', 'timeline', 'logbook', 'attrs', 'syslog', 'context']],
  ['Entities and services', ['state', 'states', 'states-filter', 'config', 'services', 'call', 'template', 'fire-event',
    'device-health', 'compare', 'ping']],
  ['Registries', ['entities', 'devices', 'areas']],
  ['Live', ['monitor', 'monitor-multi', 'analyze']],
  ['Logs', ['logs']],
];

const HELP_WORDS = new Set(['-h', '--help', 'help']);
const VALUE_FLAGS = new Set(['--format', '--output']);

// One line per command: the first sentence, cut at a dash clause if it is still long.
const firstSentence = (text) => {
  const sentence = text.split(/(?<=\.)\s/)[0];
  return sentence.length > 100 ? sentence.split(/ — /)[0].replace(/[.:]$/, '') + '.' : sentence;
};

function help() {
  const listed = new Set(CATEGORIES.flatMap(([, names]) => names));
  const categories = [...CATEGORIES];
  const stray = Object.keys(DEFS).filter((n) => !listed.has(n));
  if (stray.length) categories.push(['Other', stray]);    // a new command is never hidden

  const lines = [
    'Usage: ha-tools <command> [args]',
    '',
    'Home Assistant from the command line: entities and services, history, automation and',
    'script traces, dashboards, logs. Every command takes --help (usage and examples).',
    'Shared flags, in any position: --json  --compact  --format json|compact|default  --no-headers  --utc',
    '(a command only accepts --max-items, --from/--to or --show-age if it acts on them).',
    '',
  ];
  for (const [title, names] of categories) {
    lines.push(`${title}:`);
    for (const name of names) {
      const def = name === 'logs' ? LOGS : DEFS[name];
      if (!def) continue;
      lines.push(`  ${name.padEnd(18)}${firstSentence(def.summary)}${def.mutates ? '  [changes HA]' : ''}`);
    }
    lines.push('');
  }
  lines.push(
    'Times print in Home Assistant\'s timezone with an explicit offset (the container clock is UTC);',
    'pass --utc for UTC. --json is one line, {"success":…,"command":…,"data":…}, and `success`',
    'always agrees with the exit code. Traces take --domain script|automation, or a qualified id',
    '(script.foo / automation.foo). Start a trace investigation with trace-summary, trace-timeline',
    'or trace-stuck; trace and trace-latest print the whole raw trace, which can be very large.',
    '',
    'Examples:',
    '  ha-tools running                                   # what is executing now, and for how long',
    '  ha-tools trace-stuck script.nick_blind_creep_open  # which branch is waiting, and on what',
    '  ha-tools timeline light.hall binary_sensor.stairs --days 3 --between 22:00-07:00',
    '  ha-tools history sensor.temperature 6              # last 6 hours (or --days 7, --from 2026-06-01)',
    '  ha-tools config-check && ha-tools reload template --expect cover.nick_blind',
    '  ha-tools logs --errors -n 500',
  );
  return lines.join('\n');
}

async function main() {
  let args = process.argv.slice(2);

  // Shared flags may come before the command (`ha-tools --json state x`).
  const lead = [];
  while (args.length && args[0].startsWith('-') && !HELP_WORDS.has(args[0])) {
    const n = VALUE_FLAGS.has(args[0]) && !args[0].includes('=') ? 2 : 1;
    lead.push(...args.slice(0, n));
    args = args.slice(n);
  }
  const [sub, ...rest] = args;

  if (!sub || HELP_WORDS.has(sub)) { console.log(help()); return; }
  const def = DEFS[sub];
  if (!def) {
    console.error(`ha-tools: unknown command '${sub}'`);
    console.error("Run 'ha-tools --help' for the list.");
    process.exit(2);
  }
  await execute(def, lead.concat(rest), `ha-tools ${sub}`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
