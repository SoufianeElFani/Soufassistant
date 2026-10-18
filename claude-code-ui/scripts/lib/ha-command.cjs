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
const { parseArgs, UsageError } = require('./ha-args.cjs');
const { haClock } = require('./ha-common.cjs');
const outputLib = require('./ha-output.cjs');

const GLOBAL_HELP = `Options (all commands):
  --json                Machine-readable: one line, {"success":true,"command":…,"data":…}
  --compact             One line per item
  --format json|compact|default   Same as the flags above
  --no-headers          Drop titles and totals
  --max-items N         Show at most N items in text output
  --utc                 Print times in UTC instead of Home Assistant's timezone
  -h, --help            This text`;

function helpText(def, cmd) {
  const entries = Object.entries(def.flagHelp || {});
  const pad = Math.max(22, ...entries.map(([k]) => k.length + 2));
  const flags = entries.map(([k, v]) => `  ${k.padEnd(pad)}${v}`);
  const lines = [`Usage: ${cmd.usage}`, '', def.summary];
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

/**
 * @param cmd  { name: how the user spelled it ("ha-ws-client trace-latest"),
 *               usage: that plus the definition's usage tail }
 */
async function execute(def, argv, cmdName) {
  const cmd = { name: cmdName, usage: `${cmdName} ${def.usage}`.trimEnd() };
  let parsed;
  try {
    parsed = parseArgs(argv, def.flags);
    if (!parsed.help && parsed.pos.length < (def.min ?? 0)) {
      throw new UsageError(`missing argument — ${def.min} required, got ${parsed.pos.length}`);
    }
    if (!parsed.help && def.max !== undefined && parsed.pos.length > def.max) {
      throw new UsageError(`too many arguments (${parsed.pos.length}, at most ${def.max})`);
    }
    if (!parsed.help && def.validate) def.validate(parsed);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`Error: ${e.message}`);
    console.error(`Usage: ${cmd.usage}`);
    console.error(`Run '${cmdName} --help' for options and examples.`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(helpText(def, cmd));
    return;
  }

  await run(async (ws) => {
    const clk = await haClock(ws, parsed.opt.utc);
    const out = outputLib.create(parsed.opt, clk);
    try {
      await def.run({ ws, pos: parsed.pos, opt: parsed.opt, out, clock: clk, cmd });
    } catch (e) {
      if (e instanceof UsageError) {
        console.error(`Error: ${e.message}`);
        console.error(`Usage: ${cmd.usage}`);
        process.exit(2);
      }
      throw e;
    }
  });
}

module.exports = { execute, helpText };
