/*
 * history — everything about past state: history, stats, timeline, logbook, attrs,
 * syslog, stats-multi, context.
 *
 * `history`, `stats` and `timeline` used to exist twice: ha-tools took a date range,
 * ha-ws-client took "the last N hours". They are one command each now and take either:
 * a trailing hours number (`history sensor.x 6`), `--hours N`, `--days N` (may be a
 * fraction), or `--from` / `--to`. Giving two of the first three is an error rather
 * than a quiet choice of one.
 *
 * With no `--to`, no end_time is sent: Home Assistant reads that as "up to now".
 * Ported from ha-ws-client (MIT, see NOTICE) and ha-tools' own history helpers.
 */
const { UsageError, parseFlexibleDate } = require('../lib/ha-args.cjs');
const { toMillis, parseWindow, inWindow } = require('../lib/ha-time.cjs');

const WINDOW_FLAGS = { days: 'number', hours: 'number' };
const WINDOW_HELP = {
  '--hours N / --days N': 'how far back (default 24 hours); a trailing number after the entity also means hours',
  '--from / --to': 'a date (YYYY-MM-DD[ HH:MM], UTC) instead; with no --to, "up to now"',
};
const VALID_PERIODS = new Set(['5minute', 'hour', 'day', 'week', 'month']);

/**
 * The window a command was asked for. `hoursArg` is the trailing positional, if the
 * command takes one. endISO is null unless --to was given.
 */
function timeRange(opt, hoursArg, defaultHours = 24) {
  const given = [
    hoursArg !== undefined && `the hours argument (${hoursArg})`,
    opt.hours !== undefined && '--hours',
    opt.days !== undefined && '--days',
  ].filter(Boolean);
  if (!opt.from && given.length > 1) throw new UsageError(`give one of ${given.join(', ')} — not both`);
  if (hoursArg !== undefined && !/^\d+(\.\d+)?$/.test(hoursArg)) throw new UsageError(`invalid hours: ${hoursArg}`);

  const end = opt.to ? parseFlexibleDate(opt.to) : new Date();
  let start;
  if (opt.from) start = parseFlexibleDate(opt.from);
  else {
    const hours = hoursArg !== undefined ? Number(hoursArg)
      : opt.hours !== undefined ? opt.hours
        : opt.days !== undefined ? opt.days * 24 : defaultHours;
    start = new Date(end.getTime() - hours * 3600 * 1000);
  }
  return { start, end, startISO: start.toISOString(), endISO: opt.to ? end.toISOString() : null, hours: (end - start) / 3600000 };
}

/** start_time / end_time for a WebSocket request. */
const windowOf = (r) => ({ start_time: r.startISO, ...(r.endISO ? { end_time: r.endISO } : {}) });

const lastUpdatedMs = (s) => toMillis(s.lu ?? s.last_updated ?? s.lc ?? s.last_changed);
const stateOf = (s) => s.s ?? s.state;

/**
 * Flatten a `history/history_during_period` response into plain rows.
 *
 * HA's shape is awkward: an object keyed by entity_id whose first element is a full
 * state object and whose later elements are compact ({s, lu}). Everything downstream
 * works with {entity_id, ms, state} instead.
 */
function flattenHistory(result) {
  const rows = [];
  for (const [entityId, points] of Object.entries(result || {})) {
    for (const p of points || []) {
      const ms = toMillis(p.lu ?? p.last_updated ?? p.lc ?? p.last_changed);
      if (ms === null) continue;
      rows.push({ entity_id: p.entity_id || entityId, ms, state: p.s ?? p.state, attributes: p.a ?? p.attributes });
    }
  }
  return rows.sort((a, b) => a.ms - b.ms);
}

/** Flat rows: aligned text (the zone said once up top), or TSV. */
function printRows(rows, out, format, { full = false } = {}) {
  const c = out.clock;
  if (format === 'tsv') {
    if (out.showHeaders) console.log(['timestamp', 'entity_id', 'state'].join('\t'));
    for (const r of rows) console.log([c.stamp(r.ms), r.entity_id, r.state].join('\t'));
    return;
  }
  const width = rows.reduce((w, r) => Math.max(w, r.entity_id.length), 0);
  const offset = rows.length ? c.offset(rows[0].ms) : '';
  if (out.showHeaders) console.log(`# times are ${c.timeZone}${offset ? ` (UTC${offset})` : ''}; ${rows.length} events`);
  for (const r of rows) {
    console.log(`${c.shortStamp(r.ms)}  ${r.entity_id.padEnd(width)}  ${r.state}`);
    if (full && r.attributes && Object.keys(r.attributes).length) {
      console.log(`    ${JSON.stringify(r.attributes, null, 2).replace(/\n/g, '\n    ')}`);
    }
  }
}

