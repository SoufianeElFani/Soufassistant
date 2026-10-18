/*
 * automation — what Home Assistant has loaded, what is on disk, and the
 * validate-then-reload loop around editing it: `automation`, `config-check`,
 * `reload`.
 *
 * `config-check` and `reload` are REST-only (no WebSocket equivalent), so they are
 * defined with `ws: false` and work even if the WebSocket cannot authenticate.
 * Both read the Core log across the call to catch the per-entity errors HA only
 * logs — see scanningLog().
 */
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/ha-ws.cjs');
const { UsageError } = require('../lib/ha-args.cjs');
const { core, coreLogTail } = require('../lib/ha-rest.cjs');
const { newLines, parseConfigErrors } = require('../lib/ha-log-scan.cjs');
const { parseDuration, toMillis } = require('../lib/ha-time.cjs');
const { resolveAutomation } = require('../lib/ha-common.cjs');

const CONFIG_DIR = process.env.HA_CONFIG_DIR || '/config';

/* ------------------------------------------------------------- automation */

// After editing automations.yaml and reloading, the obvious check is "show me
// what HA now holds". `show` is that call. It reports which key spelling the
// config came back with, because HA moved from `trigger:`/`action:` to the
// plural `triggers:`/`actions:` and tools that only read one spelling report a
// perfectly healthy automation as empty.
const automation = {
  name: 'automation',
  usage: '<list | show <entity_id|id> | yaml <entity_id|id>>',
  summary: 'What Home Assistant has loaded for automations: list them, show one\'s loaded config, or show its block in automations.yaml.',
  details: '  list              every automation: entity_id, id, alias, state, last_triggered\n' +
    '  show <ref>        the config HA currently has loaded, with the key spelling it uses (singular / plural)\n' +
    '  yaml <ref>        its block in automations.yaml, with line numbers\n' +
    '<ref> is an entity_id, the numeric id, or the friendly name.',
  examples: [
    ['list'],
    ['show automation.hall_light_off'],
    ['yaml 1699', 'the block as written on disk, numbered'],
  ],
  min: 1,
  max: 2,
  async run({ ws, pos, out }) {
    const [action, ref] = pos;
    if (action === 'list') {
      const states = await ws.send({ type: 'get_states' });
      const rows = (states || [])
        .filter((s) => s.entity_id.startsWith('automation.'))
        .map((s) => ({
          entity_id: s.entity_id,
          id: s.attributes?.id ? String(s.attributes.id) : null,
          alias: s.attributes?.friendly_name || null,
          state: s.state,
          last_triggered: s.attributes?.last_triggered ? out.stamp(toMillis(s.attributes.last_triggered)) : null,
        }))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
      out.data(rows, { command: 'automation', count: rows.length, times: true });
      return;
    }
    if (action !== 'show' && action !== 'yaml') throw new UsageError(`unknown action "${action}" (expected list, show or yaml)`);
    if (!ref) throw new UsageError(`${action} needs an automation (entity_id, id or friendly name)`);
    const found = await resolveAutomation(ws, ref);

    if (action === 'show') {
      let config = null;
      let source = null;
      try {
        const result = await ws.send({ type: 'automation/config', entity_id: found.entity_id });
        config = result?.config ?? result ?? null;
        source = 'websocket automation/config';
      } catch (e) {
        // Fall through to REST rather than reporting a guess at the cause.
        source = `websocket automation/config failed (${e.message})`;
      }

      const empty = (cfg) => !cfg || (!cfg.trigger && !cfg.triggers && !cfg.action && !cfg.actions);
      if (empty(config) && found.id) {
        try {
          config = await core(`config/automation/config/${found.id}`);
          source = 'rest config/automation/config (stored)';
        } catch (e) {
          throw new Error(`could not read config for ${found.entity_id} — ${e.message}`);
        }
      }

      const count = (singular, plural) => {
        const value = config?.[plural] ?? config?.[singular];
        if (value === undefined || value === null) return 0;
        return Array.isArray(value) ? value.length : 1;
      };
      out.data({
        entity_id: found.entity_id,
        id: found.id,
        alias: found.alias || config?.alias || null,
        state: found.state,
        source,
        // Which spelling HA used — the thing that silently breaks parsers.
        schema: config?.triggers || config?.actions ? 'plural' : 'singular',
        uses_blueprint: Boolean(config?.use_blueprint),
        summary: {
          triggers: count('trigger', 'triggers'),
          conditions: count('condition', 'conditions'),
          actions: count('action', 'actions'),
        },
        config,
      }, { command: 'automation' });
      return;
    }

    // yaml
    if (!found.id) throw new Error(`${found.entity_id} has no id attribute — it isn't in automations.yaml`);
    const file = path.join(CONFIG_DIR, 'automations.yaml');
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch (e) {
      throw new Error(`reading ${file}: ${e.message}`);
    }

    // automations.yaml is a top-level list, so a block runs from its "- " line
    // to the line before the next one. Line-scanning beats a YAML parse here:
    // it preserves formatting and comments exactly as written on disk.
    const starts = [];
    lines.forEach((line, i) => {
      if (/^-\s/.test(line) || /^-$/.test(line.trimEnd())) starts.push(i);
    });
    const idPattern = new RegExp(`^\\s*(-\\s+)?id:\\s*['"]?${found.id}['"]?\\s*$`);
    const blockIdx = starts.findIndex((start, n) => {
      const end = starts[n + 1] ?? lines.length;
      return lines.slice(start, end).some((l) => idPattern.test(l));
    });
    if (blockIdx === -1) {
      throw new Error(`no automation with id ${found.id} in ${file} ` +
        `(it may be defined in a package or a !include'd file)`);
    }
    const start = starts[blockIdx];
    let end = starts[blockIdx + 1] ?? lines.length;
    // The blank line separating two entries belongs to neither of them.
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    if (out.isJson) {
      out.data({
        entity_id: found.entity_id, file, first_line: start + 1, last_line: end,
        lines: lines.slice(start, end).map((text, i) => ({ n: start + 1 + i, text })),
      }, { command: 'automation' });
      return;
    }
    const width = String(end).length;
    console.log(`# ${file}, lines ${start + 1}-${end} — ${found.entity_id}`);
    for (let i = start; i < end; i++) {
      console.log(`${String(i + 1).padStart(width)}  ${lines[i]}`);
    }
  },
};

