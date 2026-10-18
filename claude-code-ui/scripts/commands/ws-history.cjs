/*
 * ws-history — the fixed-window history commands ha-ws-client had: logbook,
 * history, history-full, attrs, timeline, syslog, stats, stats-multi, context.
 *
 * Several share a name with a native ha-tools command (`history`, `stats`,
 * `timeline`) that takes a date range instead of "the last N hours". The two are
 * different tools with different arguments, so these register under `ws-`
 * names, and `ha-ws-client history` (or `ha-tools ws history`) maps onto them.
 * Ported from ha-ws-client (MIT, see NOTICE).
 */
const { UsageError, parseFlexibleDate } = require('../lib/ha-args.cjs');
const { toMillis } = require('../lib/ha-time.cjs');

const RANGE_FLAGS = {};

/** `[hours]` positional (default 24), overridden by --from/--to. */
function timeRange(opt, hoursArg, defaultHours = 24) {
  const end = opt.to ? parseFlexibleDate(opt.to) : new Date();
  let start;
  if (opt.from) start = parseFlexibleDate(opt.from);
  else {
    let hours = defaultHours;
    if (hoursArg !== undefined) {
      if (!/^\d+$/.test(hoursArg)) throw new UsageError(`invalid hours: ${hoursArg}`);
      hours = Number(hoursArg);
    }
    start = new Date(end.getTime() - hours * 3600 * 1000);
  }
  return { start, end, startISO: start.toISOString(), endISO: end.toISOString(), hours: (end - start) / 3600000 };
}

const lastUpdatedMs = (s) => toMillis(s.lu ?? s.last_updated ?? s.lc ?? s.last_changed);
const stateOf = (s) => s.s ?? s.state;

const HOURS_EXAMPLES = (name, entity) => [[`${entity}`, 'last 24 hours'], [`${entity} 6`, 'last 6 hours'], [`${entity} --from 2026-10-17 --to "2026-10-17 12:00"`]];

const logbook = {
  name: 'logbook',
  usage: '[entity_id] [hours]',
  summary: 'Logbook entries (default last 24 hours) — for one entity, or for everything when none is given.',
  details: 'Unlike ha-ws-client of old, the entity is optional: SKILL.md always documented `logbook` on its own.',
  examples: [['light.hall', 'one entity, last 24 hours'], ['light.hall 6', 'last 6 hours'], ['', 'everything, last 24 hours'], ['6', 'everything, last 6 hours']],
  max: 2,
  flagHelp: { '--from / --to': 'a date (YYYY-MM-DD[ HH:MM]) instead of [hours]' },
  async run({ ws, pos, opt, out }) {
    // `logbook 6` means six hours of everything, not an entity called "6".
    const [entity, hoursArg] = pos.length && /^\d+$/.test(pos[0]) && pos.length === 1 ? [undefined, pos[0]] : pos;
    const r = timeRange(opt, hoursArg);
    const message = { type: 'logbook/get_events', start_time: r.startISO, end_time: r.endISO };
    if (entity) message.entity_ids = [entity];
    const entries = (await ws.send(message)) || [];
    out.timeline(entries, {
      title: entity ? `Logbook for ${entity}` : 'Logbook',
      command: 'logbook',
      formatter: (e) => {
        const what = !entity && e.entity_id ? `${e.entity_id} ` : '';
        return `${out.stamp(toMillis(e.when))}: ${what}${e.state ?? ''} - ${e.message ?? ''}`.replace(/ - $/, '');
      },
    });
  },
};

function historyCommand({ name, command, title, full }) {
  return {
    name,
    usage: '<entity_id> [hours]',
    summary: full
      ? 'State history with all attributes (default last 24 hours).'
      : 'State history for an entity (default last 24 hours).',
    examples: HOURS_EXAMPLES(name, 'sensor.temperature'),
    min: 1,
    max: 2,
    async run({ ws, pos, opt, out }) {
      const r = timeRange(opt, pos[1]);
      const result = await ws.send({
        type: 'history/history_during_period',
        entity_ids: [pos[0]],
        start_time: r.startISO,
        end_time: r.endISO,
        minimal_response: !full,
        no_attributes: !full,
        ...(full ? {} : { significant_changes_only: false }),
      });
      const states = (result || {})[pos[0]] || [];
      out.timeline(states, {
        title: `${title} ${pos[0]}`,
        command,
        formatter: (s) => {
          const t = out.stamp(lastUpdatedMs(s));
          if (!full) return `${t}: ${stateOf(s)}`;
          const attrs = s.a ?? s.attributes;
          if (!attrs || !Object.keys(attrs).length) return `${t}: ${stateOf(s)}`;
          if (out.isCompact) return `${t} ${stateOf(s)} {${Object.entries(attrs).map(([k, v]) => `${k}:${v}`).join(', ')}}`;
          return `${t}: ${stateOf(s)}\n    ${JSON.stringify(attrs, null, 2).replace(/\n/g, '\n    ')}`;
        },
      });
    },
  };
}