const EXAMPLE_WINDOWS = (entity) => [
  [`${entity}`, 'last 24 hours'],
  [`${entity} 6`, 'last 6 hours'],
  [`${entity} --days 7`, 'last 7 days'],
  [`${entity} --from 2026-10-17 --to "2026-10-17 12:00"`],
];

const logbook = {
  name: 'logbook',
  range: true,
  listing: true,
  usage: '[entity_id] [hours]',
  summary: 'Logbook entries (default last 24 hours) — for one entity, or for everything when none is given.',
  details: 'Unlike ha-ws-client of old, the entity is optional: SKILL.md always documented `logbook` on its own.',
  examples: [['light.hall', 'one entity, last 24 hours'], ['light.hall 6', 'last 6 hours'], ['', 'everything, last 24 hours'], ['6', 'everything, last 6 hours']],
  max: 2,
  flags: WINDOW_FLAGS,
  flagHelp: WINDOW_HELP,
  async run({ ws, pos, opt, out }) {
    // `logbook 6` means six hours of everything, not an entity called "6".
    const [entity, hoursArg] = pos.length && /^\d+$/.test(pos[0]) && pos.length === 1 ? [undefined, pos[0]] : pos;
    const r = timeRange(opt, hoursArg);
    const message = { type: 'logbook/get_events', ...windowOf(r) };
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

const history = {
  name: 'history',
  range: true,
  usage: '<entity_id> [hours] [--hours N | --days N | --from DATE [--to DATE]] [--full]',
  summary: 'State changes for one entity over a window (default last 24 hours); --full adds attributes.',
  details: '--json prints Home Assistant\'s own points for the entity (compact {s, lu} points after the first, epoch\n' +
    'seconds); text and --format tsv print one row per change in HA\'s timezone.',
  flags: { ...WINDOW_FLAGS, full: 'bool' },
  flagHelp: { ...WINDOW_HELP, '--full': 'include attributes (and print them in text)' },
  formats: ['tsv'],
  examples: EXAMPLE_WINDOWS('sensor.temperature'),
  min: 1,
  max: 2,
  async run({ ws, pos, opt, out }) {
    const withAttrs = Boolean(opt.full);
    const r = timeRange(opt, pos[1]);
    const result = await ws.send({
      type: 'history/history_during_period',
      entity_ids: [pos[0]],
      ...windowOf(r),
      minimal_response: !withAttrs,
      no_attributes: !withAttrs,
      significant_changes_only: false,
    });
    if (out.isJson) {
      const points = (result || {})[pos[0]] || [];
      out.data(points, { command: 'history', count: points.length });
    } else {
      printRows(flattenHistory(result), out, opt.fmt === 'tsv' ? 'tsv' : 'text', { full: withAttrs });
    }
  },
};

const timeline = {
  name: 'timeline',
  range: true,
  usage: '[hours] <entity_id> [entity_id…] [--between HH:MM-HH:MM] [window options]',
  summary: 'Several entities\' state changes merged onto one clock — the core move for "what happened, in what order?".',
  details: 'A leading number is the hours to look back (`timeline 6 light.a light.b`). --between keeps only a time of day,\n' +
    'and may wrap midnight (22:00-07:00). An entity with no events in the window is called out on stderr, since\n' +
    '"no events" and "typo\'d the entity_id" otherwise look identical.',
  flags: { ...WINDOW_FLAGS, between: 'string' },
  flagHelp: { ...WINDOW_HELP, '--between HH:MM-HH:MM': 'only events in this time of day (HA timezone)' },
  formats: ['tsv'],
  examples: [
    ['light.hall binary_sensor.stairs --days 3 --between 22:00-07:00'],
    ['6 light.hall binary_sensor.stairs', 'last 6 hours'],
    ['light.hall --days 1 --format tsv'],
  ],
  min: 1,
  validate({ opt }) {
    if (opt.between) {
      try { opt.window = parseWindow(opt.between); } catch (e) { throw new UsageError(e.message); }
    }
  },
  async run({ ws, pos, opt, out }) {
    let hoursArg;
    let entities = pos;
    if (/^\d+(\.\d+)?$/.test(pos[0])) [hoursArg, ...entities] = pos;
    if (!entities.length) throw new UsageError('give at least one entity_id');
    const r = timeRange(opt, hoursArg);
    const result = await ws.send({
      type: 'history/history_during_period',
      entity_ids: entities,
      ...windowOf(r),
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    const rows = flattenHistory(result).filter((x) => inWindow(out.clock, x.ms, opt.window));

    if (out.isJson) {
      out.data(rows.map((x) => ({ time: out.stamp(x.ms), epoch_ms: x.ms, entity_id: x.entity_id, state: x.state })),
        { command: 'timeline', count: rows.length, times: true });
    } else {
      printRows(rows, out, opt.fmt === 'tsv' ? 'tsv' : 'text');
    }
    const seen = new Set(rows.map((x) => x.entity_id));
    const silent = entities.filter((e) => !seen.has(e));
    if (silent.length) {
      console.error(`Note: no events in this window for ${silent.join(', ')} ` +
        `(entity may not exist, or may not have changed state)`);
    }
  },
};

const stats = {
  name: 'stats',
  range: true,
  listing: true,
  usage: '<entity_id> [hours] [--period 5minute|hour|day|week|month] [window options]',
  summary: 'Long-term statistics (min / max / mean / sum …) for a sensor over a window (default last 24 hours, hourly).',
  flags: { ...WINDOW_FLAGS, period: 'string' },
  flagHelp: { ...WINDOW_HELP, '--period': '5minute | hour | day | week | month (default hour)' },
  formats: ['tsv'],
  examples: [
    ['sensor.energy_cost --days 14', 'last 14 days, hourly'],
    ['sensor.energy_cost --from 2026-06-01 --period day', 'daily buckets'],
    ['sensor.temperature 6 --json'],
  ],
  min: 1,
  max: 2,
  validate({ opt }) {
    if (opt.period !== undefined && !VALID_PERIODS.has(opt.period)) throw new UsageError(`invalid --period: ${opt.period}`);
  },
  async run({ ws, pos, opt, out }) {
    const r = timeRange(opt, pos[1]);
    const result = await ws.send({
      type: 'recorder/statistics_during_period',
      ...windowOf(r),
      statistic_ids: [pos[0]],
      period: opt.period || 'hour',
    });
    const rows = (result || {})[pos[0]] || [];
    if (out.isJson) { out.data(rows, { command: 'stats', count: rows.length }); return; }
    if (opt.fmt === 'tsv') {
      if (out.showHeaders) console.log(['start', 'statistic_id', 'mean', 'min', 'max', 'sum', 'state', 'change'].join('\t'));
      for (const b of rows) {
        const ms = toMillis(b.start);
        console.log([ms === null ? '' : out.stamp(ms), pos[0], b.mean ?? '', b.min ?? '', b.max ?? '', b.sum ?? '', b.state ?? '', b.change ?? ''].join('\t'));
      }
      return;
    }
    if (!rows.length) { out.message(`No statistics found for ${pos[0]}`); return; }
    const f = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a');
    out.timeline(rows, {
      title: `Statistics for ${pos[0]}`,
      command: 'stats',
      formatter: (x) => {
        const t = out.stamp(toMillis(x.start));
        return out.isCompact ? `${t} min=${f(x.min)} max=${f(x.max)} mean=${f(x.mean)}`
          : `${t}: min=${f(x.min)}, max=${f(x.max)}, mean=${f(x.mean)}`;
      },
    });
  },
};

const attrs = {
  name: 'attrs',
  range: true,
  listing: true,
  usage: '<entity_id> [hours]',
  summary: 'Attribute change history: each state with its attributes (default last 24 hours).',
  examples: EXAMPLE_WINDOWS('climate.thermostat'),
  flags: WINDOW_FLAGS,
  flagHelp: WINDOW_HELP,
  min: 1,
  max: 2,
  async run({ ws, pos, opt, out }) {
    const r = timeRange(opt, pos[1]);
    const result = await ws.send({
      type: 'history/history_during_period', entity_ids: [pos[0]],
      ...windowOf(r), minimal_response: false, no_attributes: false,
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

const syslog = {
  name: 'syslog',
  listing: true,
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

const statsMulti = {
  name: 'stats-multi',
  range: true,
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
  listing: true,
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
    history,
    attrs, timeline, syslog, stats, statsMulti, context,
  ],
  timeRange,
  windowOf,
};
