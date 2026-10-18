/*
 * ha-world — one coherent fake Home Assistant: entities, registries, history,
 * and traces for an automation and for scripts (including a running script with
 * parallel branches, and one script calling another).
 *
 * Shared by the CLI tests and the parity harness (which runs the same commands
 * through the old ha-ws-client binary and the new code and compares). Every
 * timestamp is relative to `now`, so ages and durations are deterministic.
 */
import { historyPoints } from './fake-ha.mjs';

export const AUTO_ID = '1700000000001';
export const AUTO_NO_TRACES_ID = '1700000000002';

const MIN = 60_000;

export function buildWorld(now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const ago = (ms) => iso(now - ms);

  /* ------------------------------------------------------------- states */
  const ctx = (id, parent = null) => ({ id, parent_id: parent, user_id: null });
  const states = [
    { entity_id: 'sensor.temperature', state: '19.5', attributes: { unit_of_measurement: '°C', friendly_name: 'Temperature' },
      last_changed: ago(150 * MIN), last_updated: ago(150 * MIN), context: ctx('CTX1') },
    { entity_id: 'sensor.temp2', state: '21.0', attributes: { unit_of_measurement: '°C', friendly_name: 'Temp 2', extra: 'x' },
      last_changed: ago(10 * MIN), last_updated: ago(10 * MIN), context: ctx('CTX9') },
    { entity_id: 'light.hall', state: 'on', attributes: { friendly_name: 'Hall', brightness: 200 },
      last_changed: ago(150 * MIN), last_updated: ago(150 * MIN), context: ctx('CTX2', 'CTX1') },
    { entity_id: 'binary_sensor.stairs', state: 'off', attributes: { friendly_name: 'Stairs' },
      last_changed: ago(300 * MIN), last_updated: ago(300 * MIN), context: ctx('CTX3') },
    { entity_id: 'automation.hall_light_off', state: 'on',
      attributes: { id: AUTO_ID, friendly_name: 'Hall light off', last_triggered: ago(10 * MIN), current: 0, mode: 'single' },
      last_changed: ago(900 * MIN), last_updated: ago(900 * MIN), context: ctx('CTX4') },
    { entity_id: 'automation.no_traces', state: 'on',
      attributes: { id: AUTO_NO_TRACES_ID, friendly_name: 'No traces', last_triggered: ago(60 * MIN), current: 0, mode: 'single' },
      last_changed: ago(900 * MIN), last_updated: ago(900 * MIN), context: ctx('CTX5') },
    { entity_id: 'script.nick_blind_creep_open', state: 'on',
      attributes: { friendly_name: 'Blind creep open', last_triggered: ago(42 * MIN), current: 1, mode: 'single' },
      last_changed: ago(42 * MIN), last_updated: ago(42 * MIN), context: ctx('CTX6') },
    { entity_id: 'script.caller', state: 'on',
      attributes: { friendly_name: 'Caller', last_triggered: ago(20 * MIN), current: 1, mode: 'single' },
      last_changed: ago(20 * MIN), last_updated: ago(20 * MIN), context: ctx('CTX7') },
    { entity_id: 'script.child_script', state: 'on',
      attributes: { friendly_name: 'Child script', last_triggered: ago(20 * MIN), current: 1, mode: 'queued', max: 3 },
      last_changed: ago(20 * MIN), last_updated: ago(20 * MIN), context: ctx('CTX8') },
    { entity_id: 'script.idle', state: 'off',
      attributes: { friendly_name: 'Idle', last_triggered: ago(1000 * MIN), current: 0, mode: 'single' },
      last_changed: ago(1000 * MIN), last_updated: ago(1000 * MIN), context: ctx('CTX10') },
  ];

  /* ------------------------------------------------------------- traces */
  const step = (path, offsetMs, extra = {}, base) => ({ path, timestamp: iso(base + offsetMs), ...extra });

  // Automation: three stored runs, newest first (the order the old tool assumed).
  const autoConfig = {
    id: AUTO_ID, alias: 'Hall light off', description: '',
    trigger: [{ platform: 'state', entity_id: 'binary_sensor.stairs', to: 'off' }],
    condition: [{ condition: 'state', entity_id: 'light.hall', state: 'on' }],
    action: [{ service: 'light.turn_off', target: { entity_id: 'light.hall' } }],
    mode: 'single',
  };
  const autoRun = (runId, startAgo, { finished = true, error = null } = {}) => {
    const start = now - startAgo;
    return {
      list: {
        last_step: 'action/0', run_id: runId, state: 'stopped', script_execution: error ? 'error' : 'finished',
        timestamp: { start: iso(start), finish: iso(start + 1500) }, domain: 'automation', item_id: AUTO_ID,
        trigger: 'state of binary_sensor.stairs',
      },
      detail: {
        last_step: 'action/0', run_id: runId, state: 'stopped', script_execution: error ? 'error' : 'finished',
        timestamp: { start: iso(start), finish: iso(start + 1500) }, domain: 'automation', item_id: AUTO_ID,
        trigger: 'state of binary_sensor.stairs', config: autoConfig, context: ctx(`RC-${runId}`),
        ...(error ? { error } : {}),
        trace: {
          'trigger/0': [step('trigger/0', 0, { changed_variables: { trigger: { platform: 'state', entity_id: 'binary_sensor.stairs' } } }, start)],
          'condition/0': [step('condition/0', 100, { result: { result: true, entities: ['light.hall'] } }, start)],
          'action/0': [step('action/0', 200, {
            result: { params: { domain: 'light', service: 'turn_off', service_data: { entity_id: ['light.hall'] }, target: { entity_id: ['light.hall'] } }, running_script: false, limit: 10 },
            ...(error ? { error } : {}),
          }, start)],
        },
      },
    };
  };
  const autoRuns = [autoRun('a1', 10 * MIN), autoRun('a2', 60 * MIN), autoRun('a3', 120 * MIN, { error: 'light.hall unavailable' })];

  // Scripts.
  const blindConfig = {
    alias: 'Blind creep open', mode: 'single',
    sequence: [
      { variables: { target_pos: 40 } },
      {
        parallel: [
          { sequence: [{ delay: '00:05:00' }, { action: 'cover.set_cover_position', target: { entity_id: 'cover.blind' }, data: { position: '{{ target_pos }}' } }] },
          { sequence: [{ wait_template: "{{ is_state('binary_sensor.stairs', 'off') }}", timeout: '00:30:00', continue_on_timeout: true }] },
        ],
      },
      {
        choose: [{ conditions: [{ condition: 'state', entity_id: 'light.hall', state: 'on' }], sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.hall' } }] }],
        default: [{ action: 'persistent_notification.create', data: { message: 'hall already off' } }],
      },
      { if: [{ condition: 'state', entity_id: 'binary_sensor.stairs', state: 'on' }], then: [{ delay: 5 }], else: [{ event: 'blind_done' }] },
    ],
  };
  const scriptListEntry = (itemId, runId, startAgo, { running = false, last, execution = 'finished' } = {}) => {
    const start = now - startAgo;
    return {
      last_step: last, run_id: runId, state: running ? 'running' : 'stopped',
      ...(running ? {} : { script_execution: execution }),
      timestamp: running ? { start: iso(start) } : { start: iso(start), finish: iso(start + 12 * MIN) },
      domain: 'script', item_id: itemId,
    };
  };

  const blindRunningStart = now - 42 * MIN;
  const blindRunning = {
    list: scriptListEntry('nick_blind_creep_open', 'r-running', 42 * MIN, { running: true, last: 'sequence/1/parallel/1/sequence/0' }),
    detail: {
      ...scriptListEntry('nick_blind_creep_open', 'r-running', 42 * MIN, { running: true, last: 'sequence/1/parallel/1/sequence/0' }),
      config: blindConfig, context: ctx('RC-run'),
      trace: {
        'sequence/0': [step('sequence/0', 0, { changed_variables: { target_pos: 40 } }, blindRunningStart)],
        'sequence/1': [step('sequence/1', 50, {}, blindRunningStart)],
        'sequence/1/parallel/0': [step('sequence/1/parallel/0', 60, {}, blindRunningStart)],
        'sequence/1/parallel/0/sequence/0': [step('sequence/1/parallel/0/sequence/0', 70, { result: { delay: 300, done: false } }, blindRunningStart)],
        'sequence/1/parallel/1': [step('sequence/1/parallel/1', 65, {}, blindRunningStart)],
        'sequence/1/parallel/1/sequence/0': [step('sequence/1/parallel/1/sequence/0', 80, { result: { wait: { remaining: 1800, completed: false, trigger: null } } }, blindRunningStart)],
      },
    },
  };
  const blindDoneStart = now - 180 * MIN;
  const blindDone = {
    list: scriptListEntry('nick_blind_creep_open', 'r-done', 180 * MIN, { last: 'sequence/3/else/0' }),
    detail: {
      ...scriptListEntry('nick_blind_creep_open', 'r-done', 180 * MIN, { last: 'sequence/3/else/0' }),
      config: blindConfig, context: ctx('RC-done'),
      trace: {
        'sequence/0': [step('sequence/0', 0, { changed_variables: { target_pos: 40 } }, blindDoneStart)],
        'sequence/1': [step('sequence/1', 10, {}, blindDoneStart)],
        'sequence/1/parallel/0/sequence/0': [step('sequence/1/parallel/0/sequence/0', 20, { result: { delay: 300, done: true } }, blindDoneStart)],
        'sequence/1/parallel/0/sequence/1': [step('sequence/1/parallel/0/sequence/1', 300_020, {
          result: { params: { domain: 'cover', service: 'set_cover_position', service_data: { position: 40 } }, running_script: false, limit: 10 } }, blindDoneStart)],
        'sequence/1/parallel/1/sequence/0': [step('sequence/1/parallel/1/sequence/0', 30, { result: { wait: { remaining: 1790, completed: true, trigger: null } } }, blindDoneStart)],
        'sequence/2': [step('sequence/2', 300_100, {}, blindDoneStart)],
        'sequence/2/choose/0/conditions/0': [step('sequence/2/choose/0/conditions/0', 300_110, { result: { result: true } }, blindDoneStart)],
        'sequence/2/choose/0/sequence/0': [step('sequence/2/choose/0/sequence/0', 300_120, {
          result: { params: { domain: 'light', service: 'turn_off', service_data: {} }, running_script: false, limit: 10 } }, blindDoneStart)],
        'sequence/3': [step('sequence/3', 300_200, {}, blindDoneStart)],
        'sequence/3/if/0': [step('sequence/3/if/0', 300_210, { result: { result: false } }, blindDoneStart)],
        'sequence/3/else/0': [step('sequence/3/else/0', 300_220, { result: { event: 'blind_done' } }, blindDoneStart)],
      },
    },
  };

  const callerConfig = { alias: 'Caller', mode: 'single', sequence: [{ action: 'script.child_script', data: { x: 1 } }] };
  const callerStart = now - 20 * MIN;
  const caller = {
    list: scriptListEntry('caller', 'cl-run', 20 * MIN, { running: true, last: 'sequence/0' }),
    detail: {
      ...scriptListEntry('caller', 'cl-run', 20 * MIN, { running: true, last: 'sequence/0' }),
      config: callerConfig, context: ctx('RC-caller'),
      trace: { 'sequence/0': [step('sequence/0', 0, { child_id: { domain: 'script', item_id: 'child_script', run_id: 'c-run' }, result: { params: { domain: 'script', service: 'child_script' }, running_script: true, limit: 10 } }, callerStart)] },
    },
  };
  const childConfig = { alias: 'Child script', mode: 'queued', max: 3, sequence: [{ delay: { minutes: 10 } }] };
  const childStart = now - 20 * MIN + 500;
  const child = {
    list: scriptListEntry('child_script', 'c-run', 20 * MIN - 500, { running: true, last: 'sequence/0' }),
    detail: {
      ...scriptListEntry('child_script', 'c-run', 20 * MIN - 500, { running: true, last: 'sequence/0' }),
      config: childConfig, context: ctx('RC-child'),
      trace: { 'sequence/0': [step('sequence/0', 0, { result: { delay: 600, done: false } }, childStart)] },
    },
  };

  const scriptRuns = [blindRunning, blindDone, caller, child];
  const allRuns = [...autoRuns.map((r) => r.detail), ...scriptRuns.map((r) => r.detail)];

  const traceList = (msg) => {
    const pool = msg.domain === 'automation'
      ? autoRuns.map((r) => r.list)
      : scriptRuns.map((r) => r.list);
    return msg.item_id ? pool.filter((t) => t.item_id === msg.item_id) : pool;
  };
  const traceGet = (msg) => {
    const found = allRuns.find((d) => d.domain === msg.domain && d.item_id === msg.item_id && d.run_id === msg.run_id);
    if (!found) throw new Error('Trace not found');
    return found;
  };

  /* ---------------------------------------------------------- the rest */
  const hist = {
    'sensor.temperature': [{ ms: now - 120 * MIN, state: '19.0' }, { ms: now - 90 * MIN, state: '19.5' }],
    'light.hall': [{ ms: now - 100 * MIN, state: 'off' }, { ms: now - 95 * MIN, state: 'on' }],
  };
  const history = (msg) => {
    const out = {};
    for (const id of msg.entity_ids) {
      if (!hist[id]) continue;
      out[id] = msg.minimal_response
        ? historyPoints(id, hist[id])
        : hist[id].map((p) => ({ entity_id: id, state: p.state, attributes: { friendly_name: id }, last_changed: iso(p.ms), last_updated: iso(p.ms) }));
    }
    return out;
  };

  const commands = {
    get_config: { version: '2026.8.1', location_name: 'Home', time_zone: 'Europe/London', unit_system: { temperature: '°C' }, state: 'RUNNING', components: ['light', 'sensor', 'script'] },
    get_states: states,
    get_services: { light: { turn_on: {}, turn_off: {} }, script: { turn_on: {}, reload: {} } },
    call_service: () => ({ context: { id: 'SVC1', parent_id: null, user_id: null } }),
    fire_event: () => ({ context: { id: 'EVT1', parent_id: null, user_id: null } }),
    render_template: (msg, { push }) => { setTimeout(() => push({ result: '2', listeners: { all: false } }), 20); return null; },
    'config/entity_registry/list': [
      { entity_id: 'sensor.temperature', name: 'Temperature', original_name: 'Temp', platform: 'mqtt', disabled_by: null },
      { entity_id: 'sensor.temp2', name: null, original_name: 'Temp two', platform: 'mqtt', disabled_by: 'user' },
      { entity_id: 'light.hall', name: null, original_name: 'Hall', platform: 'hue', disabled_by: null },
    ],
    'config/entity_registry/get': (msg) => {
      if (msg.entity_id === 'script.nick_blind_creep_open') return { entity_id: msg.entity_id, unique_id: 'nick_blind_creep_open' };
      throw new Error('Entity not found');
    },
    'config/device_registry/list': [
      { id: 'abcdef0123456789', name: 'Pixel phone', name_by_user: null, manufacturer: 'Google', model: 'Pixel', area_id: 'hall' },
      { id: '9876543210fedcba', name: 'Hue bridge', name_by_user: 'Bridge', manufacturer: 'Signify', model: 'BSB002', area_id: null },
    ],
    'config/area_registry/list': [{ area_id: 'hall', name: 'Hall', aliases: ['corridor'] }, { area_id: 'kitchen', name: 'Kitchen', aliases: [] }],
    'history/history_during_period': history,
    'logbook/get_events': [{ when: (now - 60 * MIN) / 1000, entity_id: 'light.hall', state: 'on', message: 'turned on', context_id: 'CTX2' }],
    'system_log/list': [{ level: 'ERROR', source: ['homeassistant/foo.py', 12], message: ['boom happened'], name: 'homeassistant.foo', timestamp: now / 1000, count: 2 }],
    'recorder/statistics_during_period': (msg) => {
      const id = msg.statistic_ids[0];
      if (id !== 'sensor.temperature') return {};
      return { [id]: [
        { start: now - 120 * MIN, end: now - 60 * MIN, min: 18, max: 20, mean: 19, sum: 2, state: 19 },
        { start: now - 60 * MIN, end: now, min: 19, max: 22, mean: 20, sum: 4, state: 20 },
      ] };
    },
    'trace/list': traceList,
    'trace/get': traceGet,
    'automation/config': (msg) => {
      if (msg.entity_id === 'automation.hall_light_off') return { config: autoConfig };
      if (msg.entity_id === 'automation.no_traces') return { config: { id: AUTO_NO_TRACES_ID, alias: 'No traces', trigger: [], action: [] } };
      throw new Error('Entity not found');
    },
  };

  return { commands, states, now, iso, autoRuns, scriptRuns, blindConfig, ids: { AUTO_ID } };
}
