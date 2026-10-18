/*
 * traces — automation AND script traces, running-task introspection.
 *
 * The trace commands of ha-ws-client (MIT, see NOTICE), generalised: Home
 * Assistant's trace WebSocket API is domain-generic (`trace/list` and
 * `trace/get` take `domain: "automation" | "script"`), and the upstream tool
 * hard-coded "automation". Every command here takes `--domain` and also reads
 * the domain from a fully-qualified entity_id.
 *
 * Added on top of the port:
 *   running      every automation and script executing right now
 *   trace-stuck  where a run that has not finished is waiting
 *
 * Where upstream behaviour was unreliable it is fixed rather than copied:
 * timeline/vars came out in Go map order (random), "action results" looked only
 * for an `action/` prefix (scripts use `sequence/`), and the newest run was
 * taken to be whichever HA listed first.
 */
const { UsageError } = require('../lib/ha-args.cjs');
const { resolveAutomation, longDuration } = require('../lib/ha-common.cjs');
const { toMillis } = require('../lib/ha-time.cjs');
const T = require('../lib/ha-trace.cjs');

const DOMAINS = ['automation', 'script'];
const DOMAIN_FLAG = { domain: 'string' };
const DOMAIN_HELP = { '--domain script|automation': 'which kind of item (default: automation; or read from "script.x" / "automation.x")' };

function validateDomain(parsed) {
  const d = parsed.opt.domain;
  if (d !== undefined && !DOMAINS.includes(d)) throw new UsageError(`invalid --domain: ${d} (expected script or automation)`);
}

/* ------------------------------------------------------------------ resolve */

async function resolveScript(ws, ref) {
  const states = (await ws.send({ type: 'get_states' })) || [];
  const needle = String(ref).toLowerCase();
  const match = states.find((s) => s.entity_id.startsWith('script.') && (
    s.entity_id.toLowerCase() === needle ||
    s.entity_id.toLowerCase() === `script.${needle}` ||
    String(s.attributes?.friendly_name || '').toLowerCase() === needle));
  if (!match) {
    throw new Error(`no script matching "${ref}" — try \`ha-ws-client states-filter "script.*"\` ` +
      `(matched on entity_id or friendly name)`);
  }
  const objectId = match.entity_id.slice('script.'.length);

  // Which id does HA file this script's traces under? Normally its object id,
  // but ask the trace list rather than assume — and fall back to the registry's
  // unique_id if the object id has no traces and that one does.
  let itemId = objectId;
  try {
    const known = new Set(((await ws.send({ type: 'trace/list', domain: 'script' })) || []).map((t) => t.item_id));
    if (!known.has(objectId)) {
      const reg = await ws.send({ type: 'config/entity_registry/get', entity_id: match.entity_id });
      if (reg?.unique_id && known.has(String(reg.unique_id))) itemId = String(reg.unique_id);
    }
  } catch { /* keep the object id */ }

  return itemFromState('script', match, itemId);
}

function itemFromState(domain, s, itemId) {
  return {
    domain,
    entity_id: s.entity_id,
    item_id: itemId,
    alias: s.attributes?.friendly_name || null,
    state: s.state,
    mode: s.attributes?.mode ?? null,
    current: s.attributes?.current ?? null,
    max: s.attributes?.max ?? null,
    last_triggered: s.attributes?.last_triggered || null,
  };
}

async function resolveAutomationItem(ws, ref) {
  const found = await resolveAutomation(ws, ref);
  if (!found.id) throw new Error(`${found.entity_id} has no internal id, so it has no traces`);
  return {
    domain: 'automation', entity_id: found.entity_id, item_id: found.id, alias: found.alias, state: found.state,
    last_triggered: found.last_triggered, mode: null, current: null, max: null,
  };
}

/**
 * Resolve what the user typed to {domain, entity_id, item_id, …}. The domain
 * comes from a qualified entity_id, else --domain, else automation first and
 * script as the fallback (said on stderr, so a surprise is never silent).
 */
async function resolveTraceItem(ws, ref, domainFlag) {
  const qualified = /^(automation|script)\.(.+)$/i.exec(ref);
  let domain = domainFlag || null;
  if (qualified) {
    const d = qualified[1].toLowerCase();
    if (domain && domain !== d) throw new UsageError(`--domain ${domain} conflicts with ${ref} (a ${d})`);
    domain = d;
  }
  if (domain) return domain === 'script' ? resolveScript(ws, ref) : resolveAutomationItem(ws, ref);

  try {
    return await resolveAutomationItem(ws, ref);
  } catch (autoErr) {
    if (!/^no automation matching/.test(autoErr.message)) throw autoErr;
    try {
      const item = await resolveScript(ws, ref);
      console.error(`note: no automation matching "${ref}"; using ${item.entity_id} (pass --domain to be explicit)`);
      return item;
    } catch (scriptErr) {
      if (!/^no script matching/.test(scriptErr.message)) throw scriptErr;
      throw new Error(`no automation or script matching "${ref}" — try \`ha-tools automation list\` or ` +
        `\`ha-ws-client states-filter "script.*"\` (matched on entity_id, internal id, or friendly name)`);
    }
  }
}