/* ------------------------------------------------------- config-check etc. */

/*
 * Watch the Core log across an operation and report the per-entity config errors
 * Home Assistant writes while it runs.
 *
 * Both config-check and reload need this for the same reason: what they call
 * reports whether the *call* worked, not whether your config is sound. HA logs
 * "Invalid config for '<domain>' at <file>, line N: …", drops the entity, and
 * carries on — so an entity can vanish while both commands report success.
 *
 * Best effort, and it says when it was: if the log cannot be read, the caller
 * keeps the endpoint's own verdict and prints why the scan didn't happen. A
 * check that couldn't look must never imply that it looked and found nothing.
 */
async function scanningLog(enabled, operation) {
  if (!enabled) return { result: await operation(), errors: [], scanned: false };

  let before = null;
  let unavailable = null;
  try {
    before = await coreLogTail();
  } catch (e) {
    unavailable = e.message;
  }

  const result = await operation();

  if (unavailable) return { result, errors: [], scanned: false, unavailable };
  let after;
  try {
    after = await coreLogTail();
  } catch (e) {
    return { result, errors: [], scanned: false, unavailable: e.message };
  }

  const { lines, overlapped } = newLines(before, after);
  return { result, errors: parseConfigErrors(lines), scanned: true, overlapped };
}

/** How a scan that could not run is reported, so it is never mistaken for "clean". */
function logScanNote(scan) {
  if (scan.unavailable) return `unavailable — could not read the Core log: ${scan.unavailable}`;
  if (scan.overlapped === false) {
    return 'partial — the Core log moved on by more than the window read, so errors may be missing';
  }
  return null;
}

