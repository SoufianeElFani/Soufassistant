/*
 * basic — states, services, templates and device checks.
 *
 * Ported from ha-ws-client (schoolboyqueue/home-assistant-blueprints, MIT — see
 * NOTICE): same WebSocket calls, arguments, defaults and JSON `data` shapes.
 */
const fs = require('fs');
const { UsageError } = require('../lib/ha-args.cjs');
const { globToRegExp, shortAge } = require('../lib/ha-common.cjs');
const { toMillis } = require('../lib/ha-time.cjs');

const STALE_MS = 3600 * 1000;

async function allStates(ws) {
  return (await ws.send({ type: 'get_states' })) || [];
}

function notFound(entityId) {
  return new Error(`entity not found: ${entityId} — try \`ha-ws-client states-filter "${entityId.split('.').pop()}"\``);
}

const ping = {
  name: 'ping',
  usage: '',
  summary: 'Test the connection to Home Assistant and report the round-trip time.',
  examples: [['', 'Pong! (12ms)'], ['--json']],
  max: 0,
  async run({ ws, out }) {
    const start = Date.now();
    await ws.send({ type: 'ping' });
    const ms = Date.now() - start;
    if (out.isJson) out.data({ latency_ms: ms }, { command: 'ping' });
    else out.message(`Pong! (${ms}ms)`);
  },
};

const state = {
  name: 'state',
  usage: '<entity_id>',
  summary: 'Show one entity\'s state and attributes.',
  examples: [['sensor.temperature'], ['light.living_room --json']],
  min: 1,
  max: 1,
  async run({ ws, pos, out }) {
    const found = (await allStates(ws)).find((s) => s.entity_id === pos[0]);
    if (!found) throw notFound(pos[0]);
    out.data(found, { command: 'state' });
  },
};

const states = {
  name: 'states',
  usage: '[--max-items N]',
  summary: 'Count every entity and show a sample (10 by default; use states-filter to search).',
  examples: [[''], ['--max-items 25']],
  max: 0,
  async run({ ws, out }) {
    const all = await allStates(ws);
    const limit = out.maxItems > 0 ? out.maxItems : 10;
    const sample = all.slice(0, limit);
    if (out.isJson) {
      out.data({ total: all.length, sample }, { command: 'states', count: all.length });
    } else {
      out.list(sample, {
        title: `Total entities: ${all.length}\nSample`,
        formatter: (s) => `  ${s.entity_id}: ${s.state}`,
      });
    }
  },
};

const statesJson = {
  name: 'states-json',
  usage: '',
  summary: 'Every entity state as one JSON array.',
  examples: [[''], ['| jq \'.data | length\'']],
  max: 0,
  async run({ ws, out }) {
    const all = await allStates(ws);
    // Always the envelope: the name promises JSON.
    console.log(JSON.stringify({ success: true, command: 'states-json', data: all, count: all.length || undefined }));
  },
};

const statesFilter = {
  name: 'states-filter',
  usage: '<pattern> [--show-age]',
  summary: 'Entities whose entity_id matches a pattern (`*` is a wildcard; case-insensitive, matched anywhere in the id).',
  details: 'The match is unanchored, as it always was: "sensor.*" also matches binary_sensor.x. Filter the output if that matters.',
  examples: [['"light.*"'], ['"sensor.*battery*" --show-age', 'flags entities not updated for over an hour']],
  min: 1,
  max: 1,
  async run({ ws, pos, out }) {
    const re = globToRegExp(pos[0]);
    const matched = (await allStates(ws)).filter((s) => re.test(s.entity_id));
    const now = Date.now();
    out.list(matched, {
      title: `Found ${matched.length} matching entities`,
      command: 'states-filter',
      formatter: (s) => {
        if (!out.showAge) return `${s.entity_id}: ${s.state}`;
        const ms = toMillis(s.last_updated);
        if (ms === null) return `${s.entity_id}: ${s.state}`;
        return `${s.entity_id}: ${s.state} (${shortAge(now - ms)} ago) ${now - ms > STALE_MS ? '⚠️' : '✓'}`;
      },
    });
  },
};

const config = {
  name: 'config',
  usage: '',
  summary: 'Home Assistant version, location, timezone, unit system and component count.',
  examples: [[''], ['--json']],
  max: 0,
  async run({ ws, out }) {
    const c = (await ws.send({ type: 'get_config' })) || {};
    out.data({
      version: c.version,
      location_name: c.location_name,
      time_zone: c.time_zone,
      unit_system: c.unit_system,
      state: c.state,
      components_count: (c.components || []).length,
    }, { command: 'config' });
  },
};

