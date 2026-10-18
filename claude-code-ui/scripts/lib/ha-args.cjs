/*
 * ha-args — argument parsing for the commands that took over from the
 * ha-ws-client binary.
 *
 * The global flags (--json, --compact, --format, --no-headers, --no-timestamps,
 * --show-age, --max-items, --from, --to, --utc) are accepted anywhere in argv,
 * which is how ha-ws-client behaved and how callers already write them. A flag
 * a command does not declare is rejected rather than ignored: an ignored flag is
 * an agent believing it filtered when it didn't.
 */

class UsageError extends Error {}

const GLOBAL_FLAGS = {
  json: 'bool',
  compact: 'bool',
  'no-headers': 'bool',
  'no-timestamps': 'bool',
  'show-age': 'bool',
  utc: 'bool',
  'max-items': 'int',
  format: 'string',
  output: 'string',
  from: 'string',
  to: 'string',
};

const FORMATS = new Set(['json', 'compact', 'default', 'text']);

/**
 * @param argv   everything after the command name
 * @param flags  this command's own flags: { name: 'bool' | 'string' | 'int' }
 * @returns { pos, opt, help } — opt is keyed by flag name with dashes camel-cased
 */
function parseArgs(argv, flags = {}) {
  const spec = { ...GLOBAL_FLAGS, ...flags };
  const pos = [];
  const opt = {};
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }

    let name = a.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq !== -1) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option: ${a}`);

    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (kind === 'bool') {
      opt[key] = true;
      continue;
    }
    const raw = inline !== undefined ? inline : argv[++i];
    if (raw === undefined) throw new UsageError(`${a} needs a value`);
    if (kind === 'int') {
      if (!/^\d+$/.test(raw)) throw new UsageError(`${a} needs a whole number (got "${raw}")`);
      opt[key] = Number(raw);
    } else {
      opt[key] = raw;
    }
  }

  // --json / --compact win over --format/--output, as they did upstream.
  const fmt = opt.format ?? opt.output ?? 'default';
  if (!FORMATS.has(fmt)) throw new UsageError(`invalid --format: ${fmt} (expected json, compact or default)`);
  opt.fmt = opt.json ? 'json' : opt.compact ? 'compact' : fmt === 'text' ? 'default' : fmt;
  return { pos, opt, help };
}

/** `YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]`, or RFC 3339 — zoneless values are UTC. */
function parseFlexibleDate(value) {
  const s = String(value).trim();
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) iso = `${s.replace(' ', 'T')}${s.length === 16 ? ':00' : ''}Z`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new UsageError(`unable to parse date: ${value}`);
  return d;
}

module.exports = { parseArgs, parseFlexibleDate, UsageError, GLOBAL_FLAGS };