const listRuns = async (ws, item) =>
  (await ws.send({ type: 'trace/list', domain: item.domain, item_id: item.item_id })) || [];

const getRun = (ws, domain, itemId, runId) =>
  ws.send({ type: 'trace/get', domain, item_id: itemId, run_id: runId });

/** The run asked for, else the newest. Returns the trace/get detail. */
async function fetchRun(ws, item, runId) {
  if (runId) return getRun(ws, item.domain, item.item_id, runId);
  const runs = T.newestFirst(await listRuns(ws, item));
  if (!runs.length) {
    throw new Error(`no stored traces for ${item.entity_id} — it may not have run, or traces are disabled/cleared ` +
      `(last_triggered: ${item.last_triggered || 'never'})`);
  }
  return getRun(ws, item.domain, item.item_id, runs[0].run_id);
}

const startOf = (t) => toMillis(t?.timestamp?.start);

/* ------------------------------------------------------------ command shapes */

/** `<entity> [run_id]` — the common shape of the per-run commands. */
function perRun(def) {
  return {
    usage: '<entity_id> [run_id] [--domain script|automation]',
    flags: DOMAIN_FLAG,
    flagHelp: { ...DOMAIN_HELP, '[run_id]': 'a run from `traces`; default: the newest run' },
    min: 1,
    max: 2,
    validate: validateDomain,
    ...def,
    async run(ctx) {
      const item = await resolveTraceItem(ctx.ws, ctx.pos[0], ctx.opt.domain);
      return def.run({ ...ctx, item, runId: ctx.pos[1] });
    },
  };
}

const EXAMPLES = (cmd) => [
  [`script.nick_blind_creep_open`, 'the newest run of a script'],
  [`automation.hall_light_off <run_id> --json`, 'a specific run, machine-readable'],
  ...(cmd === 'trace-latest' ? [['--domain script nick_blind_creep_open', 'domain from a flag instead']] : []),
];

/* -------------------------------------------------------------------- traces */

const traces = {
  name: 'traces',
  usage: '[entity_id] [--domain script|automation]',
  summary: 'List stored traces, newest first: one entity\'s, or every automation\'s (or script\'s, with --domain script).',
  flags: DOMAIN_FLAG,
  flagHelp: DOMAIN_HELP,
  validate: validateDomain,
  max: 1,
  examples: [
    ['script.nick_blind_creep_open'],
    ['--domain script', 'every stored script trace'],
    ['automation.hall_light_off --from 2026-10-17 --compact'],
  ],
  async run({ ws, pos, opt, out }) {
    const { parseFlexibleDate } = require('../lib/ha-args.cjs');
    let item = null;
    let domain = opt.domain || 'automation';
    if (pos[0]) { item = await resolveTraceItem(ws, pos[0], opt.domain); domain = item.domain; }

    const message = { type: 'trace/list', domain };
    if (item) message.item_id = item.item_id;
    let list = (await ws.send(message)) || [];
    if (opt.from) {
      const from = parseFlexibleDate(opt.from).getTime();
      list = list.filter((t) => (startOf(t) ?? 0) > from);
    }
    if (opt.to) {
      const to = parseFlexibleDate(opt.to).getTime();
      list = list.filter((t) => (startOf(t) ?? 0) <= to);
    }

    if (!list.length && item) {
      out.data(out.isJson
        ? { entity_id: item.entity_id, traces: [], last_triggered: item.last_triggered, message: 'No stored traces. Traces may be disabled or cleared.' }
        : `No stored traces for ${item.entity_id}${item.last_triggered ? ` (last_triggered: ${item.last_triggered})` : ''} — traces may be disabled, cleared, or ` +
          `past the stored-traces limit.`,
      { command: 'traces', count: 0 });
      return;
    }

    // item_id → entity_id, so a row says "script.x" rather than the bare id.
    const names = new Map();
    if (item) names.set(item.item_id, item.entity_id);
    else {
      for (const s of (await ws.send({ type: 'get_states' })) || []) {
        if (!s.entity_id.startsWith(`${domain}.`)) continue;
        names.set(domain === 'automation' ? String(s.attributes?.id ?? '') : s.entity_id.slice(domain.length + 1), s.entity_id);
      }
    }
    const nameOf = (t) => names.get(String(t.item_id)) || `${domain}:${t.item_id}`;

    const sorted = T.newestFirst(list);
    // JSON keeps HA's own list untouched so existing parsers see what they saw.
    if (out.isJson) { out.list(list, { command: 'traces' }); return; }
    out.list(sorted, {
      title: `${domain === 'script' ? 'Script' : 'Automation'} traces`,
      command: 'traces',
      formatter: (t) => {
        const state = t.script_execution || t.state || '';
        const ms = startOf(t);
        const when = ms === null ? '' : out.stamp(ms);
        const running = T.isRunning(t) && state !== 'running' ? ' [running]' : '';
        return out.isCompact
          ? `${nameOf(t)} ${t.run_id} ${state}${running} ${when}`.trim()
          : `${nameOf(t)}\n  Run ID: ${t.run_id}\n  State: ${state}${running}\n  Started: ${when}` +
            (t.last_step ? `\n  Last step: ${t.last_step}` : '');
      },
    });
  },
};