const services = {
  name: 'services',
  usage: '',
  summary: 'Every service domain and the services in it.',
  examples: [[''], ['--json | jq \'.data[] | select(.domain=="light")\'']],
  max: 0,
  async run({ ws, out }) {
    const all = (await ws.send({ type: 'get_services' })) || {};
    const domains = Object.keys(all);
    if (out.isJson) {
      out.data(domains.map((d) => ({ domain: d, services: Object.keys(all[d] || {}) })),
        { command: 'services', count: domains.length });
    } else {
      out.list(domains, {
        title: 'Domains',
        formatter: (d) => `  ${d}: ${Object.keys(all[d] || {}).join(', ')}`,
      });
    }
  },
};

const call = {
  name: 'call',
  usage: '<domain> <service> [json_data]',
  summary: 'Call a service. The data is a JSON object, usually with an entity_id.',
  examples: [
    ['light turn_on \'{"entity_id":"light.hall","brightness_pct":50}\''],
    ['script turn_on \'{"entity_id":"script.nick_blind_creep_open"}\'', 'starts a script — a real action'],
  ],
  min: 2,
  max: 3,
  async run({ ws, pos, out }) {
    const [domain, service, raw] = pos;
    let serviceData;
    if (raw !== undefined) {
      try { serviceData = JSON.parse(raw); } catch (e) { throw new UsageError(`invalid JSON data: ${e.message}`); }
    }
    const result = await ws.send({ type: 'call_service', domain, service, service_data: serviceData });
    if (out.isJson) {
      out.data({ domain, service, service_data: serviceData, response: result },
        { command: 'call', summary: 'Service called successfully' });
    } else {
      out.message('Service called successfully');
      const response = result?.response;
      if (response && typeof response === 'object' && Object.keys(response).length) {
        out.data(response, { summary: 'Response:' });
      }
    }
  },
};

const template = {
  name: 'template',
  usage: '[<template> | -]',
  summary: 'Render a Jinja template. With no argument, or "-", the template is read from stdin.',
  examples: [
    ['\'{{ states("sensor.temperature") | float | round(1) }}\''],
    ['- <<< \'{{ now() }}\''],
  ],
  max: 1,
  async run({ ws, pos, out }) {
    let tpl = pos[0];
    if (tpl === undefined || tpl === '-') {
      try { tpl = fs.readFileSync(0, 'utf8'); } catch { tpl = ''; }
    }
    if (!tpl) throw new UsageError('no template given (pass one as an argument, or pipe it on stdin)');

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out after 5s waiting for the template to render')), 5000);
      ws.subscribe({ type: 'render_template', template: tpl, timeout: 5 }, (event) => {
        clearTimeout(timer);
        if (event?.error) reject(new Error(`template error: ${event.error}`));
        else resolve(event?.result);
      }).catch((e) => { clearTimeout(timer); reject(e); });
    });
    if (out.isJson) out.data({ template: tpl, result }, { command: 'template' });
    else out.message(typeof result === 'string' ? result : JSON.stringify(result));
  },
};

const fireEvent = {
  name: 'fire-event',
  usage: '<event_type> [json_data]',
  summary: 'Fire an event on the Home Assistant bus.',
  examples: [['custom_event \'{"key":"value"}\''], ['my_test_event']],
  min: 1,
  max: 2,
  async run({ ws, pos, out }) {
    const [eventType, raw] = pos;
    let eventData;
    if (raw !== undefined) {
      try { eventData = JSON.parse(raw); } catch (e) { throw new UsageError(`invalid JSON data: ${e.message}`); }
    }
    const message = { type: 'fire_event', event_type: eventType };
    if (eventData !== undefined) message.event_data = eventData;
    const result = await ws.send(message);
    if (out.isJson) out.data({ event_type: eventType, event_data: eventData ?? null, context: result?.context ?? null }, { command: 'fire-event' });
    else out.message(`Event ${eventType} fired`);
  },
};

function healthOf(s, now) {
  const ms = toMillis(s.last_updated);
  const h = { entity_id: s.entity_id, state: s.state, last_updated: s.last_updated, age: '', age_seconds: 0, status: 'unknown' };
  if (ms !== null) {
    h.age_seconds = (now - ms) / 1000;
    h.age = shortAge(now - ms);
    h.status = now - ms > STALE_MS ? 'stale' : 'ok';
  }
  return h;
}

