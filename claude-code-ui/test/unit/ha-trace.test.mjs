/*
 * lib/ha-trace — reading Home Assistant traces without I/O.
 *
 * The cases that matter are the nested ones: a script's `parallel`, `choose`,
 * `if` and `repeat` each put steps at paths like sequence/1/parallel/0/sequence/2,
 * and "which branch is hung" is only answerable if those resolve back to config.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const T = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'lib', 'ha-trace.cjs'));

const SCRIPT = {
  sequence: [
    { variables: { x: 1 } },
    { parallel: [
      { sequence: [{ delay: '00:05:00' }, { action: 'cover.open_cover', target: { entity_id: 'cover.blind' } }] },
      { delay: 30 },                                      // a bare item, not wrapped in a sequence
    ] },
    { choose: [{ conditions: [{ condition: 'state', entity_id: 'light.a', state: 'on' }], sequence: [{ action: 'light.turn_off' }] }],
      default: [{ event: 'nope' }] },
    { if: [{ condition: 'state', entity_id: 'light.b', state: 'on' }], then: [{ delay: 5 }], else: [{ event: 'e' }] },
    { repeat: { count: 3, sequence: [{ action: 'script.child', data: {} }] } },
  ],
};

describe('configAt', () => {
  test('walks a script sequence', () => {
    assert.deepEqual(T.configAt(SCRIPT, 'sequence/0'), { variables: { x: 1 } });
  });
  test('walks parallel branches into their own sequences', () => {
    assert.deepEqual(T.configAt(SCRIPT, 'sequence/1/parallel/0/sequence/0'), { delay: '00:05:00' });
    assert.equal(T.configAt(SCRIPT, 'sequence/1/parallel/0/sequence/1').action, 'cover.open_cover');
  });
  test('a bare parallel item stands for a one-step sequence', () => {
    assert.deepEqual(T.configAt(SCRIPT, 'sequence/1/parallel/1/sequence/0'), { delay: 30 });
  });
  test('walks choose options and the default branch', () => {
    assert.equal(T.configAt(SCRIPT, 'sequence/2/choose/0/sequence/0').action, 'light.turn_off');
    assert.equal(T.configAt(SCRIPT, 'sequence/2/choose/0/conditions/0').condition, 'state');
    assert.deepEqual(T.configAt(SCRIPT, 'sequence/2/default/0'), { event: 'nope' });
  });
  test('walks if / then / else', () => {
    assert.deepEqual(T.configAt(SCRIPT, 'sequence/3/then/0'), { delay: 5 });
    assert.deepEqual(T.configAt(SCRIPT, 'sequence/3/else/0'), { event: 'e' });
    assert.equal(T.configAt(SCRIPT, 'sequence/3/if/0').entity_id, 'light.b');
  });
  test('HA\'s `if/condition/0` path (seen on a live instance) resolves to the condition', () => {
    // The config keeps the conditions directly under `if`; the trace inserts the word "condition".
    assert.equal(T.configAt(SCRIPT, 'sequence/3/if/condition/0').entity_id, 'light.b');
    assert.equal(T.configAt({ if: { condition: 'state', entity_id: 'light.c' } }, 'if/condition/0').entity_id, 'light.c');
    assert.equal(T.configAt(SCRIPT, 'sequence/3/if').length, 1, 'the bare `if` step is the condition list');
  });
  test('walks repeat', () => {
    assert.equal(T.configAt(SCRIPT, 'sequence/4/repeat/sequence/0').action, 'script.child');
  });
  test('reads an automation under either key spelling', () => {
    assert.deepEqual(T.configAt({ action: [{ a: 1 }] }, 'action/0'), { a: 1 });
    assert.deepEqual(T.configAt({ actions: [{ a: 1 }] }, 'action/0'), { a: 1 });
    assert.deepEqual(T.configAt({ triggers: [{ t: 1 }] }, 'trigger/0'), { t: 1 });
  });
  test('a path the config does not have is undefined, not a throw', () => {
    assert.equal(T.configAt(SCRIPT, 'sequence/9'), undefined);
    assert.equal(T.configAt(SCRIPT, 'sequence/1/parallel/7/sequence/0'), undefined);
    assert.equal(T.configAt(undefined, 'sequence/0'), undefined);
    assert.equal(T.configAt({}, 'wat/0'), undefined);
  });
});

describe('parseDelay', () => {
  test('reads every spelling HA accepts', () => {
    assert.equal(T.parseDelay('00:05:00'), 300);
    assert.equal(T.parseDelay('1:30'), 5400);
    assert.equal(T.parseDelay(45), 45);
    assert.equal(T.parseDelay('45'), 45);
    assert.equal(T.parseDelay({ minutes: 10 }), 600);
    assert.equal(T.parseDelay({ hours: 1, seconds: 5, milliseconds: 500 }), 3605.5);
  });
  test('a template or garbage is null, never NaN', () => {
    assert.equal(T.parseDelay('{{ states("input_number.x") | int }}'), null);
    assert.equal(T.parseDelay({ minutes: '{{ x }}' }), null);
    assert.equal(T.parseDelay('soon'), null);
  });
});

describe('describeAction', () => {
  const d = (cfg) => T.describeAction(cfg);
  test('names the kinds of step', () => {
    assert.equal(d({ delay: '00:00:30' }).type, 'delay');
    assert.equal(d({ delay: '00:00:30' }).seconds, 30);
    assert.equal(d({ wait_template: '{{ true }}', timeout: 60 }).type, 'wait_template');
    assert.equal(d({ wait_for_trigger: [{ platform: 'state', entity_id: 'a.b', to: 'on' }] }).type, 'wait_for_trigger');
    assert.equal(d({ action: 'light.turn_on', target: { entity_id: 'light.a' } }).type, 'service');
    assert.equal(d({ service: 'light.turn_on' }).type, 'service');
    assert.equal(d({ choose: [] }).type, 'choose');
    assert.equal(d({ if: [], then: [] }).type, 'if');
    assert.equal(d({ parallel: [{}, {}] }).summary, 'parallel (2 branches)');
    assert.equal(d({ repeat: { count: 3 } }).summary, 'repeat 3 times');
    assert.equal(d({ event: 'x' }).type, 'event');
    assert.equal(d({ stop: 'done' }).type, 'stop');
    assert.equal(d({ condition: 'state', entity_id: 'a.b' }).type, 'condition');
  });
  test('a call to another script is told apart from starting one', () => {
    assert.equal(d({ action: 'script.child' }).type, 'script_call');
    assert.equal(d({ action: 'script.child' }).script, 'script.child');
    assert.equal(d({ action: 'script.turn_on', target: { entity_id: 'script.child' } }).type, 'script_start');
  });
  test('a list of conditions (an `if` step\'s own path) is described as one, not as a step with keys 0,1', () => {
    assert.deepEqual(d([{ condition: 'state' }, { condition: 'time' }]), { type: 'conditions', summary: '2 conditions', alias: null });
    assert.equal(d([{ condition: 'state' }]).summary, '1 condition');
  });
  test('a missing node says so rather than guessing', () => {
    assert.equal(d(undefined).type, 'unknown');
  });
});

describe('breadcrumb', () => {
  test('reads nested paths', () => {
    assert.equal(T.breadcrumb('sequence/1/parallel/0/sequence/2'), 'sequence[1] › parallel branch 0 › sequence[2]');
    assert.equal(T.breadcrumb('sequence/3/choose/1/sequence/0'), 'sequence[3] › choose option 1 › sequence[0]');
    assert.equal(T.breadcrumb('sequence/3/default/0'), 'sequence[3] › choose default[0]');
    assert.equal(T.breadcrumb('sequence/4/else/0'), 'sequence[4] › else[0]');
    assert.equal(T.breadcrumb('action/2'), 'action[2]');
    assert.equal(T.breadcrumb('sequence/5/repeat/sequence/0'), 'sequence[5] › repeat › sequence[0]');
  });
});

describe('openSteps', () => {
  const at = (n) => new Date(Date.UTC(2026, 9, 18, 10, 0, n)).toISOString();
  const step = (path, n, extra = {}) => ({ path, timestamp: at(n), ...extra });

  test('a delay that says done:false is open — and explicit', () => {
    const detail = { last_step: 'sequence/0', trace: { 'sequence/0': [step('sequence/0', 1, { result: { delay: 60, done: false } })] } };
    const open = T.openSteps(detail);
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, 'delay');
    assert.equal(open[0].explicit, true);
  });

  test('every waiting branch of a parallel run is reported, deepest first', () => {
    const detail = {
      last_step: 'sequence/1/parallel/1/sequence/0',
      trace: {
        'sequence/1': [step('sequence/1', 1)],
        'sequence/1/parallel/0/sequence/0': [step('sequence/1/parallel/0/sequence/0', 2, { result: { delay: 300, done: false } })],
        'sequence/1/parallel/1/sequence/0': [step('sequence/1/parallel/1/sequence/0', 3, { result: { wait: { remaining: 100, completed: false } } })],
      },
    };
    const open = T.openSteps(detail);
    assert.deepEqual(open.map((o) => o.path), ['sequence/1/parallel/1/sequence/0', 'sequence/1/parallel/0/sequence/0']);
    assert.deepEqual(open.map((o) => o.kind), ['wait', 'delay']);
    assert.ok(open.every((o) => o.explicit));
  });

  test('a finished delay or a completed wait is not open', () => {
    const detail = {
      last_step: 'sequence/2',
      trace: {
        'sequence/0': [step('sequence/0', 1, { result: { delay: 5, done: true } })],
        'sequence/1': [step('sequence/1', 2, { result: { wait: { completed: true } } })],
        'sequence/2': [step('sequence/2', 3, { result: { params: {}, running_script: false } })],
      },
    };
    const open = T.openSteps(detail);
    // Only last_step is a candidate, and it is flagged as inferred.
    assert.deepEqual(open.map((o) => [o.path, o.explicit]), [['sequence/2', false]]);
  });

  test('last_step with no result yet is inferred, and says so', () => {
    const detail = { last_step: 'sequence/0', trace: { 'sequence/0': [step('sequence/0', 1)] } };
    assert.deepEqual(T.openSteps(detail).map((o) => [o.path, o.explicit, o.kind]), [['sequence/0', false, 'in_progress']]);
  });

  test('a script call carries the child run it is waiting for', () => {
    const child = { domain: 'script', item_id: 'child', run_id: 'c1' };
    const detail = { last_step: 'sequence/0', trace: { 'sequence/0': [step('sequence/0', 1, { child_id: child })] } };
    const [open] = T.openSteps(detail);
    assert.equal(open.kind, 'call');
    assert.deepEqual(open.child_id, child);
  });

  test('a step that errored is not "waiting"', () => {
    const detail = { last_step: 'sequence/0', trace: { 'sequence/0': [step('sequence/0', 1, { error: 'boom', result: { delay: 5, done: false } })] } };
    assert.deepEqual(T.openSteps(detail), []);
  });

  test('an empty or missing trace is no open steps', () => {
    assert.deepEqual(T.openSteps({}), []);
    assert.deepEqual(T.openSteps(undefined), []);
  });

  test('the later step breaks a tie in depth', () => {
    const detail = {
      last_step: 'sequence/1/parallel/0/sequence/0',
      trace: {
        'sequence/1/parallel/0/sequence/0': [step('sequence/1/parallel/0/sequence/0', 5, { result: { delay: 1, done: false } })],
        'sequence/1/parallel/1/sequence/0': [step('sequence/1/parallel/1/sequence/0', 9, { result: { delay: 1, done: false } })],
      },
    };
    assert.equal(T.openSteps(detail)[0].path, 'sequence/1/parallel/1/sequence/0');
  });
});

describe('flattenSteps / newestFirst / isRunning', () => {
  test('flattenSteps is chronological whatever order the paths were stored in', () => {
    const detail = { trace: {
      'sequence/2': [{ path: 'sequence/2', timestamp: '2026-10-18T10:00:03Z' }],
      'sequence/0': [{ path: 'sequence/0', timestamp: '2026-10-18T10:00:01Z' }],
      'sequence/1': [{ path: 'sequence/1', timestamp: '2026-10-18T10:00:02Z' }],
    } };
    assert.deepEqual(T.flattenSteps(detail).map((s) => s.path), ['sequence/0', 'sequence/1', 'sequence/2']);
  });
  test('newestFirst does not rely on the order HA lists runs in', () => {
    const asc = [{ run_id: 'old', timestamp: { start: '2026-10-18T09:00:00Z' } }, { run_id: 'new', timestamp: { start: '2026-10-18T11:00:00Z' } }];
    assert.equal(T.newestFirst(asc)[0].run_id, 'new');
    assert.equal(T.newestFirst([...asc].reverse())[0].run_id, 'new');
  });
  test('isRunning trusts state, and falls back to a missing finish time', () => {
    assert.equal(T.isRunning({ state: 'running' }), true);
    assert.equal(T.isRunning({ state: 'stopped', timestamp: { start: 'x' } }), false);
    assert.equal(T.isRunning({ timestamp: { start: 'x' } }), true);
    assert.equal(T.isRunning({ timestamp: { start: 'x', finish: 'y' } }), false);
  });
});

describe('formatDuration', () => {
  test('hours, and days past a day', () => {
    assert.equal(T.formatDuration(0), '0:00:00');
    assert.equal(T.formatDuration(2533), '0:42:13');
    assert.equal(T.formatDuration(3 * 3600 + 5), '3:00:05');
    assert.equal(T.formatDuration(86400 + 3661), '1d 01:01:01');
    assert.equal(T.formatDuration(-5), '0:00:00');
  });
});