/* ------------------------------------------------------- raw per-run commands */

const trace = perRun({
  name: 'trace',
  summary: 'The full trace of one run, as Home Assistant returns it (trace/get).',
  examples: EXAMPLES('trace'),
  async run({ ws, item, runId, out }) {
    const detail = await fetchRun(ws, item, runId);
    out.data(detail, { command: 'trace' });
  },
});

const traceLatest = perRun({
  name: 'trace-latest',
  usage: '<entity_id> [--domain script|automation]',
  summary: 'The newest run\'s full trace — for an automation or a script.',
  examples: EXAMPLES('trace-latest'),
  max: 1,
  async run({ ws, item, out }) {
    out.data(await fetchRun(ws, item, undefined), { command: 'trace-latest' });
  },
});

const traceDebug = perRun({
  name: 'trace-debug',
  summary: 'Everything about a run (trace/get), for debugging; the newest run if none is given.',
  examples: EXAMPLES('trace-debug'),
  async run({ ws, item, runId, out }) {
    out.data(await fetchRun(ws, item, runId), { command: 'trace-debug' });
  },
});

const traceSummary = {
  name: 'trace-summary',
  usage: '<entity_id> [--domain script|automation]',
  summary: 'Counts of finished / errored / other runs, plus the latest run and what started it.',
  flags: DOMAIN_FLAG,
  flagHelp: DOMAIN_HELP,
  validate: validateDomain,
  min: 1,
  max: 1,
  examples: [['script.nick_blind_creep_open'], ['automation.hall_light_off --json']],
  async run({ ws, pos, opt, out }) {
    const item = await resolveTraceItem(ws, pos[0], opt.domain);
    const runs = T.newestFirst(await listRuns(ws, item));
    // `automation_id` is the key ha-ws-client used; kept for automations so parsers don't break.
    const base = { entity_id: item.entity_id, domain: item.domain, ...(item.domain === 'automation' ? { automation_id: item.entity_id } : {}) };
    if (!runs.length) {
      out.data({ ...base, total_traces: 0, finished: 0, errors: 0, other: 0, running: 0, last_triggered: item.last_triggered,
        message: 'No traces found.' }, { command: 'trace-summary' });
      return;
    }
    let finished = 0; let errors = 0; let other = 0; let running = 0;
    for (const t of runs) {
      if (T.isRunning(t)) running++;
      const state = t.script_execution || t.state;
      if (state === 'finished') finished++;
      else if (state === 'error') errors++;
      else other++;
    }
    const latest = runs[0];
    const detail = await getRun(ws, item.domain, item.item_id, latest.run_id);
    const summary = {
      ...base,
      total_traces: runs.length,
      finished, errors, other, running,
      last_run: { run_id: latest.run_id, state: latest.script_execution || latest.state || '', timestamp: latest.timestamp },
      trigger: describeTriggerOf(detail),
    };
    if (detail?.error) summary.last_error = detail.error;
    out.data(summary, { command: 'trace-summary' });
  },
};

function describeTriggerOf(detail) {
  const t = detail?.trigger;
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t.description || t.platform || 'trigger';
}

/* ----------------------------------------------------------- derived views */

const traceVars = perRun({
  name: 'trace-vars',
  summary: 'The variables seen along a run, in the order the steps happened.',
  examples: EXAMPLES('trace-vars'),
  async run({ ws, item, runId, out }) {
    const detail = await fetchRun(ws, item, runId);
    const rows = [];
    for (const step of T.flattenSteps(detail)) {
      if (step.variables) rows.push({ path: step.path, variables: step.variables });
      if (step.changed_variables) rows.push({ path: step.path, changed_variables: step.changed_variables });
    }
    out.list(rows, { title: `Variables for trace ${detail?.run_id || runId || ''}`.trim(), command: 'trace-vars' });
  },
});