const deviceHealth = {
  name: 'device-health',
  usage: '<entity_id>',
  summary: 'Is a device responsive? Compares last_updated for the entity and others sharing its name (stale = over 1h).',
  examples: [['cover.guest_bedroom_window_shade'], ['sensor.hall_motion --json']],
  min: 1,
  max: 1,
  async run({ ws, pos, out }) {
    const entityId = pos[0];
    const all = await allStates(ws);
    const parts = entityId.split('.');
    if (parts.length !== 2 || !parts[1]) throw new UsageError(`invalid entity_id: ${entityId} (expected domain.object_id)`);
    const base = parts[1];
    const main = all.find((s) => s.entity_id === entityId);
    if (!main) throw notFound(entityId);
    const now = Date.now();
    const related = all.filter((s) => s.entity_id !== entityId && s.entity_id.includes(base)).map((s) => healthOf(s, now));
    const mainHealth = healthOf(main, now);
    const overall = mainHealth.status === 'stale' ? 'stale' : 'ok';
    const result = { entity: mainHealth, related, overall_status: overall, stale_threshold: '1h0m0s' };
    if (out.isJson || out.isCompact) {
      out.data(result, { command: 'device-health' });
      return;
    }
    console.log(`Device Health for ${entityId}:\n`);
    console.log(`  ${mainHealth.status === 'stale' ? '⚠️' : '✓'} ${mainHealth.entity_id}: ${mainHealth.state} (${mainHealth.age} ago) ${mainHealth.status.toUpperCase()}`);
    if (related.length) {
      console.log('\nRelated entities:');
      for (const h of related) console.log(`  ${h.status === 'stale' ? '⚠️' : '✓'} ${h.entity_id}: ${h.state} (${h.age} ago)`);
    }
    console.log(`\nOverall: ${overall.toUpperCase()}`);
  },
};

const compare = {
  name: 'compare',
  usage: '<entity_id1> <entity_id2>',
  summary: 'Two entities side by side: state, age, and every attribute that differs.',
  examples: [['sensor.temp_bedroom sensor.temp_living_room'], ['light.a light.b --json']],
  min: 2,
  max: 2,
  async run({ ws, pos, out }) {
    const [a, b] = pos;
    const all = await allStates(ws);
    const s1 = all.find((s) => s.entity_id === a);
    const s2 = all.find((s) => s.entity_id === b);
    if (!s1) throw notFound(a);
    if (!s2) throw notFound(b);
    const now = Date.now();
    const age = (s) => { const ms = toMillis(s.last_updated); return ms === null ? 'unknown' : shortAge(now - ms); };
    const side = (s) => ({ entity_id: s.entity_id, state: s.state, last_updated: s.last_updated, age: age(s), attributes: s.attributes });

    const a1 = s1.attributes || {};
    const a2 = s2.attributes || {};
    const diffs = {};
    for (const k of Object.keys(a1)) {
      if (k in a2) {
        if (String(a1[k]) !== String(a2[k])) diffs[k] = { entity1: a1[k], entity2: a2[k] };
      } else diffs[k] = { entity1: a1[k], entity2: null };
    }
    for (const k of Object.keys(a2)) if (!(k in a1)) diffs[k] = { entity1: null, entity2: a2[k] };

    const comparison = {
      entity1: side(s1),
      entity2: side(s2),
      differences: { state_match: s1.state === s2.state, attributes: diffs },
    };
    if (out.isJson || out.isCompact) {
      out.data(comparison, { command: 'compare' });
      return;
    }
    console.log(`Comparison: ${a} vs ${b}\n`);
    console.log(`${'Property'.padEnd(30)} | ${a.padEnd(25)} | ${b.padEnd(25)}`);
    console.log('-'.repeat(85));
    console.log(`${'State'.padEnd(30)} | ${String(s1.state).padEnd(25)} | ${String(s2.state).padEnd(25)}`);
    console.log(`${'Last Updated'.padEnd(30)} | ${(age(s1) + ' ago').padEnd(25)} | ${(age(s2) + ' ago').padEnd(25)}`);
    if (Object.keys(diffs).length) {
      console.log('\nAttribute Differences:');
      for (const [k, v] of Object.entries(diffs)) console.log(`  ${k}: ${JSON.stringify(v.entity1)} vs ${JSON.stringify(v.entity2)}`);
    }
  },
};

module.exports = { commands: [ping, state, states, statesJson, statesFilter, config, services, call, template, fireEvent, deviceHealth, compare] };