const attrs = {
  name: 'attrs',
  usage: '<entity_id> [hours]',
  summary: 'Attribute change history: each state with its attributes (default last 24 hours).',
  examples: HOURS_EXAMPLES('attrs', 'climate.thermostat'),
  min: 1,
  max: 2,
  async run({ ws, pos, opt, out }) {
    const r = timeRange(opt, pos[1]);
    const result = await ws.send({
      type: 'history/history_during_period', entity_ids: [pos[0]],
      start_time: r.startISO, end_time: r.endISO, minimal_response: false, no_attributes: false,
    });
    const changes = ((result || {})[pos[0]] || []).map((s) => ({
      time: new Date(lastUpdatedMs(s)).toISOString(), state: stateOf(s), attributes: s.a ?? s.attributes ?? null,
    }));
    out.timeline(changes, {
      title: `Attribute history for ${pos[0]}`,
      command: 'attrs',
      formatter: (c) => `${out.stamp(toMillis(c.time))}: ${c.state} ${JSON.stringify(c.attributes)}`,
    });
  },
};

const timeline = {
  name: 'ws-timeline',
  usage: '<hours> <entity_id> [entity_id…]',
  summary: 'Several entities\' state changes on one clock, over the last N hours. (For a date range or a time-of-day filter use `ha-tools timeline`.)',
  examples: [['6 light.hall binary_sensor.stairs'], ['24 sensor.a sensor.b --compact']],
  min: 2,
  async run({ ws, pos, opt, out }) {
    const [hoursArg, ...entities] = pos;
    const r = timeRange(opt, hoursArg);
    const result = await ws.send({
      type: 'history/history_during_period', entity_ids: entities,
      start_time: r.startISO, end_time: r.endISO, minimal_response: true, no_attributes: true,
    });
    const rows = [];
    for (const [entityId, states] of Object.entries(result || {})) {
      for (const s of states || []) rows.push({ ms: lastUpdatedMs(s), entity_id: entityId, state: stateOf(s) });
    }
    rows.sort((a, b) => a.ms - b.ms);
    const entries = rows.map((r2) => ({ time: new Date(r2.ms).toISOString(), entity_id: r2.entity_id, state: r2.state }));
    out.timeline(entries, {
      title: `Timeline for ${entities.length} entities`,
      command: 'timeline',
      formatter: (e) => `${out.stamp(toMillis(e.time))}: ${e.entity_id} = ${e.state}`,
    });
  },
};

const syslog = {
  name: 'syslog',
  usage: '',
  summary: 'Errors and warnings in the Home Assistant system log.',
  examples: [[''], ['--compact --max-items 20']],
  max: 0,
  async run({ ws, out }) {
    const items = (await ws.send({ type: 'system_log/list' })) || [];
    const text = (v) => (Array.isArray(v) ? v[0] : v) ?? '';
    out.list(items, {
      title: 'System log entries',
      command: 'syslog',
      formatter: (e) => out.isCompact ? `[${e.level}] ${text(e.source)}: ${text(e.message)}`
        : `[${e.level}] ${text(e.source)}\n  ${text(e.message)}`,
    });
  },
};

const stats = {
  name: 'ws-stats',
  usage: '<entity_id> [hours]',
  summary: 'Hourly long-term statistics for a sensor (default last 24 hours). (For other periods use `ha-tools stats`.)',
  examples: HOURS_EXAMPLES('stats', 'sensor.temperature'),
  min: 1,
  max: 2,
  async run({ ws, pos, opt, out }) {
    const r = timeRange(opt, pos[1]);
    const result = await ws.send({
      type: 'recorder/statistics_during_period', start_time: r.startISO, end_time: r.endISO,
      statistic_ids: [pos[0]], period: 'hour',
    });
    const rows = (result || {})[pos[0]];
    if (!rows || !rows.length) { out.message(`No statistics found for ${pos[0]}`); return; }
    const f = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a');
    out.timeline(rows, {
      title: `Statistics for ${pos[0]}`,
      command: 'stats',
      formatter: (s) => {
        const t = out.stamp(toMillis(s.start));
        return out.isCompact ? `${t} min=${f(s.min)} max=${f(s.max)} mean=${f(s.mean)}`
          : `${t}: min=${f(s.min)}, max=${f(s.max)}, mean=${f(s.mean)}`;
      },
    });
  },
};