function stepRow(step, detail, out) {
  const cfg = T.configAt(detail?.config, step.path);
  const desc = T.describeAction(cfg);
  return {
    timestamp: step.timestamp,
    time: step.ms === null || step.ms === undefined ? null : out.stamp(step.ms),
    path: step.path,
    breadcrumb: T.breadcrumb(step.path),
    type: desc.type,
    action: desc.summary,
    error: step.error ?? null,
    child_id: step.child_id ?? null,
  };
}

const traceTimeline = perRun({
  name: 'trace-timeline',
  summary: 'Every step of a run in the order it happened, with where it sits in the config (parallel branch, choose option, …).',
  examples: EXAMPLES('trace-timeline'),
  async run({ ws, item, runId, out }) {
    const detail = await fetchRun(ws, item, runId);
    const rows = T.flattenSteps(detail).map((s) => stepRow(s, detail, out));
    out.timeline(rows, {
      title: `Execution timeline for ${detail?.run_id || runId || ''}`.trim(),
      command: 'trace-timeline',
      formatter: (r) => {
        if (out.isCompact) return `${r.time || r.timestamp} ${r.path}${r.error ? ` ERROR: ${r.error}` : ''}`;
        const child = r.child_id ? `  → ${r.child_id.domain}.${r.child_id.item_id} run ${r.child_id.run_id}` : '';
        return `${r.time || r.timestamp}  ${r.path}  [${r.breadcrumb}]  ${r.action}${child}${r.error ? `  ERROR: ${r.error}` : ''}`;
      },
    });
  },
});

const isTriggerOrCondition = (path) => {
  const top = T.splitPath(path)[0];
  return top === 'trigger' || top === 'triggers' || top === 'condition' || top === 'conditions';
};

const resultBrief = (step) => {
  if (step.error) return `ERROR ${typeof step.error === 'string' ? step.error : JSON.stringify(step.error)}`;
  if (step.result === undefined || step.result === null) return 'no result';
  if (step.result.response !== undefined) return `response ${JSON.stringify(step.result.response)}`;
  const text = JSON.stringify(step.result);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
};

const traceActions = perRun({
  name: 'trace-actions',
  summary: 'What each action step did and returned. Includes steps nested in parallel / choose / if / repeat, and a script\'s `sequence/…` steps.',
  examples: EXAMPLES('trace-actions'),
  async run({ ws, item, runId, out }) {
    const detail = await fetchRun(ws, item, runId);
    const rows = T.flattenSteps(detail).filter((s) => !isTriggerOrCondition(s.path)).map((s) => ({
      ...stepRow(s, detail, out), result: s.result ?? null,
    }));
    out.list(rows, {
      title: `Actions for trace ${detail?.run_id || runId || ''}`.trim(),
      command: 'trace-actions',
      formatter: (r) => out.isCompact ? r.path
        : `${r.path}  [${r.breadcrumb}]  ${r.action}: ${resultBrief({ result: r.result, error: r.error })}`,
    });
  },
});

const traceTrigger = perRun({
  name: 'trace-trigger',
  summary: 'What started a run. Scripts have no trigger, so this reports the context they were started in.',
  examples: [['automation.hall_light_off'], ['script.nick_blind_creep_open', 'prints the context, not a trigger']],
  async run({ ws, item, runId, out }) {
    const detail = await fetchRun(ws, item, runId);
    if (detail?.trigger) { out.data(detail.trigger, { command: 'trace-trigger' }); return; }
    const note = item.domain === 'script'
      ? 'Scripts have no trigger; this run was started in the context below.'
      : 'No trigger information available for this run.';
    if (out.isJson) out.data({ trigger: null, context: detail?.context ?? null, note }, { command: 'trace-trigger' });
    else {
      out.message(note);
      if (detail?.context) out.data(detail.context, { command: 'trace-trigger' });
    }
  },
});

/* -------------------------------------------------- automation-config etc. */

const automationConfig = {
  name: 'automation-config',
  usage: '<entity_id> [--domain script|automation]',
  summary: 'The config HA is running for an automation (or script): from its latest trace when there is one — that includes blueprint inputs resolved — else from the config API.',
  flags: DOMAIN_FLAG,
  flagHelp: DOMAIN_HELP,
  validate: validateDomain,
  min: 1,
  max: 1,
  examples: [['automation.hall_light_off'], ['script.nick_blind_creep_open --json']],
  async run({ ws, pos, opt, out }) {
    const item = await resolveTraceItem(ws, pos[0], opt.domain);
    const hasBody = (c) => c && (c.trigger || c.triggers || c.action || c.actions || c.sequence);
    try {
      const runs = T.newestFirst(await listRuns(ws, item));
      if (runs.length) {
        const detail = await getRun(ws, item.domain, item.item_id, runs[0].run_id);
        if (hasBody(detail?.config)) { out.data(detail.config, { command: 'automation-config' }); return; }
      }
    } catch { /* fall through to the config API */ }

    let result;
    try {
      result = await ws.send({ type: `${item.domain}/config`, entity_id: item.entity_id });
    } catch (e) {
      throw new Error(`could not read config for ${item.entity_id}: websocket ${item.domain}/config failed (${e.message})`);
    }
    const config = result?.config ?? result ?? null;
    if (!hasBody(config)) {
      console.error(`note: ${item.domain}/config returned no triggers/actions for ${item.entity_id}, and it has no stored trace to read them from`);
    }
    out.data(config, { command: 'automation-config' });
  },
};

