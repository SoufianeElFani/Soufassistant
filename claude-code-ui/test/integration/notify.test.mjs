/*
 * Notifications: what the server pushes through Home Assistant, and when it
 * holds back. The push is observed at the (fake) Supervisor, not on the wire.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';
import { startFakeHa } from '../helpers/fake-ha.mjs';

const idle = { emit: { type: 'system', subtype: 'session_state_changed', state: 'idle' } };
const pushes = (ha) => ha.requests.filter((r) => r.route.startsWith('core/api/services/notify/mobile_app_phone'));

async function until(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
}

describe('notifications', () => {
  let ha, h;
  before(async () => {
    ha = await startFakeHa({
      rest: {
        'core/api/services': [{ domain: 'notify', services: { mobile_app_phone: {}, send_message: {} } }],
        'core/api/services/notify/mobile_app_phone': [],
        'core/api/events/claude_code_ui_attention': {},
        'addons/self/info': { data: { slug: 'local_claude-code-ui' } },
      },
    });
    h = await startServer({
      env: { SUPERVISOR_TOKEN: 'tok', HA_SUPERVISOR_URL: ha.supervisorUrl },
      scenario: { runs: [
        { steps: [{ text: 'hi' }, idle] },
        { steps: [{ text: 'hi again' }, idle] },
      ] },
    });
  });
  after(async () => { await h.stop(); await ha.close(); });

  test('the greeting lists notify services', async () => {
    const c = await h.connect();
    const st = await c.waitFor('notify_state');
    assert.deepEqual(st.services, ['mobile_app_phone']);
    assert.equal(st.service, '');
  });

  test('nothing is sent until a service is chosen', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });
    await c.waitFor('result');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pushes(ha).length, 0);
  });

  test('an idle state pushes a reply notification, tagged and linking to the panel', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'set_notify', service: 'mobile_app_phone', onReply: true, onAttention: true });
    await c.waitFor((m) => m.type === 'notify_state' && m.service === 'mobile_app_phone');
    c.send({ type: 'presence', visible: false });
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });
    await c.waitFor('result');
    const push = await until(() => pushes(ha)[0]);
    assert.ok(push, 'a push reached the notify service');
    const body = JSON.parse(push.body);
    assert.equal(body.data.tag, 'claude-code-ui');
    assert.equal(body.data.clickAction, '/hassio/ingress/local_claude-code-ui');
    assert.ok(await until(() => ha.requests.some((r) => r.route === 'core/api/events/claude_code_ui_attention')));
  });

  test('a visible tab suppresses the push', async () => {
    const before = pushes(ha).length;
    await new Promise((r) => setTimeout(r, 10500));   // outlast the per-kind cooldown
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'presence', visible: true });
    c.send({ type: 'prompt', text: 'again', permissionMode: 'bypass' });
    await c.waitFor('result');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pushes(ha).length, before);
  });
});
