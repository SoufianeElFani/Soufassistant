/*
 * 0.3.0: Chat / Code / Cowork modes, the configurable workspace (projects),
 * and the Skills panel — end to end through the real server and the SDK stub.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { startServer } from '../helpers/server-harness.mjs';

const lastQuery = (h) => h.records('query').at(-1).options;

describe('modes', () => {
  let h, projectAbs;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [
          { steps: [{ text: 'chat reply' }] },                                  // 1 chat
          { steps: [{ text: 'code reply' }] },                                  // 2 code
          { steps: [                                                            // 3 cowork
            { hook: { tool_name: 'Write', tool_input: { file_path: '/config/configuration.yaml' } } },
            { text: 'cowork reply' },
          ] },
        ],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('chat runs with web tools (and questions) only, no plugins or setting sources, and its own system prompt', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hi', permissionMode: 'bypass', mode: 'chat' });
    await c.waitFor('result');
    const o = lastQuery(h);
    assert.deepEqual(o.tools, ['WebSearch', 'WebFetch', 'AskUserQuestion']);
    assert.deepEqual(o.plugins, []);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.systemPrompt, 'custom');
    const modes = await c.waitFor((m) => m.type === 'session_modes' && Object.values(m.modes).some((x) => x.mode === 'chat'));
    assert.ok(modes);
  });

  test('code keeps the full agent: no tool restriction, plugins loaded, preset prompt + workspace note', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hi', permissionMode: 'bypass', mode: 'code' });
    await c.waitFor('result');
    const o = lastQuery(h);
    assert.equal(o.tools, null);
    assert.ok(o.plugins.length >= 2);
    assert.equal(o.systemPrompt, 'preset+append');
  });

  test('cowork without a project is refused, without running anything', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    const before = h.records('query').length;
    c.send({ type: 'prompt', text: 'build', permissionMode: 'bypass', mode: 'cowork', project: 'Nope' });
    const err = await c.waitFor('error');
    assert.match(err.message, /project/i);
    assert.equal(h.records('query').length, before);
  });

  test('cowork in a project: extra dir, and writes outside it are denied in bypass mode too', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'workspace_create_project', name: 'Demo App', activate: true });
    const r = await c.waitFor('workspace_result');
    assert.equal(r.ok, true);
    const st = await c.waitFor((m) => m.type === 'workspace_state' && m.state.projects.some((p) => p.name === 'Demo App'));
    projectAbs = path.join(st.state.root, 'Demo App');
    assert.equal(st.state.activeProject, 'Demo App');

    c.send({ type: 'prompt', text: 'build', permissionMode: 'bypass', mode: 'cowork', project: 'Demo App' });
    await c.waitFor('result');
    const o = lastQuery(h);
    assert.deepEqual(o.additionalDirectories, [projectAbs]);
    const hooks = h.records('hook');
    const outside = hooks.find((x) => x.tool === 'Write' && x.result.denied);
    assert.ok(outside, 'the /config write was denied');
    assert.match(outside.result.reason, /Cowork mode/);
  });
});

describe('workspace + skills over the socket', () => {
  let h;
  before(async () => { h = await startServer({}); });
  after(async () => { await h.stop(); });

  test('a connecting tab gets the workspace state and the session modes', async () => {
    const c = await h.connect();
    const st = await c.waitFor('workspace_state');
    assert.ok(st.state.root);
    assert.ok(Array.isArray(st.state.projects));
    await c.waitFor('session_modes');
  });

  test('a root outside the allowed mounts is refused', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'workspace_set_root', path: '/etc/evil' });
    const r = await c.waitFor('workspace_result');
    assert.equal(r.ok, false);
  });

  test('skills_list answers with a listing; an unknown export is a 404', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'skills_list' });
    const s = await c.waitFor('skills');
    assert.ok(Array.isArray(s.skills));
    const res = await fetch(`${h.baseUrl}/api/skills/export?id=nope`);
    assert.equal(res.status, 404);
  });
});