// config-check — validate the config HA would load. The safety step when
// hand-editing YAML, and REST-only (there is no WebSocket equivalent), which is
// why it used to mean hand-rolling a curl. Exits non-zero when invalid so a
// caller can branch on it without parsing.
//
// The endpoint alone is not enough: it fails only on a config HA cannot load at
// all, and answers "valid" for one it will load *without* the entity you just
// wrote. So the Core log is read across the check and the errors it emits are
// folded into the verdict. --no-log-scan restores the endpoint-only behaviour.
const configCheck = {
  name: 'config-check',
  usage: '[--no-log-scan]',
  summary: 'Validate the configuration Home Assistant would load, including per-entity errors it only logs. Exits 1 if anything is wrong.',
  flags: { 'no-log-scan': 'bool' },
  flagHelp: { '--no-log-scan': 'trust the endpoint alone; do not read the Core log across the check' },
  ws: false,
  max: 0,
  examples: [[''], ['--json', 'success:false and exit 1 when invalid'], ['&& ha-tools reload', 'validate before reloading']],
  async run({ opt, out }) {
    const scan = await scanningLog(!opt.noLogScan, () => core('config/core/check_config', { method: 'POST', timeoutMs: 120000 }));
    const result = { ...(scan.result || {}) };
    if (scan.errors.length) {
      result.result = 'invalid';           // the endpoint said valid; the log says otherwise
      result.platform_errors = scan.errors;
    }
    const note = logScanNote(scan);
    if (note) result.log_scan = note;

    if (result.result !== 'valid' || scan.errors.length) out.fail(result, { command: 'config-check', message: 'the configuration is not valid' });
    else out.data(result, { command: 'config-check' });
  },
};

// reload — pick up edited YAML without restarting HA.
//
// Reload is where a bad per-entity config actually bites, and reporting
// `{"reloaded":"template"}` unconditionally says only that the service call went
// through — which reads as the reload having worked. Same log scan as
// config-check, plus --expect to assert the entity you just wrote exists
// afterwards, which is the failure this whole thing is about.
const RELOAD_ALL = 'all';
const reload = {
  name: 'reload',
  mutates: true,
  usage: '[domain] [--expect <entity_id>]… [--expect-timeout 8s] [--no-log-scan]',
  summary: 'Reload edited YAML without restarting (default domain: automation; `all` reloads everything reloadable) and prove it landed.',
  flags: { expect: 'list', 'expect-timeout': 'string', 'no-log-scan': 'bool' },
  flagHelp: {
    '--expect <entity_id>': 'fail (exit 1) if this entity does not exist afterwards; repeatable',
    '--expect-timeout 8s': 'how long to wait for an expected entity to appear',
    '--no-log-scan': 'do not read the Core log across the reload',
  },
  ws: false,
  max: 1,
  examples: [
    [''],
    ['template --expect cover.nick_blind', 'reload templates and fail if the entity did not appear'],
    ['all --json'],
  ],
  validate({ opt }) {
    try { opt.expectTimeoutMs = opt.expectTimeout === undefined ? 8000 : parseDuration(opt.expectTimeout, '--expect-timeout'); }
    catch (e) { throw new UsageError(e.message); }
  },
  async run({ pos, opt, out }) {
    const domain = pos[0] || 'automation';
    const [callDomain, service] = domain === RELOAD_ALL ? ['homeassistant', 'reload_all'] : [domain, 'reload'];

    let scan;
    try {
      scan = await scanningLog(!opt.noLogScan, () => core(
        `services/${callDomain}/${service}`, { method: 'POST', body: {}, timeoutMs: 120000 }));
    } catch (e) {
      throw new Error(`reloading ${domain} failed — ${e.message}`);
    }

    const result = { reloaded: domain, service: `${callDomain}.${service}` };
    if (scan.errors.length) result.platform_errors = scan.errors;
    const note = logScanNote(scan);
    if (note) result.log_scan = note;

    const expect = opt.expect || [];
    let missing = [];
    if (expect.length) {
      missing = await missingEntities(expect, { timeoutMs: opt.expectTimeoutMs });
      result.expected = Object.fromEntries(expect.map((id) => [id, missing.includes(id) ? 'missing' : 'present']));
    }

    if (scan.errors.length || missing.length) {
      out.fail(result, { command: 'reload', message: missing.length ? `expected entities missing: ${missing.join(', ')}` : 'the reload logged configuration errors' });
    } else {
      out.data(result, { command: 'reload' });
    }
  },
};

/**
 * Which of these entity_ids the state machine does not have. Polled rather than
 * read once: a reload is not instantaneous, and "not there yet" and "dropped
 * because its config was rejected" look identical for the first second or two.
 */
async function missingEntities(ids, { timeoutMs = 8000, intervalMs = 500 } = {}) {
  let outstanding = [...ids];
  const deadline = Date.now() + timeoutMs;
  await run(async (ws) => {
    for (;;) {
      const states = await ws.send({ type: 'get_states' });
      const have = new Set((states || []).map((s) => s.entity_id));
      outstanding = outstanding.filter((id) => !have.has(id));
      if (!outstanding.length || Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  });
  return outstanding;
}

module.exports = { commands: [automation, configCheck, reload] };
