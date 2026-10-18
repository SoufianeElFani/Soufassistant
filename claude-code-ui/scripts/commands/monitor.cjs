/*
 * monitor — live subscriptions (watch, monitor, monitor-multi) and analyze.
 * Ported from ha-ws-client (MIT, see NOTICE).
 *
 * Each subscribes to a state trigger and prints every change until the time is
 * up. Ctrl+C stops early and still reports what was seen, exiting 0 as before.
 */
const { UsageError } = require('../lib/ha-args.cjs');
const { toMillis } = require('../lib/ha-time.cjs');
const { timeRange, windowOf } = require('./history.cjs');

/** Resolves true when the time is up, false if interrupted first. */
function sleepOrInterrupt(ms) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); process.off('SIGINT', onSig); process.off('SIGTERM', onSig); resolve(v); };
    const onSig = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
  });
}

function seconds(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`invalid seconds: ${raw}`);
  return Number(raw);
}

/** Pull (from, to) out of a state-trigger event. */
function change(event) {
  const trig = event?.variables?.trigger;
  const to = trig?.to_state;
  if (!to) return null;
  return { from: trig.from_state ? String(trig.from_state.state) : '', to: to.state };
}

const monitor = {
  name: 'monitor',
  usage: '<entity_id> [seconds]',
  summary: 'Print an entity\'s state changes live for N seconds, from → to, and count them (default 60 seconds; Ctrl+C reports what was seen).',
  examples: [['sensor.power 120'], ['cover.blind --json']],
  min: 1,
  max: 2,
  async run({ ws, pos, out }) {
    const entityId = pos[0];
    const secs = seconds(pos[1], 60);
    out.message(`Monitoring ${entityId} for ${secs} seconds... (Ctrl+C to stop)`);
    let count = 0;
    const sub = await ws.subscribe({ type: 'subscribe_trigger', trigger: { platform: 'state', entity_id: entityId } }, (event) => {
      const c = change(event);
      if (!c) return;
      count++;
      if (out.isJson) out.data({ timestamp: new Date().toISOString(), entity_id: entityId, from_state: c.from, to_state: c.to, change_num: count });
      else console.log(`[${count}] ${out.stamp(Date.now())}: ${c.from} -> ${c.to}`);
    });
    const finished = await sleepOrInterrupt(secs * 1000);
    await sub.unsubscribe();
    out.message(`Monitoring ${finished ? 'complete' : 'interrupted'}. ${count} state changes observed.`);
  },
};

const monitorMulti = {
  name: 'monitor-multi',
  usage: '<entity_id> [entity_id…] [seconds]',
  summary: 'Monitor several entities at once; a trailing number is the seconds (default 60).',
  examples: [['light.a light.b'], ['sensor.x sensor.y sensor.z 300']],
  min: 1,
  async run({ ws, pos, out }) {
    let secs = 60;
    let entities = pos;
    if (pos.length > 1 && /^\d+$/.test(pos[pos.length - 1])) {
      secs = Number(pos[pos.length - 1]);
      entities = pos.slice(0, -1);
    }
    out.message(`Monitoring ${entities.length} entities for ${secs} seconds... (Ctrl+C to stop)`);
    let count = 0;
    const subs = [];
    for (const entityId of entities) {
      try {
        subs.push(await ws.subscribe({ type: 'subscribe_trigger', trigger: { platform: 'state', entity_id: entityId } }, (event) => {
          const c = change(event);
          if (!c) return;
          count++;
          if (out.isJson) out.data({ timestamp: new Date().toISOString(), entity_id: entityId, from_state: c.from, to_state: c.to, change_num: count });
          else console.log(`[${count}] ${out.stamp(Date.now())} ${entityId}: ${c.from} -> ${c.to}`);
        }));
      } catch (e) {
        out.message(`Warning: failed to subscribe to ${entityId}: ${e.message}`);
      }
    }
    if (!subs.length) throw new Error('failed to subscribe to any entities');
    out.message(`Successfully subscribed to ${subs.length}/${entities.length} entities`);
    const finished = await sleepOrInterrupt(secs * 1000);
    await Promise.all(subs.map((s) => s.unsubscribe()));
    out.message(`Monitoring ${finished ? 'complete' : 'interrupted'}. ${count} state changes observed.`);
  },
};

const analyze = {
  name: 'analyze',
  usage: '<entity_id>',
  summary: 'Current state plus how often it changed, and to what, over the last 24 hours.',
  examples: [['light.hall'], ['binary_sensor.stairs --json']],
  min: 1,
  max: 1,
  async run({ ws, pos, opt, out }) {
    const entityId = pos[0];
    const states = (await ws.send({ type: 'get_states' })) || [];
    const current = states.find((s) => s.entity_id === entityId);
    if (!current) throw new Error(`entity not found: ${entityId}`);
    const r = timeRange(opt, undefined);
    const result = await ws.send({
      type: 'history/history_during_period', entity_ids: [entityId],
      ...windowOf(r), minimal_response: true, no_attributes: true,
    });
    const rows = (result || {})[entityId] || [];
    const distribution = {};
    for (const s of rows) {
      const st = s.s ?? s.state ?? '';
      distribution[st] = (distribution[st] || 0) + 1;
    }
    out.data({
      entity_id: entityId,
      current_state: current.state,
      attributes: current.attributes,
      history_hours: 24,
      state_changes: rows.length,
      state_distribution: distribution,
    }, { command: 'analyze' });
  },
};

module.exports = { commands: [monitor, monitorMulti, analyze], sleepOrInterrupt, toMillis };