const blueprintInputs = {
  name: 'blueprint-inputs',
  usage: '<entity_id>',
  summary: 'The blueprint an automation uses and the inputs it passes.',
  min: 1,
  max: 1,
  examples: [['automation.hall_light_motion'], ['automation.hall_light_motion --json']],
  async run({ ws, pos, out }) {
    const entityId = /^automation\./.test(pos[0]) ? pos[0] : `automation.${pos[0]}`;
    const result = await ws.send({ type: 'automation/config', entity_id: entityId });
    const config = result?.config ?? result ?? {};
    if (!config.use_blueprint) {
      out.message(`No use_blueprint in the config Home Assistant returned for ${entityId}. Either it is not a blueprint ` +
        `automation, or the config API does not expose it — see \`ha-tools automation yaml ${entityId}\` and the trace's config.`);
      return;
    }
    out.data({ blueprint_path: config.use_blueprint.path, inputs: config.use_blueprint.input }, { command: 'blueprint-inputs' });
  },
};

/* ------------------------------------------------------------------ running */

/**
 * What the run mode does to the *next* trigger while this one is running. A fact
 * about the mode, not a claim that the run is stuck.
 */
function effectOf(row) {
  const max = row.max ?? (row.mode === 'single' ? 1 : null);
  const full = max !== null && (row.current ?? 0) >= max;
  switch (row.mode) {
    case 'single': return 'new runs dropped';
    case 'restart': return 'next trigger restarts it';
    case 'queued': return full ? 'new runs dropped (queue full)' : 'new runs queue behind it';
    case 'parallel': return full ? 'new runs dropped (at max)' : '';
    default: return '';
  }
}

async function activeItems(ws, domains) {
  const states = (await ws.send({ type: 'get_states' })) || [];
  const items = [];
  for (const s of states) {
    const domain = s.entity_id.split('.')[0];
    if (!domains.includes(domain)) continue;
    const current = Number(s.attributes?.current ?? 0);
    // A script is "on" while it runs; an automation's "on" only means enabled.
    const active = domain === 'script' ? s.state === 'on' || current > 0 : current > 0;
    if (!active) continue;
    items.push({ ...itemFromState(domain, s, domain === 'automation' ? String(s.attributes?.id ?? '') : s.entity_id.slice('script.'.length)),
      current: Number.isFinite(current) ? current : null });
  }
  return items;
}

