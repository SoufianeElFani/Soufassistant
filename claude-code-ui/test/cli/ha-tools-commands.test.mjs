/*
 * The command set of ha-tools — one tool, one name. Covers the commands that
 * replaced the old ha-tools binary (states, services, registries, history, live
 * monitoring), the ones that did not exist before (script traces, `running`,
 * `trace-stuck`), and the contract they all share.
 *
 * Output shape is an API here: the JSON envelope, the HA-timezone clock, "empty
 * is [], broken is non-zero", `success` agreeing with the exit code. The comparison
 * against the old binary lives in test/parity (npm run test:parity).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHa, runTool } from '../helpers/fake-ha.mjs';
import { buildWorld, AUTO_ID } from '../helpers/ha-world.mjs';

const MIN = 60_000;
const wsc = (args, opts) => runTool('ha-tools', args, opts);
const reqs = (ha, type) => ha.requests.filter((r) => r.ws === type).map((r) => r.message);

/** A fake HA from the shared world, with some commands replaced. */
async function world(override = (w) => ({})) {
  const w = buildWorld();
  const ha = await startFakeHa({ commands: { ...w.commands, ...override(w) } });
  return { ha, w };
}

const ALL_COMMANDS = [
  'ping', 'state', 'states', 'states-filter', 'config', 'services', 'call', 'template', 'fire-event',
  'device-health', 'compare', 'entities', 'devices', 'areas', 'logbook', 'history', 'attrs', 'timeline',
  'syslog', 'stats', 'stats-multi', 'context', 'monitor', 'monitor-multi', 'analyze', 'running', 'traces', 'trace',
  'trace-latest', 'trace-summary', 'trace-vars', 'trace-timeline', 'trace-trigger', 'trace-actions',
  'trace-stuck', 'automation-config', 'blueprint-inputs',
  'automation', 'config-check', 'reload', 'lovelace', 'trace-watch',
];
// Deleted as duplicates, not hidden: states-json (states-filter '*'), history-full (history --full),
// trace-debug (trace), watch (monitor). There is no old spelling to keep working.
const DELETED = ['states-json', 'history-full', 'trace-debug', 'watch', 'ha-history', 'update'];

