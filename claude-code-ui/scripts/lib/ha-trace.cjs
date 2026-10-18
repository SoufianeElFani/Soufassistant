/*
 * ha-trace — pure helpers for reading Home Assistant traces. No I/O, so every
 * branch is unit-tested against fixtures.
 *
 * A trace maps a *path* to the steps recorded there. Paths walk the config:
 *
 *   automation   action/2              script   sequence/1
 *   nested       sequence/1/parallel/0/sequence/2
 *                sequence/3/choose/1/sequence/0     sequence/3/default/0
 *                sequence/4/if/0   sequence/4/then/1   sequence/4/else/0
 *                sequence/5/repeat/sequence/0
 *
 * Scripts use `sequence/…` where automations use `action/…`, which is why
 * "action results" cannot be found by looking for an `action/` prefix.
 */
const { toMillis } = require('./ha-time.cjs');

// HA accepts both spellings in config and in the traces it records.
const ALIASES = {
  action: 'actions', actions: 'action',
  trigger: 'triggers', triggers: 'trigger',
  condition: 'conditions', conditions: 'condition',
};

function splitPath(path) {
  return String(path || '').split('/').filter((s) => s !== '');
}

/**
 * The config node a trace path points at, or undefined when the config does not
 * have it (a blueprint, a template, a path from a newer HA than this knows).
 */
function configAt(config, path) {
  let node = config;
  for (const seg of splitPath(path)) {
    if (node === undefined || node === null) return undefined;
    // HA writes `if/condition/0` and `choose/0/conditions/0`; in the config the
    // condition list sits directly under `if`, so the word itself is no step.
    if (seg === 'condition' || seg === 'conditions') {
      if (Array.isArray(node)) continue;
      if (node && typeof node === 'object' && typeof node.condition === 'string') continue;   // `if: {condition: …}`
    }
    if (/^\d+$/.test(seg)) {
      const i = Number(seg);
      if (Array.isArray(node)) node = node[i];
      else node = i === 0 ? node : undefined;      // a lone item stands for [item]
    } else if (typeof node === 'object' && !Array.isArray(node)) {
      if (seg in node) node = node[seg];
      else if (ALIASES[seg] && ALIASES[seg] in node) node = node[ALIASES[seg]];
      // A bare `parallel` item is run as a one-step sequence of its own.
      else if (seg === 'sequence') node = [node];
      else return undefined;
    } else {
      return undefined;
    }
  }
  return node;
}

/** `00:00:30` / 30 / {minutes: 5} → seconds; null for a template or anything unreadable. */
function parseDelay(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (/{{|{%/.test(value)) return null;
    const hms = value.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
    if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3] || 0);
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
    return null;
  }
  if (value && typeof value === 'object') {
    const n = (k) => (typeof value[k] === 'number' ? value[k] : 0);
    if (Object.values(value).some((v) => typeof v !== 'number')) return null;
    return n('days') * 86400 + n('hours') * 3600 + n('minutes') * 60 + n('seconds') + n('milliseconds') / 1000;
  }
  return null;
}

