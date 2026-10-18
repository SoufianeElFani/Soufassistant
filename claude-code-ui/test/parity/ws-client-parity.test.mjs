/*
 * ha-ws-client parity: every non-streaming command, run through the old Go
 * binary (v1.8.1) and through the new implementation against the same fake Home
 * Assistant, with the JSON compared.
 *
 * The contract is "the old output is a subset of the new": the new code may add
 * fields (it passes HA's data through raw where the Go tool re-serialised it
 * through a struct that dropped most of it), but nothing the old tool printed may
 * be missing or different. The differences that are *intended* are written down
 * below, each with its reason — everything else is a regression.
 *
 * Run it with `npm run test:parity` (see run.mjs); it needs the old binary and an
 * unprivileged network namespace, so it is not part of `npm test`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFakeHa, runTool, TOKEN } from '../helpers/fake-ha.mjs';
import { buildWorld } from '../helpers/ha-world.mjs';

const INSIDE = process.env.PARITY_INNER === '1';
const OLD_BIN = process.env.OLD_BIN;

/**
 * The old tool fans stats-multi out over goroutines that share one socket, and
 * now and then panics with "concurrent write to websocket connection" — a bug in
 * the thing being replaced, not in the comparison. Retry on exactly that.
 */
async function runOld(args) {
  for (let attempt = 0; ; attempt++) {
    const r = await runOldOnce(args);
    if (attempt < 4 && /panic: concurrent write to websocket connection/.test(r.stderr)) continue;
    return r;
  }
}