describe('the dispatcher', () => {
  test('--help lists every command exactly once, so an agent can check rather than guess', async () => {
    const r = await wsc(['--help']);
    assert.equal(r.code, 0);
    for (const name of [...ALL_COMMANDS, 'logs']) {
      const hits = r.stdout.split('\n').filter((l) => new RegExp(`^  ${name}\\s`).test(l));
      assert.equal(hits.length, 1, `${name} should be listed once, found ${hits.length}`);
    }
  });

  test('with no command at all it prints the same list', async () => {
    const r = await wsc([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Automations & scripts/);
  });

  test('the commands that change Home Assistant say so, and the read-only ones do not', async () => {
    const r = await wsc(['--help']);
    for (const name of ['call', 'fire-event', 'reload', 'lovelace']) {
      assert.match(r.stdout, new RegExp(`^  ${name}\\s.*\\[changes HA\\]$`, 'm'), `${name} should be marked`);
    }
    for (const name of ['state', 'config-check', 'history', 'running', 'trace-stuck']) {
      assert.doesNotMatch(r.stdout, new RegExp(`^  ${name}\\s.*\\[changes HA\\]`, 'm'), `${name} is read-only`);
    }
    assert.match((await wsc(['call', '--help'])).stdout, /This changes Home Assistant\./);
    assert.match((await wsc(['lovelace', '--help'])).stdout, /save, create and delete change Home Assistant; list and get only read\./);
    assert.doesNotMatch((await wsc(['state', '--help'])).stdout, /changes Home Assistant/);
  });

  test('a clean break: the duplicate and compatibility commands are gone, not hidden', async () => {
    for (const name of DELETED) {
      const r = await wsc([name]);
      assert.equal(r.code, 2, name);
      assert.match(r.stderr, new RegExp(`unknown command '${name}'`));
    }
    const ws = await wsc(['ws', 'state', 'x.y']);
    assert.equal(ws.code, 2, 'the `ws` prefix of the old binary is gone too');
    assert.doesNotMatch((await wsc(['--help'])).stdout, /ha-ws-client|ha-history|states-json|trace-debug/);
  });

  test('an unknown command is exit 2 and names itself in the message', async () => {
    const r = await wsc(['bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command 'bogus'/);
  });

  test('shared flags may come before the command; a command\'s own flags go after it', async () => {
    const { ha } = await world();
    try {
      const r = await wsc(['--json', '--utc', 'states', '--max-items', '2'], { ha });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.command, 'states');
      assert.equal(r.json.data.sample.length, 2);
    } finally { await ha.close(); }
  });

  test('one `history` takes every way of saying how far back: hours, --hours, --days, --from', async () => {
    const { ha } = await world();
    try {
      const hoursBack = () => {
        const sent = reqs(ha, 'history/history_during_period').at(-1);
        assert.equal(sent.end_time, undefined, 'no --to means "up to now": no end_time is sent');
        return (Date.now() - Date.parse(sent.start_time)) / 3600000;
      };
      for (const [args, expected] of [
        [['history', 'sensor.temperature', '6'], 6],
        [['history', 'sensor.temperature', '--hours', '6'], 6],
        [['history', 'sensor.temperature', '--days', '0.25'], 6],
      ]) {
        const r = await wsc(args, { ha });
        assert.equal(r.code, 0, r.stderr);
        assert.ok(Math.abs(hoursBack() - expected) < 0.05, `${args.join(' ')}: asked for ${hoursBack()}h`);
      }
      await wsc(['history', 'sensor.temperature', '--from', '2026-10-17', '--to', '2026-10-17 12:00'], { ha });
      const sent = reqs(ha, 'history/history_during_period').at(-1);
      assert.equal(sent.start_time, '2026-10-17T00:00:00.000Z');
      assert.equal(sent.end_time, '2026-10-17T12:00:00.000Z');
    } finally { await ha.close(); }
  });

  test('two ways of saying how far back is a usage error that names both, not a quiet pick', async () => {
    const { ha } = await world();
    try {
      for (const args of [['history', 'sensor.temperature', '6', '--days', '1'], ['stats', 'sensor.temperature', '--hours', '2', '--days', '1']]) {
        const r = await wsc(args, { ha });
        assert.equal(r.code, 2, args.join(' '));
        assert.match(r.stderr, /give one of .* — not both/);
      }
    } finally { await ha.close(); }
  });

  test('every command, native or ported, is the same tool: the same names, flags anywhere, one envelope', async () => {
    const { ha } = await world();
    try {
      const a = await wsc(['--json', 'history', 'sensor.temperature', '6'], { ha });
      const b = await wsc(['history', 'sensor.temperature', '6', '--json'], { ha });
      assert.equal(a.code, 0, a.stderr);
      assert.equal(a.json.command, 'history');
      assert.deepEqual(a.json.data.map((p) => p.s ?? p.state), ['19.0', '19.5']);
      assert.deepEqual(a.json, b.json, 'a shared flag means the same before or after the command');
    } finally { await ha.close(); }
  });

  test('--json always agrees with the exit code: a failure is success:false and non-zero', async () => {
    const { ha } = await world();
    try {
      const missing = await wsc(['state', 'sensor.nope', '--json'], { ha });
      assert.equal(missing.code, 1);
      assert.equal(missing.json.success, false);
      assert.match(missing.json.error, /entity not found/);
      const usage = await wsc(['state', '--json'], { ha });
      assert.equal(usage.code, 2);
      assert.equal(usage.json.success, false);
    } finally { await ha.close(); }
  });

});

describe('every command documents itself', () => {
  for (const name of ALL_COMMANDS) {
    test(`${name} --help: usage on stdout, exit 0, at least two examples`, async () => {
      const r = await wsc([name, '--help']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^Usage: ha-tools ${name}`, 'm'));
      const examples = r.stdout.split('Examples:')[1] || '';
      const lines = examples.split('\n').filter((l) => l.trim().startsWith(`ha-tools ${name}`));
      assert.ok(lines.length >= 2, `only ${lines.length} example(s) for ${name}`);
    });
  }

  test('a usage error says what was wrong, shows the usage, and exits 2', async () => {
    const r = await wsc(['trace-latest']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing argument/);
    assert.match(r.stderr, /Usage: ha-tools trace-latest <entity_id>/);
  });

  test('an option the command does not have is rejected, not ignored', async () => {
    const r = await wsc(['state', 'x.y', '--domain', 'script']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown option: --domain/);
  });
});

describe('states, services and the rest of the basics', () => {
  let ha;
  before(async () => { ({ ha } = await world()); });
  after(async () => { await ha.close(); });

  test('ping answers with a pong frame, not a result', async () => {
    const r = await wsc(['ping'], { ha });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout.trim(), /^Pong! \(\d+ms\)$/);
    assert.equal((await wsc(['ping', '--json'], { ha })).json.data.latency_ms >= 0, true);
  });

  test('state prints the entity; JSON wraps it in the envelope', async () => {
    const r = await wsc(['state', 'sensor.temperature'], { ha });
    assert.equal(JSON.parse(r.stdout).state, '19.5');
    const j = await wsc(['state', 'sensor.temperature', '--json'], { ha });
    assert.deepEqual(Object.keys(j.json).sort(), ['command', 'data', 'success']);
    assert.equal(j.json.data.entity_id, 'sensor.temperature');
    assert.equal((await wsc(['state', 'sensor.temperature', '--compact'], { ha })).stdout.trim(), 'sensor.temperature=19.5');
  });

  test('an unknown entity is a non-zero exit with a message, never an empty success', async () => {
    const r = await wsc(['state', 'sensor.nope'], { ha });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /entity not found: sensor\.nope/);
  });

  test('states-filter is a case-insensitive glob and --show-age flags stale entities', async () => {
    const r = await wsc(['states-filter', 'LIGHT.*'], { ha });
    assert.match(r.stdout, /Found 1 matching entities/);
    const age = await wsc(['states-filter', 'sensor.temp*', '--show-age'], { ha });
    assert.match(age.stdout, /sensor\.temperature: 19\.5 \(2h ago\) ⚠️/);
    assert.match(age.stdout, /sensor\.temp2: 21\.0 \(10m ago\) ✓/);
  });

  test('call sends the service with its data, and rejects bad JSON before sending', async () => {
    const r = await wsc(['call', 'light', 'turn_on', '{"entity_id":"light.hall","brightness_pct":50}'], { ha });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Service called successfully/);
    assert.deepEqual(reqs(ha, 'call_service').at(-1).service_data, { entity_id: 'light.hall', brightness_pct: 50 });
    const before = reqs(ha, 'call_service').length;
    const bad = await wsc(['call', 'light', 'turn_on', '{nope'], { ha });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /invalid JSON/);
    assert.equal(reqs(ha, 'call_service').length, before, 'a malformed call must not reach HA');
  });

  test('template renders through a subscription', async () => {
    const r = await wsc(['template', '{{ 1 + 1 }}'], { ha });
    assert.equal(r.stdout.trim(), '2');
    assert.equal((await wsc(['template', '{{ 1 + 1 }}', '--json'], { ha })).json.data.result, '2');
  });

  test('fire-event sends the event and its data (the command SKILL.md documented but the old tool never had)', async () => {
    const r = await wsc(['fire-event', 'custom_event', '{"key":"value"}'], { ha });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(reqs(ha, 'fire_event').at(-1), { ...reqs(ha, 'fire_event').at(-1), event_type: 'custom_event', event_data: { key: 'value' } });
  });

  test('device-health calls a device stale after an hour, and lists related entities', async () => {
    const r = await wsc(['device-health', 'sensor.temperature', '--json'], { ha });
    assert.equal(r.json.data.overall_status, 'stale');
    assert.equal(r.json.data.entity.age, '2h');
    const fresh = await wsc(['device-health', 'sensor.temp2', '--json'], { ha });
    assert.equal(fresh.json.data.overall_status, 'ok');
  });

  test('compare reports the attributes that differ', async () => {
    const r = await wsc(['compare', 'sensor.temperature', 'sensor.temp2', '--json'], { ha });
    assert.deepEqual(r.json.data.differences.attributes.extra, { entity1: null, entity2: 'x' });
    assert.equal(r.json.data.differences.state_match, false);
  });

  test('registries filter by glob across id and name', async () => {
    const r = await wsc(['entities', 'temp', '--compact'], { ha });
    assert.match(r.stdout, /sensor\.temperature \(Temperature\)/);
    assert.match(r.stdout, /sensor\.temp2 \(Temp two\) \[disabled\]/);
    assert.doesNotMatch(r.stdout, /light\.hall/);
    assert.match((await wsc(['areas', '--compact'], { ha })).stdout, /hall: Hall \(aliases: corridor\)/);
  });

  test('--max-items truncates text output and says how many were left out', async () => {
    const r = await wsc(['states-filter', '*', '--max-items', '3'], { ha });
    assert.match(r.stdout, /\.\.\. and 7 more/);
  });
});

describe('history shows Home Assistant time', () => {
  let ha;
  before(async () => { ({ ha } = await world()); });
  after(async () => { await ha.close(); });

  test('times carry the HA offset, and --utc opts out', async () => {
    // Text is the aligned form history always had: the zone said once up top.
    const r = await wsc(['history', 'sensor.temperature', '6'], { ha });
    assert.match(r.stdout, /^# times are Europe\/London \(UTC\+0[01]:00\); 2 events$/m);
    assert.match(r.stdout, /^\d\d-\d\d \d\d:\d\d:\d\d  sensor\.temperature  19\.0$/m);
    const utc = await wsc(['history', 'sensor.temperature', '6', '--utc'], { ha });
    assert.match(utc.stdout, /^# times are UTC \(UTC\+00:00\)/m);
    const tsv = await wsc(['history', 'sensor.temperature', '6', '--format', 'tsv'], { ha });
    assert.match(tsv.stdout, /\+0[01]:00\tsensor\.temperature\t19\.0$/m);
  });

  test('--from / --to replace [hours]', async () => {
    await wsc(['logbook', 'light.hall', '--from', '2026-10-17', '--to', '2026-10-17 12:00'], { ha });
    const sent = reqs(ha, 'logbook/get_events').at(-1);
    assert.equal(sent.start_time, '2026-10-17T00:00:00.000Z');
    assert.equal(sent.end_time, '2026-10-17T12:00:00.000Z');
  });

  test('logbook with no entity asks for everything — the form SKILL.md always documented', async () => {
    const r = await wsc(['logbook'], { ha });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs(ha, 'logbook/get_events').at(-1).entity_ids, undefined);
    assert.match(r.stdout, /^Logbook:/m);
    assert.match(r.stdout, /light\.hall on - turned on/);
    await wsc(['logbook', '6'], { ha });
    const sent = reqs(ha, 'logbook/get_events').at(-1);
    assert.equal(sent.entity_ids, undefined, '"6" is hours, not an entity');
    assert.ok(Math.abs((Date.now() - Date.parse(sent.start_time)) / 3600000 - 6) < 0.05);
    await wsc(['logbook', 'light.hall', '6'], { ha });
    assert.deepEqual(reqs(ha, 'logbook/get_events').at(-1).entity_ids, ['light.hall']);
  });

  test('timeline merges entities onto one clock', async () => {
    const r = await wsc(['timeline', '6', 'sensor.temperature', 'light.hall', '--json'], { ha });
    const rows = r.json.data;
    assert.deepEqual(rows.map((x) => x.entity_id), ['sensor.temperature', 'light.hall', 'light.hall', 'sensor.temperature']);
    assert.deepEqual(rows.map((x) => x.time), [...rows.map((x) => x.time)].sort());
  });

  test('a bad hours value is a usage error', async () => {
    const r = await wsc(['history', 'sensor.temperature', 'many'], { ha });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid hours/);
  });

  test('stats-multi keeps going when one entity has no statistics', async () => {
    const r = await wsc(['stats-multi', 'sensor.temperature', 'sensor.missing', '6', '--json'], { ha });
    assert.equal(r.code, 0, r.stderr);
    const d = r.json && r.json.data ? r.json.data : JSON.parse(r.lines.at(-1)).data;
    assert.equal(d.successful, 1);
    assert.equal(d.failed, 1);
  });
});

describe('live subscriptions', () => {
  test('monitor counts changes and shows from -> to', async () => {
    const { ha } = await world(() => ({
      subscribe_trigger: (msg, { push }) => {
        setTimeout(() => push({ variables: { trigger: { from_state: { state: 'off' }, to_state: { state: 'on' } } } }), 80);
        setTimeout(() => push({ variables: { trigger: { from_state: { state: 'on' }, to_state: { state: 'off' } } } }), 160);
        return null;
      },
    }));
    try {
      const r = await wsc(['monitor', 'light.hall', '1'], { ha });
      assert.match(r.stdout, /\[1\] .*: off -> on/);
      assert.match(r.stdout, /\[2\] .*: on -> off/);
      assert.match(r.stdout, /Monitoring complete\. 2 state changes observed\./);
      assert.deepEqual(reqs(ha, 'subscribe_trigger')[0].trigger, { platform: 'state', entity_id: 'light.hall' });
      assert.ok(reqs(ha, 'unsubscribe_events').length >= 1, 'the subscription is released');
      const j = await wsc(['monitor', 'light.hall', '1', '--json'], { ha });
      const changes = j.lines.map((l) => JSON.parse(l)).filter((e) => e.data?.change_num);
      assert.deepEqual(changes.map((c) => c.data.to_state), ['on', 'off']);
    } finally { await ha.close(); }
  });

  test('monitor-multi warns about an entity it could not subscribe to and carries on with the rest', async () => {
    const { ha } = await world(() => ({
      subscribe_trigger: (msg) => { if (msg.trigger.entity_id === 'light.bad') throw new Error('nope'); return null; },
    }));
    try {
      const r = await wsc(['monitor-multi', 'light.hall', 'light.bad', '1'], { ha });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Warning: failed to subscribe to light\.bad/);
      assert.match(r.stdout, /Successfully subscribed to 1\/2 entities/);
    } finally { await ha.close(); }
  });

  test('SIGINT ends a monitor early but still reports, exit 0', async () => {
    const { ha } = await world(() => ({ subscribe_trigger: null }));
    try {
      const { spawn } = await import('node:child_process');
      const { toolsBin, TOKEN, APP_ROOT } = await import('../helpers/fake-ha.mjs');
      const path = await import('node:path');
      const proc = spawn('bash', [path.join(toolsBin(), 'ha-tools'), 'monitor', 'light.hall', '30'], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, HA_TOKEN: TOKEN, HA_TOOLS_NODE_PATH: path.join(APP_ROOT, 'node_modules'), HA_WS_URL: ha.wsUrl }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (c) => { out += c; });
      const closed = new Promise((r) => proc.on('close', r));
      await new Promise((r) => setTimeout(r, 800));
      proc.kill('SIGINT');
      const code = await closed;
      assert.ok(code === 0 || code === null, `exit ${code}`);
      assert.match(out, /Monitoring interrupted\. 0 state changes observed\./);
    } finally { await ha.close(); }
  });
});

describe('traces: domain handling', () => {
  let ha;
  before(async () => { ({ ha } = await world()); });
  after(async () => { await ha.close(); });
  const lastList = () => reqs(ha, 'trace/list').at(-1);

  test('a script.x id selects the script domain by itself', async () => {
    const r = await wsc(['trace-latest', 'script.nick_blind_creep_open', '--json'], { ha });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs(ha, 'trace/get').at(-1).domain, 'script');
    assert.equal(reqs(ha, 'trace/get').at(-1).item_id, 'nick_blind_creep_open');
    assert.equal(r.json.data.run_id, 'r-running');
  });

  test('--domain script does the same for a bare name', async () => {
    const r = await wsc(['trace-latest', '--domain', 'script', 'nick_blind_creep_open', '--json'], { ha });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.data.domain, 'script');
    assert.equal(r.stderr.trim(), '', 'an explicit --domain needs no note');
  });

  test('an automation still resolves through its internal id', async () => {
    const r = await wsc(['trace-latest', 'automation.hall_light_off', '--json'], { ha });
    assert.equal(r.json.data.run_id, 'a1');
    assert.equal(lastList().domain, 'automation');
    assert.equal(lastList().item_id, AUTO_ID);
  });

  test('a bare name is tried as an automation first and falls back to a script, saying so', async () => {
    const r = await wsc(['trace-latest', 'hall_light_off', '--json'], { ha });
    assert.equal(r.json.data.domain, 'automation');
    assert.equal(r.stderr.trim(), '');
    const s = await wsc(['trace-latest', 'nick_blind_creep_open', '--json'], { ha });
    assert.equal(s.json.data.domain, 'script');
    assert.match(s.stderr, /note: no automation matching "nick_blind_creep_open"; using script\.nick_blind_creep_open/);
  });

  test('a conflicting --domain is a usage error that names both', async () => {
    const r = await wsc(['trace-latest', 'script.nick_blind_creep_open', '--domain', 'automation'], { ha });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--domain automation conflicts with script\.nick_blind_creep_open \(a script\)/);
  });

  test('an invalid --domain is a usage error', async () => {
    const r = await wsc(['traces', '--domain', 'scene'], { ha });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid --domain: scene/);
  });

  test('nothing matching says what it tried and exits 1', async () => {
    const r = await wsc(['trace-latest', 'nonexistent'], { ha });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no automation or script matching "nonexistent"/);
    const s = await wsc(['trace-latest', 'script.nonexistent'], { ha });
    assert.equal(s.code, 1);
    assert.match(s.stderr, /no script matching/);
  });

  test('a script\'s traces may be filed under its registry unique_id rather than its object id', async () => {
    const w = buildWorld();
    const renamed = w.scriptRuns.map((r) => ({ ...r, list: { ...r.list, item_id: r.list.item_id === 'nick_blind_creep_open' ? 'UNIQ123' : r.list.item_id },
      detail: { ...r.detail, item_id: r.detail.item_id === 'nick_blind_creep_open' ? 'UNIQ123' : r.detail.item_id } }));
    const h = await startFakeHa({ commands: { ...w.commands,
      'config/entity_registry/get': (m) => ({ entity_id: m.entity_id, unique_id: 'UNIQ123' }),
      'trace/list': (m) => (m.domain === 'script' ? renamed.map((r) => r.list).filter((t) => !m.item_id || t.item_id === m.item_id) : w.commands['trace/list'](m)),
      'trace/get': (m) => renamed.map((r) => r.detail).concat(w.autoRuns.map((r) => r.detail)).find((d) => d.domain === m.domain && d.item_id === m.item_id && d.run_id === m.run_id),
    } });
    try {
      const r = await wsc(['trace-latest', 'script.nick_blind_creep_open', '--json'], { ha: h });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(reqs(h, 'trace/get').at(-1).item_id, 'UNIQ123');
    } finally { await h.close(); }
  });

  test('the newest run wins whichever order HA lists them in', async () => {
    const w = buildWorld();
    const h = await startFakeHa({ commands: { ...w.commands, 'trace/list': (m) => [...w.commands['trace/list'](m)].reverse() } });
    try {
      const r = await wsc(['trace-latest', 'automation.hall_light_off', '--json'], { ha: h });
      assert.equal(r.json.data.run_id, 'a1', 'upstream took whichever was listed first');
    } finally { await h.close(); }
  });

  test('no stored traces is an error with the evidence, not an empty success', async () => {
    const r = await wsc(['trace-latest', 'automation.no_traces'], { ha });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no stored traces for automation\.no_traces/);
    assert.match(r.stderr, /last_triggered/);
  });
});

describe('traces: the trace commands on a script', () => {
  let ha;
  before(async () => { ({ ha } = await world()); });
  after(async () => { await ha.close(); });
  const SCRIPT = 'script.nick_blind_creep_open';

  test('traces lists a script\'s runs newest first and marks the running one; JSON keeps HA\'s order', async () => {
    const r = await wsc(['traces', SCRIPT, '--compact'], { ha });
    assert.match(r.stdout.split('\n')[1], /^script\.nick_blind_creep_open r-running running /);
    assert.match(r.stdout.split('\n')[2], /r-done finished/);
    const j = await wsc(['traces', SCRIPT, '--json'], { ha });
    assert.deepEqual(j.json.data.map((t) => t.run_id), ['r-running', 'r-done']);
    assert.equal(j.json.count, 2);
  });

  test('traces with no entity lists the whole domain', async () => {
    const r = await wsc(['traces', '--domain', 'script', '--json'], { ha });
    assert.equal(r.json.data.length, 4);
    const a = await wsc(['traces', '--json'], { ha });
    assert.equal(a.json.data.length, 3, 'the default domain is automation');
  });

  test('traces --from drops older runs', async () => {
    const from = new Date(Date.now() - 60 * MIN).toISOString();
    const r = await wsc(['traces', '--domain', 'script', '--from', from.slice(0, 16).replace('T', ' '), '--json'], { ha });
    assert.deepEqual(r.json.data.map((t) => t.run_id).sort(), ['c-run', 'cl-run', 'r-running']);
  });

  test('trace-timeline is chronological and places nested steps in the config', async () => {
    const r = await wsc(['trace-timeline', SCRIPT, 'r-done', '--json'], { ha });
    const rows = r.json.data;
    assert.deepEqual(rows.map((x) => x.timestamp), [...rows.map((x) => x.timestamp)].sort());
    const nested = rows.find((x) => x.path === 'sequence/1/parallel/0/sequence/1');
    assert.equal(nested.breadcrumb, 'sequence[1] › parallel branch 0 › sequence[1]');
    assert.equal(nested.type, 'service');
    assert.match(nested.action, /^cover\.set_cover_position cover\.blind/);
    const choose = rows.find((x) => x.path === 'sequence/2/choose/0/sequence/0');
    assert.equal(choose.breadcrumb, 'sequence[2] › choose option 0 › sequence[0]');
    assert.ok(rows.find((x) => x.path === 'sequence/3/else/0'), 'if/else steps are present');
    assert.match(nested.time, /[+-]\d\d:\d\d$/);
  });

  test('trace-actions finds a script\'s steps (they are sequence/…, not action/…) and drops triggers and conditions', async () => {
    const r = await wsc(['trace-actions', SCRIPT, 'r-done', '--json'], { ha });
    const paths = r.json.data.map((x) => x.path);
    assert.ok(paths.includes('sequence/1/parallel/0/sequence/1'));
    assert.ok(paths.includes('sequence/2/choose/0/sequence/0'));
    const a = await wsc(['trace-actions', 'automation.hall_light_off', 'a1', '--json'], { ha });
    assert.deepEqual(a.json.data.map((x) => x.path), ['action/0'], 'trigger/0 and condition/0 are not actions');
    assert.equal(a.json.data[0].result.params.service, 'turn_off');
  });

  test('trace-vars reports variables in the order steps ran', async () => {
    const r = await wsc(['trace-vars', SCRIPT, 'r-done', '--json'], { ha });
    assert.deepEqual(r.json.data[0], { path: 'sequence/0', changed_variables: { target_pos: 40 } });
  });

  test('trace-trigger says scripts have none and shows the context instead', async () => {
    const r = await wsc(['trace-trigger', SCRIPT, 'r-done'], { ha });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Scripts have no trigger/);
    const j = await wsc(['trace-trigger', SCRIPT, 'r-done', '--json'], { ha });
    assert.equal(j.json.data.trigger, null);
    assert.equal(j.json.data.context.id, 'RC-done');
    const a = await wsc(['trace-trigger', 'automation.hall_light_off', 'a1', '--json'], { ha });
    assert.equal(a.json.data, 'state of binary_sensor.stairs');
  });

  test('trace-summary counts runs and says one is still running', async () => {
    const r = await wsc(['trace-summary', SCRIPT, '--json'], { ha });
    assert.equal(r.json.data.total_traces, 2);
    assert.equal(r.json.data.finished, 1);
    assert.equal(r.json.data.running, 1);
    assert.equal(r.json.data.domain, 'script');
    assert.equal(r.json.data.automation_id, undefined, 'only automations carry the legacy key');
    const a = await wsc(['trace-summary', 'automation.hall_light_off', '--json'], { ha });
    assert.equal(a.json.data.automation_id, 'automation.hall_light_off');
    assert.equal(a.json.data.errors, 1);
    assert.equal(a.json.data.last_run.state, 'finished');
  });

  test('trace returns the raw run for a given run_id', async () => {
    const r = await wsc(['trace', SCRIPT, 'r-done', '--json'], { ha });
    assert.equal(r.json.data.run_id, 'r-done');
    assert.ok(r.json.data.config.sequence, 'raw config, not a re-serialised subset');
  });

  test('a run id HA does not have is a failure with HA\'s own message', async () => {
    const r = await wsc(['trace', SCRIPT, 'nope'], { ha });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Trace not found/);
  });

  test('automation-config reads a script\'s config from its latest trace', async () => {
    const r = await wsc(['automation-config', SCRIPT, '--json'], { ha });
    assert.equal(r.json.data.alias, 'Blind creep open');
  });
});

describe('running', () => {
  let ha;
  before(async () => { ({ ha } = await world()); });
  after(async () => { await ha.close(); });

  test('lists every running script, longest first, with mode, run count, duration and the branch it is on', async () => {
    const r = await wsc(['running'], { ha });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^# times are Europe\/London \(UTC\+0[01]:00\); 3 running$/);
    assert.match(lines[1], /^ENTITY\s+MODE\s+RUNS\s+RUNNING FOR\s+STARTED\s+LAST TRIGGERED\s+EFFECT\s+LAST STEP$/);
    assert.match(lines[2], /^script\.nick_blind_creep_open\s+single\s+1\/1\s+0:42:0\d\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+0[01]:00\s+\d{4}.*new runs dropped\s+sequence\[1\] › parallel branch 1 › sequence\[0\]$/);
    assert.match(lines[3], /^script\.caller\s+single/);
    assert.match(lines[4], /^script\.child_script\s+queued\s+1\/3\s+0:19:5\d/);
    assert.doesNotMatch(r.stdout, /script\.idle/, 'a script that is off is not running');
  });

  test('JSON has the facts as fields', async () => {
    const r = await wsc(['running', '--json'], { ha });
    // data is the list of runs; the zone their times are in rides in the envelope.
    const running = r.json.data;
    assert.equal(r.json.timezone, 'Europe/London');
    assert.equal(r.json.count, 3);
    const blind = running[0];
    assert.equal(blind.entity_id, 'script.nick_blind_creep_open');
    assert.equal(blind.mode, 'single');
    assert.equal(blind.current, 1);
    assert.equal(blind.max, 1);
    assert.equal(blind.run_id, 'r-running');
    assert.ok(blind.running_for_s >= 42 * 60 && blind.running_for_s < 42 * 60 + 30, `${blind.running_for_s}`);
    assert.equal(blind.effect, 'new runs dropped');
    assert.equal(blind.last_step, 'sequence/1/parallel/1/sequence/0');
    assert.match(blind.started, /[+-]\d\d:\d\d$/);
    assert.match(blind.last_triggered, /[+-]\d\d:\d\d$/);
    assert.deepEqual(running.map((x) => x.entity_id), ['script.nick_blind_creep_open', 'script.caller', 'script.child_script']);
  });

  test('--utc prints UTC', async () => {
    const r = await wsc(['running', '--utc', '--json'], { ha });
    assert.equal(r.json.timezone, 'UTC');
    assert.match(r.json.data[0].started, /\+00:00$/);
  });

  test('--compact is one line per run; --no-headers drops the header', async () => {
    const c = await wsc(['running', '--compact', '--no-headers'], { ha });
    assert.equal(c.lines.length, 3);
    assert.match(c.lines[0], /^script\.nick_blind_creep_open single 1\/1 0:42:\d\d sequence\/1\/parallel\/1\/sequence\/0$/);
  });

  test('--domain narrows it, and nothing running is an empty list with exit 0', async () => {
    const a = await wsc(['running', '--domain', 'automation', '--json'], { ha });
    assert.equal(a.code, 0);
    assert.deepEqual(a.json.data, []);
    assert.equal(a.json.count, undefined, 'an empty list carries no count');
    const t = await wsc(['running', '--domain', 'automation'], { ha });
    assert.match(t.stdout, /; 0 running$/m);
  });

  test('an automation counts as running by its current>0, not by being "on"', async () => {
    const w = buildWorld();
    const states = w.states.map((s) => (s.entity_id === 'automation.hall_light_off' ? { ...s, attributes: { ...s.attributes, current: 2, mode: 'queued', max: 2 } } : s));
    const h = await startFakeHa({ commands: { ...w.commands, get_states: states,
      'trace/list': (m) => (m.domain === 'automation' ? w.commands['trace/list'](m).map((t, i) => (i === 0 ? { ...t, state: 'running', timestamp: { start: t.timestamp.start } } : t)) : w.commands['trace/list'](m)) } });
    try {
      const r = await wsc(['running', '--domain', 'automation', '--json'], { ha: h });
      const [row] = r.json.data;
      assert.equal(row.entity_id, 'automation.hall_light_off');
      assert.equal(row.effect, 'new runs dropped (queue full)');
      assert.equal(row.current, 2);
      const idle = await wsc(['running', '--domain', 'automation', '--json'], { ha });
      assert.deepEqual(idle.json.data, [], 'enabled-but-idle automations are not running');
    } finally { await h.close(); }
  });

  test('running with no running trace stored: unknown duration, never guessed from last_triggered', async () => {
    const w = buildWorld();
    const h = await startFakeHa({ commands: { ...w.commands, 'trace/list': (m) => w.commands['trace/list'](m).filter((t) => t.state !== 'running') } });
    try {
      const j = await wsc(['running', '--domain', 'script', '--json'], { ha: h });
      const row = j.json.data.find((x) => x.entity_id === 'script.nick_blind_creep_open');
      assert.equal(row.started, null);
      assert.equal(row.running_for_s, null);
      assert.match(row.note, /no running trace stored/);
      assert.ok(row.last_triggered, 'last_triggered is still reported, as itself');
      const t = await wsc(['running', '--domain', 'script'], { ha: h });
      assert.match(t.stdout, /script\.nick_blind_creep_open\s+single\s+1\/1\s+\?\s+-/);
      assert.match(t.stdout, /no running trace is stored/);
    } finally { await h.close(); }
  });
});

describe('trace-stuck', () => {
  let ha;
  before(async () => { ({ ha } = await world()); });
  after(async () => { await ha.close(); });
  const BLIND = 'script.nick_blind_creep_open';

  test('names every waiting branch of a parallel script, deepest first, and what each waits on', async () => {
    const r = await wsc(['trace-stuck', BLIND], { ha });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^script\.nick_blind_creep_open — run r-running running for 0:42:\d\d/m);
    const out = r.stdout;
    const first = out.indexOf('waiting at: sequence[1] › parallel branch 1 › sequence[0]');
    const second = out.indexOf('also waiting at: sequence[1] › parallel branch 0 › sequence[0]');
    assert.ok(first !== -1 && second > first, out);
    assert.match(out, /wait_template "\{\{ is_state\('binary_sensor\.stairs', 'off'\) \}\}" \(timeout 00:30:00\)/);
    assert.match(out, /template currently renders: "2"/);
    assert.match(out, /delay 0:05:00 — remaining: overdue by 0:37:\d\d/);
  });

  test('JSON carries the same facts as fields', async () => {
    const r = await wsc(['trace-stuck', BLIND, '--json'], { ha });
    const d = r.json.data;
    assert.equal(d.entity_id, BLIND);
    assert.equal(d.running.length, 1);
    const run = d.running[0];
    assert.equal(run.run_id, 'r-running');
    assert.equal(run.open_steps.length, 2);
    const [primary, other] = run.open_steps;
    assert.equal(primary.primary, true);
    assert.equal(primary.path, 'sequence/1/parallel/1/sequence/0');
    assert.equal(primary.type, 'wait_template');
    assert.equal(primary.explicit, true);
    assert.equal(primary.waiting_on.kind, 'wait_template');
    assert.equal(primary.waiting_on.timeout, '00:30:00');
    assert.equal(primary.waiting_on.currently_renders, '2');
    assert.equal(other.path, 'sequence/1/parallel/0/sequence/0');
    assert.equal(other.waiting_on.kind, 'delay');
    assert.equal(other.waiting_on.configured_s, 300);
    assert.ok(other.waiting_on.remaining_s < 0);
    assert.match(other.waiting_on.remaining, /^overdue by/);
    assert.equal(r.json.timezone, 'Europe/London');
    assert.match(run.started, /[+-]\d\d:\d\d$/);
  });

  test('--no-render does not ask HA to render the wait condition', async () => {
    const before = reqs(ha, 'render_template').length;
    const r = await wsc(['trace-stuck', BLIND, '--no-render', '--json'], { ha });
    assert.equal(reqs(ha, 'render_template').length, before);
    assert.equal(r.json.data.running[0].open_steps[0].waiting_on.currently_renders, undefined);
  });

  test('a render that fails is reported as such, not as a false', async () => {
    const w = buildWorld();
    const h = await startFakeHa({ commands: { ...w.commands, render_template: (m, { push }) => { setTimeout(() => push({ error: 'UndefinedError: trigger is undefined', level: 'ERROR' }), 10); return null; } } });
    try {
      const r = await wsc(['trace-stuck', BLIND, '--json'], { ha: h });
      const waiting = r.json.data.running[0].open_steps[0].waiting_on;
      assert.match(waiting.render_error, /trigger is undefined/);
      assert.equal(waiting.currently_renders, null);
    } finally { await h.close(); }
  });

  test('follows a script call into the child run and shows what that is waiting on', async () => {
    const r = await wsc(['trace-stuck', 'script.caller', '--json'], { ha });
    const [step] = r.json.data.running[0].open_steps;
    assert.equal(step.type, 'script_call');
    assert.equal(step.waiting_on.calls, 'script.child_script');
    assert.equal(step.explicit, false, 'a call with no result yet is inferred from last_step, and says so');
    assert.equal(step.child.run_id, 'c-run');
    assert.equal(step.child.open_steps[0].waiting_on.kind, 'delay');
    assert.equal(step.child.open_steps[0].waiting_on.configured_s, 600);
    const text = await wsc(['trace-stuck', 'script.caller'], { ha });
    assert.match(text.stdout, /\[inferred from last_step\]/);
    assert.match(text.stdout, /child script\.child_script run c-run/);
    assert.match(text.stdout, /delay 0:10:00/);
  });

  test('--no-follow stops at the call', async () => {
    const r = await wsc(['trace-stuck', 'script.caller', '--no-follow', '--json'], { ha });
    const [step] = r.json.data.running[0].open_steps;
    assert.equal(step.child, undefined);
    assert.equal(step.waiting_on.child_run_id, 'c-run');
  });

  test('a script that is not running reports the latest run instead, and exits 0', async () => {
    const r = await wsc(['trace-stuck', 'automation.hall_light_off'], { ha });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /automation\.hall_light_off is not running\./);
    assert.match(r.stdout, /latest run: a1\s+finished\s+started/);
    const j = await wsc(['trace-stuck', 'automation.hall_light_off', '--json'], { ha });
    assert.deepEqual(j.json.data.running, []);
    assert.equal(j.json.data.latest.run_id, 'a1');
  });

  test('asking about a specific finished run says it finished rather than inventing a wait', async () => {
    const r = await wsc(['trace-stuck', BLIND, 'r-done'], { ha });
    assert.match(r.stdout, /not running run r-done/);
    assert.match(r.stdout, /run r-done finished \(finished\); last step sequence\/3\/else\/0/);
  });

  test('a script with no traces at all says so', async () => {
    const r = await wsc(['trace-stuck', 'script.idle'], { ha });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /script\.idle is not running\./);
    assert.match(r.stdout, /no stored traces\./);
  });
});

describe('trace-watch works for scripts', () => {
  test('reports a new script run when one appears', async () => {
    const w = buildWorld();
    let calls = 0;
    const fresh = { ...w.scriptRuns[1].list, run_id: 'r-new', timestamp: { start: new Date().toISOString(), finish: new Date().toISOString() } };
    const h = await startFakeHa({ commands: { ...w.commands,
      // The resolver also asks for the whole domain (no item_id); only watch's own polls count.
      'trace/list': (m) => { if (m.domain !== 'script' || !m.item_id) return w.commands['trace/list'](m); calls++; return calls === 1 ? [w.scriptRuns[1].list] : [w.scriptRuns[1].list, fresh]; },
      'trace/get': (m) => (m.run_id === 'r-new' ? { ...w.scriptRuns[1].detail, run_id: 'r-new' } : w.commands['trace/get'](m)),
    } });
    try {
      const r = await runTool('ha-tools', ['trace-watch', 'script.nick_blind_creep_open', '--timeout', '5s', '--interval', '1s', '--format', 'json'], { ha: h });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.data.entity_id, 'script.nick_blind_creep_open');
      assert.equal(r.json.data.run_id, 'r-new');
    } finally { await h.close(); }
  });

  test('times out with a message that says a script did not run, exit 1', async () => {
    const { ha } = await world();
    try {
      const r = await runTool('ha-tools', ['trace-watch', '--domain', 'script', 'nick_blind_creep_open', '--timeout', '1s', '--interval', '1s'], { ha });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /has not run/);
    } finally { await ha.close(); }
  });
});

describe('the native commands honour the same contract', () => {
  test('config-check: --json success mirrors the verdict, and an invalid config still exits 1', async () => {
    const QUIET = '2026-08-25 01:10:00.000 INFO (MainThread) [homeassistant.core] Bus:Handling <Event x>';
    const good = await startFakeHa({ rest: { 'core/api/config/core/check_config': { result: 'valid', errors: null } }, logs: { 'core/logs': QUIET } });
    const bad = await startFakeHa({ rest: { 'core/api/config/core/check_config': { result: 'invalid', errors: 'bad indentation' } }, logs: { 'core/logs': QUIET } });
    try {
      const ok = await runTool('ha-tools', ['config-check', '--json'], { ha: good });
      assert.equal(ok.code, 0);
      assert.equal(ok.json.success, true);
      assert.equal(ok.json.data.result, 'valid');
      const nope = await runTool('ha-tools', ['config-check', '--json'], { ha: bad });
      assert.equal(nope.code, 1);
      assert.equal(nope.json.success, false, 'the envelope must not say success while the exit code says failure');
      assert.equal(nope.json.data.result, 'invalid');
      assert.match(nope.json.error, /not valid/);
    } finally { await good.close(); await bad.close(); }
  });

  test('config-check and reload need no WebSocket: they are REST-only', async () => {
    const ha = await startFakeHa({ authFails: true, rest: { 'core/api/config/core/check_config': { result: 'valid', errors: null } }, logs: { 'core/logs': 'x' } });
    try {
      const r = await runTool('ha-tools', ['config-check'], { ha });
      assert.equal(r.code, 0, r.stderr);
    } finally { await ha.close(); }
  });

  test('reload --expect is repeatable and a missing entity fails the envelope as well as the exit code', async () => {
    const ha = await startFakeHa({
      commands: { get_states: [{ entity_id: 'cover.a', state: 'open' }] },
      rest: { 'core/api/services/template/reload': [] },
      logs: { 'core/logs': 'x' },
    });
    try {
      const r = await runTool('ha-tools', ['reload', 'template', '--expect', 'cover.a', '--expect', 'cover.b', '--expect-timeout', '1s', '--json'], { ha });
      assert.equal(r.code, 1);
      assert.equal(r.json.success, false);
      assert.deepEqual(r.json.data.expected, { 'cover.a': 'present', 'cover.b': 'missing' });
    } finally { await ha.close(); }
  });

  test('lovelace: a config saved from `get --json` (the envelope) can be saved straight back', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const ha = await startFakeHa({ commands: { 'lovelace/config': { views: [{ title: 'Home' }] }, 'lovelace/config/save': null } });
    try {
      const got = await runTool('ha-tools', ['lovelace', 'get', 'energy', '--json'], { ha });
      assert.equal(got.json.data.views[0].title, 'Home');
      const file = path.join(mkdtempSync(path.join(tmpdir(), 'll-')), 'energy.json');
      writeFileSync(file, got.stdout);
      const saved = await runTool('ha-tools', ['lovelace', 'save', file, 'energy'], { ha });
      assert.equal(saved.code, 0, saved.stderr);
      assert.deepEqual(reqs(ha, 'lovelace/config/save').at(-1).config, { views: [{ title: 'Home' }] }, 'the config inside the envelope is what is saved');
    } finally { await ha.close(); }
  });

  test('global flags work before a native command too, and --utc reaches it', async () => {
    const { ha } = await world();
    try {
      const r = await wsc(['--utc', 'timeline', 'light.hall', '--json'], { ha });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.timezone, 'UTC');
    } finally { await ha.close(); }
  });

  test('a REST-only command with a bad option is a usage error, not a connection attempt', async () => {
    const r = await runTool('ha-tools', ['reload', '--expect-timeout', 'soon'], { env: { HA_TOKEN: '', SUPERVISOR_TOKEN: '' } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid --expect-timeout/);
  });
});

describe('no command accepts a flag it would ignore', () => {
  test('a listing flag on a command with no list is a usage error, not a quiet no-op', async () => {
    const { ha } = await world();
    try {
      for (const args of [['state', 'sensor.temperature', '--max-items', '1'], ['config', '--from', '2026-10-17'], ['ping', '--show-age'], ['running', '--max-items', '1']]) {
        const r = await wsc(args, { ha });
        assert.equal(r.code, 2, args.join(' '));
        assert.match(r.stderr, /unknown option/);
      }
      assert.equal((await wsc(['states-filter', '*', '--max-items', '2', '--show-age'], { ha })).code, 0);
      assert.equal((await wsc(['traces', '--domain', 'script', '--max-items', '2', '--from', '2026-01-01'], { ha })).code, 0);
    } finally { await ha.close(); }
  });

  test('every command that declares --max-items or --from says so in its --help', async () => {
    const hist = await wsc(['timeline', '--help']);
    assert.match(hist.stdout, /--from \/ --to/);
    const states = await wsc(['states-filter', '--help']);
    assert.match(states.stdout, /--max-items N/);
    assert.match(states.stdout, /--show-age/);
  });
});

describe('what an agent relies on staying true', () => {
  test('--compact never drops fields: a document prints complete, on one line', async () => {
    const good = await startFakeHa({
      rest: { 'core/api/config/core/check_config': { result: 'valid', errors: null, warnings: null, extra: 'kept', more: 1, evenmore: 2, again: 3 } },
      logs: { 'core/logs': 'x' },
    });
    try {
      const r = await wsc(['config-check', '--compact'], { ha: good });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.lines.length, 1);
      const parsed = JSON.parse(r.lines[0]);
      assert.deepEqual(Object.keys(parsed).sort(), ['again', 'errors', 'evenmore', 'extra', 'more', 'result', 'warnings']);
    } finally { await good.close(); }
  });

  test('trace-watch waits 100s by default — a foreground command is cut off at about two minutes', async () => {
    const r = await wsc(['trace-watch', '--help']);
    assert.match(r.stdout, /--timeout 100s/);
    assert.match(r.stdout, /default is 100s/);
    assert.doesNotMatch(r.stdout, /15m/);
  });

  test('--max-items says it is for text output: --json is never truncated', async () => {
    const { ha } = await world();
    try {
      const r = await wsc(['states-filter', '*', '--max-items', '2', '--json'], { ha });
      assert.ok(r.json.data.length > 2);
    } finally { await ha.close(); }
  });
});