/** "0:42:13", or "2d 03:04:05" past a day. */
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hms = `${d ? String(h).padStart(2, '0') : h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return d ? `${d}d ${hms}` : hms;
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** What kind of step a config node is, and a one-line summary of it. */
function describeAction(cfg) {
  if (cfg === undefined || cfg === null) {
    return { type: 'unknown', summary: 'step not found in config (blueprint, template, or config changed since)' };
  }
  if (typeof cfg !== 'object') return { type: 'unknown', summary: String(cfg) };
  // The list of conditions an `if` / `while` / `until` holds, not a step.
  if (Array.isArray(cfg)) {
    return { type: 'conditions', summary: `${cfg.length} condition${cfg.length === 1 ? '' : 's'}`, alias: null };
  }

  const out = (type, summary, extra = {}) => ({ type, summary, alias: cfg.alias || null, ...extra });
  const enabled = cfg.enabled === false ? { disabled: true } : {};

  if ('delay' in cfg) {
    const seconds = parseDelay(cfg.delay);
    return out('delay', `delay ${seconds === null ? JSON.stringify(cfg.delay) : formatDuration(seconds)}`,
      { seconds, ...enabled });
  }
  if ('wait_template' in cfg) {
    return out('wait_template', `wait_template ${JSON.stringify(String(cfg.wait_template).trim())}` +
      (cfg.timeout !== undefined ? ` (timeout ${typeof cfg.timeout === 'object' ? JSON.stringify(cfg.timeout) : cfg.timeout})` : ''),
    { template: String(cfg.wait_template), timeout: cfg.timeout ?? null, continue_on_timeout: cfg.continue_on_timeout !== false });
  }
  if ('wait_for_trigger' in cfg) {
    const triggers = asList(cfg.wait_for_trigger).map((t) => describeTrigger(t));
    return out('wait_for_trigger', `wait_for_trigger ${triggers.join(' | ') || '(none)'}` +
      (cfg.timeout !== undefined ? ` (timeout ${typeof cfg.timeout === 'object' ? JSON.stringify(cfg.timeout) : cfg.timeout})` : ''),
    { triggers, timeout: cfg.timeout ?? null, continue_on_timeout: cfg.continue_on_timeout !== false });
  }

  const service = cfg.action || cfg.service;
  if (typeof service === 'string') {
    const target = [].concat(cfg.target?.entity_id ?? cfg.data?.entity_id ?? cfg.entity_id ?? []).filter(Boolean);
    if (/^script\.(?!turn_on$|turn_off$|toggle$|reload$)/.test(service)) {
      const object = service.slice('script.'.length);
      return out('script_call', `calls script.${object} and waits for it`, { script: `script.${object}` });
    }
    if (service === 'script.turn_on') {
      return out('script_start', `script.turn_on ${target.join(', ')} (does not wait)`, { targets: target });
    }
    return out('service', `${service}${target.length ? ` ${target.join(', ')}` : ''}`, { service, targets: target });
  }
  if ('choose' in cfg) return out('choose', `choose (${asList(cfg.choose).length} options${cfg.default ? ' + default' : ''})`);
  if ('if' in cfg) return out('if', 'if / then' + (cfg.else ? ' / else' : ''));
  if ('parallel' in cfg) return out('parallel', `parallel (${asList(cfg.parallel).length} branches)`);
  if ('repeat' in cfg) return out('repeat', `repeat ${describeRepeat(cfg.repeat)}`);
  if ('sequence' in cfg) return out('sequence', `sequence (${asList(cfg.sequence).length} steps)`);
  if ('event' in cfg) return out('event', `fire event ${cfg.event}`);
  if ('stop' in cfg) return out('stop', `stop: ${cfg.stop}`);
  if ('variables' in cfg) return out('variables', `variables ${Object.keys(cfg.variables || {}).join(', ')}`);
  if ('scene' in cfg) return out('scene', `scene ${cfg.scene}`);
  if (typeof cfg.condition === 'string') return out('condition', `condition: ${cfg.condition}${cfg.entity_id ? ` ${[].concat(cfg.entity_id).join(', ')}` : ''}`);
  if ('device_id' in cfg && 'domain' in cfg) return out('device', `device action ${cfg.domain}${cfg.type ? `.${cfg.type}` : ''}`);
  return out('other', `step with keys: ${Object.keys(cfg).join(', ') || '(empty)'}`);
}

function describeRepeat(repeat) {
  if (!repeat || typeof repeat !== 'object') return '';
  if ('count' in repeat) return `${repeat.count} times`;
  if ('while' in repeat) return 'while condition';
  if ('until' in repeat) return 'until condition';
  if ('for_each' in repeat) return 'for each item';
  return '';
}

function describeTrigger(t) {
  if (!t || typeof t !== 'object') return String(t);
  const kind = t.trigger || t.platform || 'trigger';
  const what = [].concat(t.entity_id ?? t.event_type ?? []).join(',');
  const to = t.to !== undefined && t.to !== null ? ` → ${t.to}` : '';
  return `${kind}${what ? ` ${what}` : ''}${to}`;
}

/**
 * A readable position for a path: `sequence[1] › parallel branch 0 › sequence[2]`.
 * Indices are the path's own (zero-based), so they can be matched to the config.
 */
function breadcrumb(path) {
  const segs = splitPath(path);
  const parts = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const next = segs[i + 1];
    const numeric = next !== undefined && /^\d+$/.test(next);
    if (seg === 'parallel' && numeric) { parts.push(`parallel branch ${next}`); i++; }
    else if (seg === 'choose' && numeric) { parts.push(`choose option ${next}`); i++; }
    else if (seg === 'default' && numeric) { parts.push(`choose default[${next}]`); i++; }
    else if (seg === 'if' && numeric) { parts.push(`if condition ${next}`); i++; }
    else if ((seg === 'then' || seg === 'else') && numeric) { parts.push(`${seg}[${next}]`); i++; }
    else if (numeric) { parts.push(`${seg}[${next}]`); i++; }
    else parts.push(seg);
  }
  return parts.join(' › ');
}

/** A trace's steps as one list ordered by when they happened. */
function flattenSteps(detail) {
  const rows = [];
  let n = 0;
  for (const [path, steps] of Object.entries(detail?.trace || {})) {
    for (const step of steps || []) rows.push({ path, ...step, ms: toMillis(step.timestamp), _n: n++ });
  }
  return rows.sort((a, b) => ((a.ms ?? 0) - (b.ms ?? 0)) || (a._n - b._n)).map(({ _n, ...r }) => r);
}

/** Does a recorded step say it is still waiting? */
function stepWaiting(step) {
  const r = step?.result;
  if (!r || step.error) return null;
  if (r.done === false) return 'delay';
  if (r.wait && r.wait.completed === false) return 'wait';
  return null;
}

/**
 * Where a run that has not finished is, as a list of open steps — one per
 * branch. A parallel script can be waiting in several places at once.
 *
 * A step is open when HA says it is mid-wait (a delay with `done: false`, a
 * wait with `completed: false`), or when it is the trace's own `last_step` and
 * nothing has recorded a result yet. The second case is a weaker claim, so each
 * step carries `explicit` — true only when the step itself says it is waiting.
 *
 * The deepest step comes first, the most recently started breaking ties.
 */
function openSteps(detail) {
  const trace = detail?.trace || {};
  const found = new Map();

  for (const [path, steps] of Object.entries(trace)) {
    const last = steps?.[steps.length - 1];
    if (!last) continue;
    const kind = stepWaiting(last);
    if (kind) found.set(path, { path, step: last, kind, explicit: true });
  }

  const lastPath = detail?.last_step;
  if (lastPath && !found.has(lastPath) && trace[lastPath]?.length) {
    const step = trace[lastPath][trace[lastPath].length - 1];
    if (!step.error) found.set(lastPath, { path: lastPath, step, kind: step.child_id ? 'call' : 'in_progress', explicit: false });
  }
  for (const item of found.values()) {
    if (item.step.child_id) item.child_id = item.step.child_id;
  }

  const rank = (o) => splitPath(o.path).length;
  return [...found.values()]
    .map((o) => ({ ...o, ms: toMillis(o.step.timestamp) }))
    .sort((a, b) => (rank(b) - rank(a)) || ((b.ms ?? 0) - (a.ms ?? 0)));
}

/** Newest run first, by start time — HA's own ordering is not relied on. */
function newestFirst(traces) {
  return [...traces].sort((a, b) => (toMillis(b.timestamp?.start) ?? 0) - (toMillis(a.timestamp?.start) ?? 0));
}

/** A trace/list entry that has not finished. */
function isRunning(t) {
  if (t.state) return t.state === 'running';
  return !t.timestamp?.finish;
}

module.exports = {
  splitPath, configAt, parseDelay, formatDuration, describeAction, describeTrigger,
  breadcrumb, flattenSteps, openSteps, stepWaiting, newestFirst, isRunning,
};