function runOldOnce(args) {
  return new Promise((resolve) => {
    const proc = spawn(OLD_BIN, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, SUPERVISOR_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** The envelope line that carries the data (a command may print messages first). */
function envelope(stdout) {
  const parsed = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return parsed.find((p) => 'data' in p) || parsed[parsed.length - 1] || null;
}

/** Every key the old output has, the new one has with an equal value. */
function subset(old, now, where = '$') {
  if (old === null) return; // the Go tool printed null for what is simply empty
  if (Array.isArray(old)) {
    assert.ok(Array.isArray(now), `${where}: expected an array`);
    assert.equal(now.length, old.length, `${where}: array length`);
    old.forEach((o, i) => subset(o, now[i], `${where}[${i}]`));
  } else if (typeof old === 'object') {
    assert.ok(now && typeof now === 'object', `${where}: expected an object, got ${JSON.stringify(now)}`);
    for (const [k, v] of Object.entries(old)) {
      assert.ok(k in now, `${where}.${k}: missing from the new output`);
      subset(v, now[k], `${where}.${k}`);
    }
  } else {
    assert.deepEqual(now, old, `${where}`);
  }
}

const sortBy = (arr, key) => [...arr].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

/**
 * Each entry: [name, args, options]. Options:
 *   normalize(oldData, newData) → [a, b]   reshape before comparing
 *   equal       compare with deepEqual instead of subset
 *   approxMs    rows carry `ms`; allow 2ms of drift (the Go tool rebuilt times from epoch
 *               floats and lost sub-millisecond precision)
 *   envelopeOnly  compare success/command only (message text differs on purpose)
 *   error       both must fail
 */
// Not in the corpus on purpose: states-json, history-full and trace-debug were deleted as duplicates
// (states-filter '*', `history --full` and `trace` do the same), and watch folded into monitor.
const CORPUS = [
  ['ping', ['ping'], { envelopeOnly: true }],
  ['state', ['state', 'sensor.temperature']],
  ['state (unknown entity)', ['state', 'sensor.nope'], { error: true }],
  ['state (missing argument)', ['state'], { error: true }],
  ['states', ['states']],
  ['states --max-items', ['states', '--max-items', '2']],
  ['states-filter', ['states-filter', 'sensor.*']],
  ['config', ['config'], { equal: true }],
  ['services', ['services'], {
    // Go iterates a map: the old order was random.
    normalize: (o, n) => [sortBy(o, 'domain').map((d) => ({ ...d, services: [...d.services].sort() })), sortBy(n, 'domain').map((d) => ({ ...d, services: [...d.services].sort() }))],
    equal: true,
  }],
  ['call', ['call', 'light', 'turn_on', '{"entity_id":"light.hall"}']],
  ['template', ['template', '{{ 1 + 1 }}']],
  ['device-health', ['device-health', 'sensor.temperature'], {
    // Seconds-apart runs: the age differs by milliseconds.
    normalize: (o, n) => { const strip = (d) => { delete d.entity.age_seconds; (d.related || []).forEach((r) => delete r.age_seconds); return d; }; return [strip(o), strip(n)]; },
  }],
  ['compare', ['compare', 'sensor.temperature', 'sensor.temp2']],
  ['entities', ['entities', 'temp']],
  ['devices', ['devices', 'phone']],
  ['areas', ['areas']],
  ['logbook', ['logbook', 'light.hall', '6']],
  ['history', ['history', 'sensor.temperature', '6']],
  ['attrs', ['attrs', 'sensor.temperature', '6'], {
    // Intended: Go field names (Time/State/Attrs) replaced by snake_case keys.
    normalize: (o, n) => [o.map((e) => ({ ms: Date.parse(e.Time), state: e.State })), n.map((e) => ({ ms: Date.parse(e.time), state: e.state }))],
    approxMs: true,
  }],
  ['timeline', ['timeline', '6', 'sensor.temperature', 'light.hall'], {
    // Intended: Go field names (Time/EntityID/State) replaced by snake_case keys (and an epoch_ms).
    normalize: (o, n) => [o.map((e) => ({ ms: Date.parse(e.Time), entity_id: e.EntityID, state: e.State })), n.map((e) => ({ ms: e.epoch_ms, entity_id: e.entity_id, state: e.state }))],
    approxMs: true,
  }],
  ['syslog', ['syslog']],
  ['stats', ['stats', 'sensor.temperature', '6']],
  ['stats-multi', ['stats-multi', 'sensor.temperature', 'sensor.missing', '6'], {
    // Intended: the error text for an entity with no statistics is ours.
    normalize: (o, n) => { for (const d of [o, n]) d.entities.forEach((e) => delete e.error); return [o, n]; },
  }],
  ['context', ['context', 'sensor.temperature']],
  ['analyze', ['analyze', 'sensor.temperature']],
  // Automations: the old tool's whole remit.
  ['traces <automation>', ['traces', 'automation.hall_light_off']],
  ['traces (all automations)', ['traces']],
  ['traces (none stored)', ['traces', 'automation.no_traces']],
  ['trace-latest', ['trace-latest', 'automation.hall_light_off']],
  ['trace-summary', ['trace-summary', 'automation.hall_light_off']],
  ['trace <run>', ['trace', 'automation.hall_light_off', 'a2']],
  ['trace-vars <run>', ['trace-vars', 'automation.hall_light_off', 'a1']],
  ['trace-trigger <run>', ['trace-trigger', 'automation.hall_light_off', 'a1']],
  ['trace-timeline <run>', ['trace-timeline', 'automation.hall_light_off', 'a1'], {
    // Intended: Go printed steps in map order; the new output is chronological and richer.
    normalize: (o, n) => [o.map((s) => `${s.Timestamp}|${s.Path}`).sort(), n.map((s) => `${s.timestamp}|${s.path}`).sort()],
    equal: true,
  }],
  ['trace-actions <run>', ['trace-actions', 'automation.hall_light_off', 'a1'], {
    // Intended: Go kept only `action/` paths and a trimmed result; the new rows carry more.
    normalize: (o, n) => [o.map((s) => s.Path).sort(), n.map((s) => s.path).sort()],
    equal: true,
  }],
  ['automation-config', ['automation-config', 'automation.hall_light_off']],
  // Intended: the old message guessed at a cause ("blueprint automation with no stored
  // traces"); ours states what was found. Only the envelope is comparable.
  ['blueprint-inputs', ['blueprint-inputs', 'automation.hall_light_off'], { envelopeOnly: true }],
  ['trace-latest (unknown automation)', ['trace-latest', 'automation.nope'], { error: true }],
];

describe('ha-ws-client parity (old binary v1.8.1 vs the built-in implementation)', {
  skip: INSIDE && OLD_BIN ? false : 'run `npm run test:parity` — it needs the old binary and a network namespace',
}, () => {
  let ha;
  before(async () => {
    const world = buildWorld();
    ha = await startFakeHa({ commands: world.commands, port: 80 });
  });
  after(async () => { await ha?.close(); });

  for (const [name, args, opts = {}] of CORPUS) {
    test(name, async () => {
      const argv = [...args, '--json'];
      const [oldRun, newRun] = [await runOld(argv), await runTool('ha-tools', argv)];

      if (opts.error) {
        assert.notEqual(oldRun.code, 0, 'the old tool was expected to fail here (corpus is wrong)');
        assert.notEqual(newRun.code, 0, `the new tool should fail too\n${newRun.stdout}\n${newRun.stderr}`);
        return;
      }
      assert.equal(oldRun.code, 0, `the old tool failed (corpus is wrong): ${oldRun.stderr || oldRun.stdout}`);
      assert.equal(newRun.code, 0, `exit ${newRun.code}: ${newRun.stderr}\n${newRun.stdout}`);

      const [o, n] = [envelope(oldRun.stdout), envelope(newRun.stdout)];
      assert.ok(o && n, `no JSON envelope\nold: ${oldRun.stdout}\nnew: ${newRun.stdout}`);
      assert.equal(n.success, o.success);
      assert.equal(n.command, o.command, 'command name');
      if (opts.envelopeOnly) return;
      if (o.count !== undefined) assert.equal(n.count, o.count, 'count');
      if (o.summary !== undefined) assert.equal(n.summary, o.summary, 'summary');

      let [od, nd] = [o.data, n.data];
      if (opts.normalize) [od, nd] = opts.normalize(structuredClone(od), structuredClone(nd));
      if (opts.approxMs) {
        assert.equal(nd.length, od.length, 'row count');
        od.forEach((row, i) => {
          assert.ok(Math.abs(nd[i].ms - row.ms) <= 2, `row ${i}: ${nd[i].ms} vs ${row.ms}`);
          assert.deepEqual({ ...nd[i], ms: 0 }, { ...row, ms: 0 }, `row ${i}`);
        });
      } else if (opts.equal) assert.deepEqual(nd, od);
      else subset(od, nd);
    });
  }

  // The default (non-JSON) outputs differ on purpose in how they print time; what
  // must not differ is that the commands still work and say something.
  for (const args of [['state', 'sensor.temperature'], ['states-filter', 'light.*'], ['config'], ['areas'], ['traces', 'automation.hall_light_off'], ['trace-latest', 'automation.hall_light_off']]) {
    test(`default output still works: ${args.join(' ')}`, async () => {
      const [oldRun, newRun] = [await runOld(args), await runTool('ha-tools', args)];
      assert.equal(oldRun.code, 0);
      assert.equal(newRun.code, 0, newRun.stderr);
      assert.ok(newRun.stdout.trim().length > 0, 'empty output');
    });
  }
});