const running = {
  name: 'running',
  usage: '[--domain script|automation]',
  summary: 'Every automation and script executing right now: how long, run mode, runs/limit, last_triggered — so a stuck `mode: single` script is obvious.',
  details: 'Durations come from the running trace Home Assistant stores for the run. If an item is running but no running\n' +
    'trace is stored (traces off, or evicted), its duration is shown as unknown rather than guessed from last_triggered.\n' +
    '"Effect" states what the mode does to the next trigger while it is at its limit; it does not claim the run is stuck.',
  flags: DOMAIN_FLAG,
  flagHelp: DOMAIN_HELP,
  validate: validateDomain,
  max: 0,
  examples: [[''], ['--domain script --json'], ['--compact']],
  async run({ ws, opt, out, clock }) {
    const domains = opt.domain ? [opt.domain] : ['script', 'automation'];
    const items = await activeItems(ws, domains);
    const now = Date.now();

    const runningByKey = new Map();
    for (const domain of domains) {
      for (const t of (await ws.send({ type: 'trace/list', domain })) || []) {
        if (!T.isRunning(t)) continue;
        const key = `${domain}:${t.item_id}`;
        if (!runningByKey.has(key)) runningByKey.set(key, []);
        runningByKey.get(key).push(t);
      }
    }

    const rows = [];
    for (const item of items) {
      let runs = runningByKey.get(`${item.domain}:${item.item_id}`) || [];
      if (!runs.length && item.domain === 'script') {
        // The trace may be filed under the registry id rather than the object id.
        try {
          const reg = await ws.send({ type: 'config/entity_registry/get', entity_id: item.entity_id });
          if (reg?.unique_id) runs = runningByKey.get(`script:${reg.unique_id}`) || [];
        } catch { /* no registry entry */ }
      }
      const lastTriggeredMs = toMillis(item.last_triggered);
      const base = {
        entity_id: item.entity_id,
        domain: item.domain,
        alias: item.alias,
        mode: item.mode,
        current: item.current,
        max: item.max ?? (item.mode === 'single' ? 1 : null),
        last_triggered: lastTriggeredMs === null ? null : clock.stamp(lastTriggeredMs),
      };
      const effect = effectOf({ ...base });
      for (const t of runs.length ? T.newestFirst(runs) : [null]) {
        const ms = t ? startOf(t) : null;
        const secs = ms === null ? null : Math.max(0, (now - ms) / 1000);
        rows.push({
          ...base,
          effect,
          run_id: t?.run_id ?? null,
          started: ms === null ? null : clock.stamp(ms),
          running_for_s: secs === null ? null : Math.round(secs),
          running_for: secs === null ? null : longDuration(secs),
          last_step: t?.last_step ?? null,
          last_step_breadcrumb: t?.last_step ? T.breadcrumb(t.last_step) : null,
          note: t ? undefined : 'no running trace stored; duration unknown',
        });
      }
    }
    rows.sort((a, b) => (b.running_for_s ?? -1) - (a.running_for_s ?? -1) || a.entity_id.localeCompare(b.entity_id));

    if (out.isJson) {
      out.data({ timezone: clock.timeZone, count: rows.length, running: rows }, { command: 'running', count: rows.length });
      return;
    }
    if (out.showHeaders) {
      const offset = clock.offset(now);
      console.log(`# times are ${clock.timeZone}${offset ? ` (UTC${offset})` : ''}; ${rows.length} running`);
    }
    if (out.isCompact) {
      for (const r of rows) {
        console.log(`${r.entity_id} ${r.mode || '-'} ${r.current ?? '?'}/${r.max ?? '?'} ${r.running_for || '?'} ${r.last_step || '-'}`);
      }
      return;
    }
    if (!rows.length) return;
    const cols = [
      ['ENTITY', (r) => r.entity_id],
      ['MODE', (r) => r.mode || '-'],
      ['RUNS', (r) => `${r.current ?? '?'}/${r.max ?? '?'}`],
      ['RUNNING FOR', (r) => r.running_for || '?'],
      ['STARTED', (r) => r.started || '-'],
      ['LAST TRIGGERED', (r) => r.last_triggered || '-'],
      ['EFFECT', (r) => r.effect || '-'],
      ['LAST STEP', (r) => (r.last_step ? `${r.last_step_breadcrumb}` : '-')],
    ];
    const width = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => f(r).length)));
    const line = (cells) => cells.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(width[i]))).join('  ').trimEnd();
    if (out.showHeaders) console.log(line(cols.map(([h]) => h)));
    for (const r of rows) console.log(line(cols.map(([, f]) => f(r))));
    if (rows.some((r) => r.note)) console.log('\n? = running, but no running trace is stored for it, so how long is unknown');
  },
};

/* --------------------------------------------------------------- trace-stuck */

async function renderOnce(ws, template) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'timed out rendering' }), 4000);
    ws.subscribe({ type: 'render_template', template, timeout: 3 }, (event) => {
      clearTimeout(timer);
      resolve(event?.error ? { error: String(event.error) } : { value: event?.result });
    }).catch((e) => { clearTimeout(timer); resolve({ error: e.message }); });
  });
}

/**
 * Describe one open step: what it is, how long it has been there, what it waits
 * on — and, when it is a script call, the run it is waiting for.
 */
