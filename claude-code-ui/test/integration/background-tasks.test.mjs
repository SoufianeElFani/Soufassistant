/*
 * Background tasks that outlive the foreground turn's own `result` — the bug
 * fixed by streaming the prompt (server/lib/input-channel.js) instead of
 * handing the SDK a plain string. Confirmed live against the real SDK/CLI
 * (0.3.284 / 2.1.284): a string prompt makes the SDK close the CLI's stdin as
 * soon as `result` arrives, and every control request after that — a
 * PreToolUse hook, a canUseTool ask — is then denied inside the CLI with its
 * canned "doesn't want to take this action" text, with no host code ever
 * running. These assertions pin the wire contract the fix relies on: the
 * channel stays open, a tool call after `result` still goes through
 * canUseTool, and the run only ends once no background task is left.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function backgroundRunSteps() {
  return [
    // The model spawns a background subagent; the foreground turn ends.
    { emit: { type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg1', task_type: 'local_agent', description: 'Background subagent' }] } },
    { text: 'spawned' },
    { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, usage } },
    { sleep: 30 },
    // The subagent is still working — a tool call reaches this host well after
    // that `result`. With a string prompt this would be denied locally inside
    // the CLI before the hook/canUseTool ever ran; with the streamed channel it
    // goes through normally.
    { emit: { type: 'system', subtype: 'task_progress', task_id: 'bg1', last_tool_name: 'Bash', summary: 'running' } },
    { tool: { name: 'Bash', input: { command: 'echo hi' }, id: 'bgtool1', output: 'hi' } },
    // The subagent finishes and hands back control.
    { emit: { type: 'system', subtype: 'background_tasks_changed', tasks: [] } },
    { emit: { type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed',
      summary: 'Background agent finished' } },
    { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.02, num_turns: 1, usage } },
  ];
}

describe('a background task outliving the foreground turn', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: backgroundRunSteps(), noResult: true }] } });
  });
  after(async () => { await h.stop(); });

  test('the wire shows it running, a result still names it, and the post-result tool call is not silently denied', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    // bypass still routes every tool through canUseTool (only 'auto' has none),
    // so an 'allow' tool_decision here proves the control channel was live for
    // a call placed well after the first `result`.
    c.send({ type: 'prompt', text: 'spawn it', permissionMode: 'bypass' });

    const running = await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 1);
    assert.equal(running.tasks[0].id, 'bg1');
    assert.equal(running.tasks[0].description, 'Background subagent');

    const firstResult = await c.waitFor('result');
    assert.equal(firstResult.background, true, 'result arrived while a background task is still live');

    const decision = await h.waitForRecord((r) => r.kind === 'tool_decision' && r.tool === 'Bash');
    assert.equal(decision.outcome.behavior, 'allow',
      'the Bash call after `result` must still reach canUseTool, not be auto-denied');

    const empty = await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 0);
    assert.deepEqual(empty.tasks, []);

    const notice = await c.waitFor((m) => m.type === 'task_notice');
    assert.equal(notice.status, 'completed');
    assert.equal(notice.summary, 'Background agent finished');

    await c.waitFor(() => c.all('result').length >= 2, { timeout: 5000 });
    const results = c.all('result');
    assert.equal(results.length, 2, 'one streamed query legitimately emits a result per turn');
    assert.equal(results.at(-1).background, false);

    // No stall WARN fires while waiting on the background task — the watchdog
    // is exempt in that phase (see run-query.js's runPhase).
    assert.ok(!h.stdout.includes('query quiet'), 'the stall watchdog must not fire during the background phase');
  });

});

describe('a tab reconnecting while a background task is still running', () => {
  let h;
  before(async () => {
    // Only one scripted run, and it never reaches a second `result` — the
    // scenario stays in the background phase for as long as the test needs,
    // rather than racing a second prompt against a run the scenario doesn't have.
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { emit: { type: 'system', subtype: 'background_tasks_changed',
              tasks: [{ task_id: 'bg3', task_type: 'local_agent', description: 'Background subagent' }] } },
            { text: 'spawned' },
            { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, usage } },
            { sleep: 2000 },
          ],
          noResult: true,
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('is told a background task is running, in both history and a replayed background_tasks', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'spawn it', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 1);

    const c2 = await h.connect();
    const hist = await c2.waitFor('history');
    assert.equal(hist.background, true);
    const greeted = await c2.waitFor('background_tasks');
    assert.equal(greeted.tasks.length, 1);
    assert.equal(greeted.tasks[0].id, 'bg3');
  });
});

describe('a prompt sent while a background task is still finishing', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { emit: { type: 'system', subtype: 'background_tasks_changed',
              tasks: [{ task_id: 'bg2', task_type: 'local_bash', description: 'Sleeping command' }] } },
            { text: 'spawned' },
            { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, usage } },
          ],
          noResult: true,
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('is queued into the same run rather than aborting the background task', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'go', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 1);
    await c.waitFor('result');

    c.send({ type: 'prompt', text: 'are you done yet?', permissionMode: 'bypass' });

    // The new prompt is shown locally and queued — not a second `query()` call,
    // which would mean the background task was aborted to start a fresh run.
    await h.waitForRecord((r) => r.kind === 'input' && r.text === 'are you done yet?');
    assert.equal(h.records('query').length, 1, 'the backgrounded run must not be aborted and restarted');
    assert.equal(c.all('aborted').length, 0);
  });
});

describe('a task-notification or handback report arriving live', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { emit: { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content:
              '<task-notification>\n<task-id>bg5</task-id>\n<status>completed</status>\n' +
              '<summary>Background agent finished</summary>\n</task-notification>' } } },
            { emit: { type: 'user', origin: { kind: 'peer', name: 'background agent', body: 'All done here.' },
              message: { role: 'user', content: 'ignored — origin.body is the real text' } } },
            { text: 'noted' },
          ],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('is mapped to task_notice / agent_report, never a raw user bubble', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'go', permissionMode: 'bypass' });

    const notice = await c.waitFor('task_notice');
    assert.equal(notice.taskId, 'bg5');
    assert.equal(notice.status, 'completed');
    assert.equal(notice.summary, 'Background agent finished');

    const report = await c.waitFor('agent_report');
    assert.equal(report.from, 'background agent');
    assert.equal(report.text, 'All done here.');

    // Neither has array content, so without the origin check both would
    // silently vanish (no indicator at all) rather than show up mis-rendered —
    // still worth pinning, since the whole point is that they are now visible.
    assert.equal(c.all('tool_result').length, 0);
  });
});

describe('the stall watchdog', () => {
  // Real STALL_CHECK_MS/STALL_WARN_MS (15s/20s) are too slow to exercise in a
  // test; both are overridable (config.js). The idle measurement itself rounds
  // to whole seconds (see run-query.js's watchdog), so the override still has
  // to clear a 1s floor — hence 1.5s sleeps rather than sub-second ones.
  const env = { STALL_CHECK_MS: '100', STALL_WARN_MS: '500' };

  test('still fires for an ordinary quiet turn (the gate below is not just a timing fluke)', async () => {
    const h = await startServer({
      env, scenario: { runs: [{ steps: [{ sleep: 1500 }, { text: 'done' }] }] },
    });
    try {
      const c = await h.connect();
      await c.waitFor('history');
      c.send({ type: 'prompt', text: 'go', permissionMode: 'bypass' });
      await c.waitFor('result');
      assert.ok(h.stdout.includes('query quiet'), 'a quiet foreground turn should trip the watchdog');
    } finally { await h.stop(); }
  });

  test('does not fire while only a background task is quiet', async () => {
    const h = await startServer({
      env,
      scenario: {
        runs: [{
          steps: [
            { emit: { type: 'system', subtype: 'background_tasks_changed',
              tasks: [{ task_id: 'bg4', task_type: 'local_agent', description: 'Background subagent' }] } },
            { text: 'spawned' },
            { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, usage } },
            { sleep: 1500 },
            { emit: { type: 'system', subtype: 'background_tasks_changed', tasks: [] } },
            { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.02, num_turns: 1, usage } },
          ],
          noResult: true,
        }],
      },
    });
    try {
      const c = await h.connect();
      await c.waitFor('history');
      c.send({ type: 'prompt', text: 'go', permissionMode: 'bypass' });
      await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 1);
      await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 0);
      assert.ok(!h.stdout.includes('query quiet'), 'the background phase must stay exempt from the stall watchdog');
    } finally { await h.stop(); }
  });
});

describe('the turn that follows a background task finishing', () => {
  // The last background task ends after the turn's `result`; the CLI then runs
  // a short follow-up turn for its notification. Closing the input channel at
  // that moment (as the server used to) cut that turn off: its first tool call
  // came back "The user doesn't want to take this action right now".
  function steps({ followUp }) {
    return [
      { emit: { type: 'system', subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg9', task_type: 'local_bash', description: 'Watch CI' }] } },
      { text: 'watching' },
      { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, usage } },
      { sleep: 50 },
      { emit: { type: 'system', subtype: 'background_tasks_changed', tasks: [] } },
      { emit: { type: 'system', subtype: 'task_notification', task_id: 'bg9', status: 'completed', summary: 'CI done' } },
      ...(followUp ? [
        { sleep: 300 },
        { tool: { name: 'Read', input: { file_path: '/tmp/ci.output' }, id: 'fu1', output: 'success' } },
        { text: 'CI is green' },
        { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, usage } },
      ] : []),
    ];
  }

  test('is waited for: the run ends with its result, not before', async () => {
    const h = await startServer({ scenario: { runs: [{ steps: steps({ followUp: true }), noResult: true }] } });
    try {
      const c = await h.connect();
      await c.waitFor('history');
      c.send({ type: 'prompt', text: 'watch it', permissionMode: 'bypass' });
      await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 0);
      const decision = await h.waitForRecord((r) => r.kind === 'tool_decision' && r.tool === 'Read');
      assert.equal(decision.outcome.behavior, 'allow');
      await c.waitFor((m) => m.type === 'text' && /CI is green/.test(m.text));
      await c.waitFor(() => c.all('result').length === 2, { timeout: 5000 });
      assert.equal(c.all('result').length, 2);
      assert.ok(h.stdout.includes('waiting for the follow-up turn'));
      assert.ok(!h.stdout.includes('no follow-up turn'), 'the grace timer must not end a turn that started');
    } finally { await h.stop(); }
  });

  test('when none comes, the run still ends after the grace period', async () => {
    const h = await startServer({
      env: { FOLLOW_UP_GRACE_MS: '400' },
      scenario: { runs: [{ steps: steps({ followUp: false }), noResult: true }] },
    });
    try {
      const c = await h.connect();
      await c.waitFor('history');
      c.send({ type: 'prompt', text: 'watch it', permissionMode: 'bypass' });
      await c.waitFor((m) => m.type === 'background_tasks' && m.tasks.length === 0);
      // (the greeting's own empty `runs` was already received — poll the log instead)
      const t0 = Date.now();
      while (!h.stdout.includes('no follow-up turn after the background task(s); ending run') && Date.now() - t0 < 8000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(h.stdout.includes('no follow-up turn after the background task(s); ending run'));
      const t1 = Date.now();
      while (c.last('runs')?.runs.length !== 0 && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 100));
      assert.equal(c.last('runs').runs.length, 0, 'the run is over');
    } finally { await h.stop(); }
  });
});
