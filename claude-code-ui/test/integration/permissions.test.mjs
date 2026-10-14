/*
 * Permission modes. The behaviour that matters is not "does a prompt appear" but
 * what the SDK is ultimately told — so most assertions read the decision the
 * stub recorded, not just the wire message.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

const bashTool = (extra = {}) => ({ name: 'Bash', input: { command: 'ls' }, id: 'tool-bash', ...extra });

describe('ask mode', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [{
            tool: bashTool({
              title: 'Run a command',
              description: 'ls',
              suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }],
            }),
          }],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('prompts, and an allow reaches the SDK as allow', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'list files', permissionMode: 'ask' });

    const req = await c.waitFor('permission_request');
    assert.equal(req.toolName, 'Bash');
    assert.deepEqual(req.input, { command: 'ls' });
    assert.equal(req.title, 'Run a command');
    assert.equal(req.canAlways, true);
    assert.equal(req.alwaysLabel, 'Bash(ls:*)', 'the Always button says what it will remember');

    c.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    await c.waitFor('result');

    const decision = h.records('tool_decision').at(-1);
    assert.equal(decision.outcome.behavior, 'allow');
    assert.equal(decision.outcome.updatedPermissions, undefined, 'a plain allow does not persist a rule');
  });
});

describe('the Always button', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [{
            tool: bashTool({ suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }] }),
          }],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('hands the suggested rule back so the decision sticks to the tool', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'list files', permissionMode: 'ask' });
    const req = await c.waitFor('permission_request');
    c.send({ type: 'permission_response', id: req.id, decision: 'always' });
    await c.waitFor('result');

    const outcome = h.records('tool_decision').at(-1).outcome;
    assert.equal(outcome.behavior, 'allow');
    assert.equal(outcome.updatedPermissions.length, 1);
  });
});

describe('denying', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('is reported to the model, and the transcript marks it as a real failure', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'list files', permissionMode: 'ask' });
    const req = await c.waitFor('permission_request');
    c.send({ type: 'permission_response', id: req.id, decision: 'deny' });

    const res = await c.waitFor('tool_result');
    assert.equal(res.isError, true);
    assert.equal(res.answered, false, 'a denial is not an answered question');
    assert.match(h.records('tool_decision').at(-1).outcome.message, /Denied by user/);
  });
});

describe('acceptEdits mode', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { tool: { name: 'Write', input: { file_path: '/config/x.yaml' }, id: 'w' } },
            { tool: bashTool() },
          ],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('auto-approves file edits and still prompts for everything else', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'edit and run', permissionMode: 'acceptEdits' });

    const req = await c.waitFor('permission_request');
    assert.equal(req.toolName, 'Bash', 'the Write went through without asking');
    c.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    await c.waitFor('result');

    const decisions = h.records('tool_decision');
    assert.equal(decisions[0].outcome.behavior, 'allow');
    assert.equal(c.all('permission_request').length, 1);
  });
});

describe('plan mode', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { tool: { name: 'Read', input: { file_path: '/config/a' }, id: 'r' } },
            { tool: { name: 'ExitPlanMode', input: { plan: 'do the thing' }, id: 'x' } },
          ],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('runs read-only tools silently and only asks to leave plan mode', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'plan it', permissionMode: 'plan' });

    const req = await c.waitFor('permission_request');
    assert.equal(req.toolName, 'ExitPlanMode');
    c.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    await c.waitFor('result');

    assert.equal(h.records('query').at(-1).options.permissionMode, 'plan',
      'plan is SDK-native, so the SDK must also be told');
    assert.equal(c.all('permission_request').length, 1);
  });
});

describe('auto mode', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('hands approval to the SDK classifier and never prompts', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'auto' });
    await c.waitFor('result');

    const q = h.records('query').at(-1);
    assert.equal(q.options.permissionMode, 'auto');
    assert.equal(q.options.hasCanUseTool, false, 'auto mode has no canUseTool at all');
    assert.equal(c.all('permission_request').length, 0);
  });
});

describe('switching mode mid-prompt', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('to bypass resolves the prompt already on screen', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'ask' });
    const req = await c.waitFor('permission_request');

    c.send({ type: 'set_perm_mode', mode: 'bypass' });
    const resolved = await c.waitFor('permission_resolved');
    assert.equal(resolved.id, req.id, 'the UI is told to dismiss that exact card');

    await c.waitFor('result');
    assert.equal(h.records('tool_decision').at(-1).outcome.behavior, 'allow');
  });
});

describe('the browser going away mid-prompt', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('leaves the permission pending — a later tab is shown it and can still answer', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'ask' });
    const req = await c.waitFor('permission_request');
    await c.close();

    // The prompt belongs to the run, not to the tab that asked it — a new tab
    // connecting afterwards is replayed the exact same request on greet().
    const c2 = await h.connect();
    const replayed = await c2.waitFor('permission_request');
    assert.equal(replayed.id, req.id);
    assert.equal(replayed.toolName, 'Bash');

    c2.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    const decision = await h.waitForRecord((r) => r.kind === 'tool_decision');
    assert.equal(decision.outcome.behavior, 'allow');
  });
});

describe('two tabs open on the same prompt', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('answering on one dismisses it on the other', async () => {
    const a = await h.connect();
    const b = await h.connect();
    await Promise.all([a.waitFor('history'), b.waitFor('history')]);
    a.send({ type: 'prompt', text: 'do it', permissionMode: 'ask' });

    const req = await a.waitFor('permission_request');
    await b.waitFor('permission_request');   // broadcast, not sent only to `a`

    a.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    const resolved = await b.waitFor('permission_resolved');
    assert.equal(resolved.id, req.id);
  });
});

describe('two tool calls needing permission at once', () => {
  let h;
  before(async () => {
    // A single assistant turn making two tool calls together — the SDK does
    // not wait for one's canUseTool to resolve before the other's starts (see
    // stub-sdk.mjs's concurrentTools), the same as a main agent and a
    // background subagent each asking independently.
    h = await startServer({
      scenario: {
        runs: [{
          steps: [{ concurrentTools: [
            bashTool({ id: 'tool-a', input: { command: 'one' } }),
            bashTool({ id: 'tool-b', input: { command: 'two' } }),
          ] }],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('both reach the wire as independent requests, and both get answered', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do both', permissionMode: 'ask' });

    // permission_request's own `id` is a server-generated UUID for the prompt,
    // not the tool_use block's id — match on the input each was raised for.
    await c.waitFor(() => c.all('permission_request').length === 2);
    const [reqA, reqB] = c.all('permission_request');
    assert.notEqual(reqA.id, reqB.id, 'two independent prompts, not one reused');

    c.send({ type: 'permission_response', id: reqA.id, decision: reqA.input.command === 'one' ? 'allow' : 'deny' });
    c.send({ type: 'permission_response', id: reqB.id, decision: reqB.input.command === 'one' ? 'allow' : 'deny' });

    const decisionA = await h.waitForRecord((r) => r.kind === 'tool_decision' && r.id === 'tool-a');
    const decisionB = await h.waitForRecord((r) => r.kind === 'tool_decision' && r.id === 'tool-b');
    assert.equal(decisionA.outcome.behavior, 'allow');
    assert.equal(decisionB.outcome.behavior, 'deny');
  });
});

describe('a tool prompt with nobody connected at all', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: { runs: [{ steps: [{ sleep: 400 }, { tool: bashTool() }] }] },
    });
  });
  after(async () => { await h.stop(); });

  test('waits — it is not denied just because nobody is connected yet', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'ask' });
    await h.waitForRecord((r) => r.kind === 'query');
    await c.close();

    // Nobody was connected at the moment the SDK asked — broadcasting to zero
    // clients is a no-op, so the prompt just sits in pendingPermissions. A tab
    // that connects later is shown it and can answer it, exactly like an
    // AskUserQuestion with nobody around to ask.
    const c2 = await h.connect();
    const req = await c2.waitFor('permission_request');
    assert.equal(req.toolName, 'Bash');

    c2.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    const decision = await h.waitForRecord((r) => r.kind === 'tool_decision');
    assert.equal(decision.outcome.behavior, 'allow');
  });
});