async function describeOpen(ws, open, detail, nowMs, opts, depth) {
  const cfg = T.configAt(detail?.config, open.path);
  const desc = T.describeAction(cfg);
  const waitingFor = open.ms === null || open.ms === undefined ? null : Math.max(0, (nowMs - open.ms) / 1000);
  const result = open.step.result || {};
  const entry = {
    path: open.path,
    breadcrumb: T.breadcrumb(open.path),
    explicit: open.explicit,
    type: desc.type,
    summary: desc.summary,
    alias: desc.alias || null,
    started: open.step.timestamp ?? null,
    waiting_for_s: waitingFor === null ? null : Math.round(waitingFor),
    waiting_for: waitingFor === null ? null : longDuration(waitingFor),
  };

  if (desc.type === 'delay') {
    const configured = typeof result.delay === 'number' ? result.delay : desc.seconds;
    const remaining = configured !== null && configured !== undefined && waitingFor !== null ? configured - waitingFor : null;
    entry.waiting_on = {
      kind: 'delay',
      configured_s: configured ?? null,
      configured: configured === null || configured === undefined ? null : longDuration(configured),
      remaining_s: remaining === null ? null : Math.round(remaining),
      remaining: remaining === null ? null : (remaining >= 0 ? longDuration(remaining) : `overdue by ${longDuration(-remaining)}`),
    };
  } else if (desc.type === 'wait_template' || desc.type === 'wait_for_trigger') {
    const wait = result.wait || {};
    entry.waiting_on = {
      kind: desc.type,
      ...(desc.type === 'wait_template' ? { template: desc.template } : { triggers: desc.triggers }),
      timeout: desc.timeout,
      continue_on_timeout: desc.continue_on_timeout,
      completed: wait.completed ?? null,
    };
    if (desc.type === 'wait_template' && desc.template && !opts.noRender) {
      const r = await renderOnce(ws, desc.template);
      entry.waiting_on.currently_renders = r.error ? null : r.value;
      if (r.error) entry.waiting_on.render_error = r.error;
      entry.waiting_on.render_note = 'rendered now without the run\'s variables';
    }
  } else if (desc.type === 'service') {
    entry.waiting_on = { kind: 'service_call', note: 'a service call that has not returned yet' };
  } else {
    entry.waiting_on = { kind: desc.type };
  }
  if (!open.explicit) entry.note = 'inferred from the trace\'s last_step: the step records no result yet';

  const child = open.child_id;
  if (child) {
    entry.waiting_on = { ...(entry.waiting_on || {}), kind: 'script_call', calls: `${child.domain}.${child.item_id}`, child_run_id: child.run_id };
    if (!opts.noFollow && depth < 5) {
      try {
        const childDetail = await getRun(ws, child.domain, child.item_id, child.run_id);
        entry.child = await inspectRun(ws, childDetail, nowMs, opts, depth + 1, child);
      } catch (e) {
        entry.child_error = `could not read the child run: ${e.message}`;
      }
    }
  }
  return entry;
}

async function inspectRun(ws, detail, nowMs, opts, depth = 0, idHint = null) {
  const startMs = toMillis(detail?.timestamp?.start);
  const isRunning = T.isRunning(detail || {});
  const opens = isRunning ? T.openSteps(detail) : [];
  const described = [];
  for (const open of opens) described.push(await describeOpen(ws, open, detail, nowMs, opts, depth));
  if (described.length) described[0].primary = true;
  const runningFor = startMs === null ? null : Math.max(0, (nowMs - startMs) / 1000);
  return {
    domain: detail?.domain ?? idHint?.domain ?? null,
    item_id: detail?.item_id ?? idHint?.item_id ?? null,
    run_id: detail?.run_id ?? idHint?.run_id ?? null,
    state: detail?.state ?? null,
    script_execution: detail?.script_execution ?? null,
    running: isRunning,
    started_ms: startMs,
    running_for_s: runningFor === null ? null : Math.round(runningFor),
    running_for: runningFor === null ? null : longDuration(runningFor),
    last_step: detail?.last_step ?? null,
    open_steps: described,
    ...(isRunning && !described.length ? { note: 'running, but no step has been recorded yet' } : {}),
  };
}

function printInspection(r, out, indent = '') {
  const p = (s = '') => console.log(`${indent}${s}`.trimEnd());
  for (const o of r.open_steps) {
    p(`${o.primary ? 'waiting at' : 'also waiting at'}: ${o.breadcrumb}  (${o.path})${o.explicit ? '' : '  [inferred from last_step]'}`);
    p(`  ${o.summary}`);
    const w = o.waiting_on || {};
    const bits = [];
    if (o.waiting_for) bits.push(`here for ${o.waiting_for}`);
    if (w.kind === 'delay') {
      if (w.configured) bits.push(`delay ${w.configured}`);
      if (w.remaining) bits.push(`remaining: ${w.remaining}`);
    } else if (w.kind === 'wait_template') {
      if (w.timeout !== null && w.timeout !== undefined) bits.push(`timeout ${typeof w.timeout === 'object' ? JSON.stringify(w.timeout) : w.timeout}`);
      else bits.push('no timeout');
      if ('currently_renders' in w) bits.push(`template currently renders: ${JSON.stringify(w.currently_renders)}`);
      if (w.render_error) bits.push(`render failed: ${w.render_error}`);
    } else if (w.kind === 'wait_for_trigger') {
      bits.push(w.timeout !== null && w.timeout !== undefined ? `timeout ${JSON.stringify(w.timeout)}` : 'no timeout');
    } else if (w.kind === 'service_call') {
      bits.push(w.note);
    }
    if (bits.length) p(`  ${bits.join(' — ')}`);
    if (w.calls) p(`  → waiting on ${w.calls} run ${w.child_run_id}`);
    if (o.child) {
      p(`  child ${o.child.domain}.${o.child.item_id} run ${o.child.run_id}: running for ${o.child.running_for || '?'}`);
      printInspection(o.child, out, `${indent}    `);
    }
    if (o.child_error) p(`  ${o.child_error}`);
  }
  if (r.note) p(r.note);
}