const statsMulti = {
  name: 'stats-multi',
  usage: '<entity_id> [entity_id…] [hours]',
  summary: 'min / max / mean per sensor over the last N hours (default 24); a trailing number is the hours.',
  examples: [['sensor.a sensor.b'], ['sensor.a sensor.b sensor.c 48 --json']],
  min: 1,
  async run({ ws, pos, opt, out }) {
    let hours = 24;
    let entities = pos;
    if (pos.length > 1 && /^\d+$/.test(pos[pos.length - 1])) {
      hours = Number(pos[pos.length - 1]);
      entities = pos.slice(0, -1);
    }
    const end = opt.to ? parseFlexibleDate(opt.to) : new Date();
    const start = opt.from ? parseFlexibleDate(opt.from) : new Date(end.getTime() - hours * 3600 * 1000);
    out.message(`Fetching statistics for ${entities.length} entities (last ${hours} hours, concurrent requests)...`);

    const summaries = await Promise.all(entities.map(async (entityId) => {
      try {
        const result = await ws.send({
          type: 'recorder/statistics_during_period', start_time: start.toISOString(), end_time: end.toISOString(),
          statistic_ids: [entityId], period: 'hour',
        });
        const rows = (result || {})[entityId];
        // Zeroed fields on a failed entity: the shape ha-ws-client printed.
        if (!rows || !rows.length) return { entity_id: entityId, min: 0, max: 0, mean: 0, sum: 0, data_points: 0, error: 'no statistics found' };
        let min = rows[0].min ?? 0;
        let max = rows[0].max ?? 0;
        let meanSum = 0;
        let sum = 0;
        for (const s of rows) {
          if ((s.min ?? 0) < min) min = s.min ?? 0;
          if ((s.max ?? 0) > max) max = s.max ?? 0;
          meanSum += s.mean ?? 0;
          sum += s.sum ?? 0;
        }
        return { entity_id: entityId, min, max, mean: meanSum / rows.length, sum, data_points: rows.length };
      } catch (e) {
        return { entity_id: entityId, min: 0, max: 0, mean: 0, sum: 0, data_points: 0, error: e.message };
      }
    }));
    summaries.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    const ok = summaries.filter((s) => !s.error).length;
    if (out.isJson) {
      out.data({ entities: summaries, hours, successful: ok, failed: summaries.length - ok },
        { command: 'stats-multi', count: entities.length });
      return;
    }
    console.log(`\nStatistics Summary (${hours} hours):`);
    console.log(`Successfully fetched: ${ok}/${entities.length} entities\n`);
    for (const s of summaries) {
      if (s.error) console.log(`  ${s.entity_id}: ERROR - ${s.error}`);
      else {
        console.log(`  ${s.entity_id}:`);
        console.log(`    min=${s.min.toFixed(2)}, max=${s.max.toFixed(2)}, mean=${s.mean.toFixed(2)}, sum=${s.sum.toFixed(2)} (${s.data_points} data points)`);
      }
    }
  },
};

const context = {
  name: 'context',
  usage: '<entity_id | context_id>',
  summary: 'What caused a state change: every current state sharing the entity\'s context (or a context id you give).',
  examples: [['light.hall'], ['01JABCDEF0123456789XYZ --compact']],
  min: 1,
  max: 1,
  async run({ ws, pos, out }) {
    const arg = pos[0];
    const states = (await ws.send({ type: 'get_states' })) || [];
    const target = states.find((s) => s.entity_id === arg);
    const contextId = target?.context?.id || arg;
    let matches = states.filter((s) => s.context && (s.context.id === contextId || s.context.parent_id === contextId));
    const parent = target?.context?.parent_id;
    if (parent) {
      for (const s of states) {
        if (s.context?.id === parent && !matches.some((m) => m.entity_id === s.entity_id)) matches.push(s);
      }
    }
    if (!matches.length) {
      if (target) {
        out.message(`No related state changes found for ${arg}`);
        out.message(`Context ID: ${contextId}`);
        if (parent) out.message(`Parent context: ${parent}`);
        out.message('');
        out.message('The triggering event may have occurred before the current state snapshot.');
        out.message("Try 'logbook <entity_id>' to see recent history with context.");
      } else {
        out.message(`No states found with context ID: ${contextId}`);
      }
      return;
    }
    const info = (c) => (!c ? '' : c.parent_id ? ` (context: ${c.id}, parent: ${c.parent_id})` : ` (context: ${c.id})`);
    out.list(matches, {
      title: target ? `Related state changes for ${arg}` : `States with context ${contextId}`,
      command: 'context',
      formatter: (s) => out.isCompact ? `${s.entity_id} ${s.state}${info(s.context)}` : `${s.entity_id}: ${s.state}${info(s.context)}`,
    });
  },
};

module.exports = {
  commands: [
    logbook,
    historyCommand({ name: 'ws-history', command: 'history', title: 'History for', full: false }),
    historyCommand({ name: 'history-full', command: 'history-full', title: 'Full history for', full: true }),
    attrs, timeline, syslog, stats, statsMulti, context,
  ],
  timeRange,
};
