/*
 * ha-command — turns a command definition into something ha-tools.cjs can run.
 *
 * A definition is
 *   { name, usage, summary, flags, min, examples: [[command, comment?]…], run(ctx) }
 * and gets argument parsing, --help (stdout, exit 0), usage errors (stderr,
 * exit 2), the HA-timezone clock and the shared output shapes for free, so the
 * thirty-odd commands that took over from ha-ws-client all behave alike.
 */
const { run } = require('./ha-ws.cjs');
const { parseArgs, UsageError, LISTING_FLAGS, RANGE_FLAGS, SHOW_AGE_FLAGS } = require('./ha-args.cjs');
const { haClock } = require('./ha-common.cjs');
const { clock } = require('./ha-time.cjs');
const outputLib = require('./ha-output.cjs');

const GLOBAL_HELP = `Options (all commands):
  --json                Machine-readable: one line, {"success":true,"command":…,"data":…}
  --compact             One line per item
  --format json|compact|default   Same as the flags above
  --no-headers          Drop titles and totals
  --utc                 Print times in UTC instead of Home Assistant's timezone
  -h, --help            This text`;

/**
 * A definition's flags: its own, plus the opt-in shared ones it says it honours.
 * `listing` (--max-items), `range` (--from/--to) and `showAge` exist so that a
 * command never accepts a flag it would quietly ignore.
 */
function flagsOf(def) {
  return {
    ...(def.listing ? LISTING_FLAGS : {}),
    ...(def.range ? RANGE_FLAGS : {}),
    ...(def.showAge ? SHOW_AGE_FLAGS : {}),
    ...def.flags,
  };
}

function helpText(def, cmd) {
  const shared = {
    ...(def.listing ? { '--max-items N': 'show at most N items in text output (--json is never truncated)' } : {}),
    ...(def.range && !Object.keys(def.flagHelp || {}).some((k) => k.includes('--from'))
      ? { '--from / --to': 'a date (YYYY-MM-DD[ HH:MM], UTC) to start / stop at' } : {}),
    ...(def.showAge ? { '--show-age': 'show how long ago each was updated, and flag stale ones' } : {}),
  };
  const entries = Object.entries({ ...shared, ...(def.flagHelp || {}) });
  const pad = Math.max(22, ...entries.map(([k]) => k.length + 2));
  const flags = entries.map(([k, v]) => `  ${k.padEnd(pad)}${v}`);
  const lines = [`Usage: ${cmd.usage}`, '', def.summary];
  if (def.mutates) lines.push('', def.mutatesNote || 'This changes Home Assistant.');
  if (def.details) lines.push('', def.details);
  if (flags.length) lines.push('', 'Options:', ...flags);
  lines.push('', GLOBAL_HELP);
  if (def.examples?.length) {
    lines.push('', 'Examples:');
    for (const [example, comment] of def.examples) {
      lines.push(`  ${cmd.name} ${example}`.trimEnd() + (comment ? `   # ${comment}` : ''));
    }
  }
  return lines.join('\n');
}

/** A failed command, in the shape --json promises (and the exit code agrees with). */
function failureEnvelope(command, message) {
  console.log(JSON.stringify({ success: false, command, error: message }));
}

/**
 * @param def      a command definition (see the top of this file)
 * @param argv     everything after the command name
 * @param cmdName  how the user spelled it ("ha-tools trace-latest"), echoed in usage
 *
 * Extra definition options: `formats` (--format values beyond json|compact|default,
 * e.g. ['tsv']), `ws: false` (REST-only commands, which must not need a WebSocket to
 * work), `command` (the name in the --json envelope, when it differs from `name`).
 */
async function execute(def, argv, cmdName) {
  const cmd = { name: cmdName, usage: `${cmdName} ${def.usage}`.trimEnd() };
  const envelopeName = def.command || def.name;
  let parsed;
  try {
    parsed = parseArgs(argv, flagsOf(def), def.formats);
    if (!parsed.help && parsed.pos.length < (def.min ?? 0)) {
      throw new UsageError(`missing argument — ${def.min} required, got ${parsed.pos.length}`);
    }
    if (!parsed.help && def.max !== undefined && parsed.pos.length > def.max) {
      throw new UsageError(`too many arguments (${parsed.pos.length}, at most ${def.max})`);
    }
    if (!parsed.help && def.validate) def.validate(parsed);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    if (argv.includes('--json')) failureEnvelope(envelopeName, e.message);
    console.error(`Error: ${e.message}`);
    console.error(`Usage: ${cmd.usage}`);
    console.error(`Run '${cmdName} --help' for options and examples.`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(helpText(def, cmd));
    return;
  }

  const body = async (ws) => {
    const clk = ws ? await haClock(ws, parsed.opt.utc) : clock('UTC');
    const out = outputLib.create(parsed.opt, clk);
    try {
      await def.run({ ws, pos: parsed.pos, opt: parsed.opt, out, clock: clk, cmd });
    } catch (e) {
      if (e instanceof UsageError) {
        if (out.isJson) failureEnvelope(envelopeName, e.message);
        console.error(`Error: ${e.message}`);
        console.error(`Usage: ${cmd.usage}`);
        process.exit(2);
      }
      // run() prints "Error: …" and exits 1; in --json mode the envelope says so too.
      if (out.isJson) failureEnvelope(envelopeName, e.message);
      throw e;
    }
  };

  if (def.ws === false) {
    try { await body(null); } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
    return;
  }
  await run(body);
}

module.exports = { execute, helpText };