const traceStuck = {
  name: 'trace-stuck',
  usage: '<entity_id> [run_id] [--domain script|automation] [--no-follow] [--no-render]',
  summary: 'For a run that has not finished: the deepest step it is on and what that step waits for (a delay, a wait_template, a call to another script…). One command for "which branch is hung".',
  details: 'Parallel scripts can wait in several branches at once; all are listed, the deepest first. A step calling another\n' +
    'script is followed into that script\'s run. A wait_template is rendered once, now, to show whether it would pass.\n' +
    'Steps whose state is only inferred (from the trace\'s last_step) are marked as such. If nothing is running, the\n' +
    'latest run is reported instead.',
  flags: { ...DOMAIN_FLAG, 'no-follow': 'bool', 'no-render': 'bool' },
  flagHelp: { ...DOMAIN_HELP, '--no-follow': 'do not descend into scripts this run is calling', '--no-render': 'do not render wait_template conditions' },
  validate: validateDomain,
  min: 1,
  max: 2,
  examples: [
    ['script.nick_blind_creep_open', 'where is the running one waiting?'],
    ['script.nick_blind_creep_open --json'],
    ['automation.hall_light_off <run_id> --no-follow'],
  ],
  async run({ ws, pos, opt, out, clock }) {
    const item = await resolveTraceItem(ws, pos[0], opt.domain);
    const opts = { noFollow: Boolean(opt.noFollow), noRender: Boolean(opt.noRender) };
    const now = Date.now();
    const all = T.newestFirst(await listRuns(ws, item));
    const targets = pos[1] ? all.filter((t) => t.run_id === pos[1]) : all.filter(T.isRunning);
    if (pos[1] && !targets.length) {
      // Not in the list (evicted?): ask for it directly rather than guess.
      targets.push({ run_id: pos[1] });
    }

    const inspections = [];
    for (const t of targets) {
      const detail = await getRun(ws, item.domain, item.item_id, t.run_id);
      inspections.push(await inspectRun(ws, detail, now, opts));
    }

    const latest = all[0] || null;
    const summary = {
      entity_id: item.entity_id,
      domain: item.domain,
      timezone: clock.timeZone,
      mode: item.mode,
      current: item.current,
      max: item.max,
      running: inspections.filter((i) => i.running).map(({ started_ms, ...i }) => ({ ...i, started: started_ms === null ? null : clock.stamp(started_ms) })),
      not_running: inspections.filter((i) => !i.running).map(({ started_ms, ...i }) => i),
      latest: latest ? {
        run_id: latest.run_id,
        state: latest.state ?? null,
        script_execution: latest.script_execution ?? null,
        started: startOf(latest) === null ? null : clock.stamp(startOf(latest)),
        finished: toMillis(latest.timestamp?.finish) === null ? null : clock.stamp(toMillis(latest.timestamp.finish)),
      } : null,
    };

    if (out.isJson) { out.data(summary, { command: 'trace-stuck' }); return; }

    if (!summary.running.length) {
      console.log(`${item.entity_id} is not running` +
        (pos[1] ? ` run ${pos[1]}` : '') + (item.current ? ` (but its state says current=${item.current})` : '') + '.');
      for (const r of summary.not_running) {
        console.log(`run ${r.run_id} finished (${r.script_execution || r.state || 'unknown'}); last step ${r.last_step || '-'}`);
      }
      if (!pos[1] && summary.latest) {
        const l = summary.latest;
        console.log(`latest run: ${l.run_id}  ${l.script_execution || l.state || ''}  started ${l.started || '?'}${l.finished ? `, finished ${l.finished}` : ''}`);
      } else if (!pos[1]) console.log('no stored traces.');
      return;
    }
    for (const r of summary.running) {
      console.log(`${item.entity_id} — run ${r.run_id} running for ${r.running_for || '?'}` +
        (r.started ? ` (started ${r.started})` : '') + (item.mode ? `, mode ${item.mode}` : '') +
        (item.current !== null && item.current !== undefined ? `, ${item.current}/${item.max ?? '?'} runs` : ''));
      printInspection(r, out, '  ');
      console.log();
    }
  },
};

module.exports = {
  commands: [traces, trace, traceLatest, traceSummary, traceVars, traceTimeline, traceTrigger, traceActions,
    traceDebug, automationConfig, blueprintInputs, running, traceStuck],
  resolveTraceItem, listRuns, getRun, fetchRun, validateDomain, DOMAIN_FLAG,
};
