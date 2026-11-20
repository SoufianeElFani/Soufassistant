/*
 * WhatsApp end to end (1.7.0): the real server, a fake Graph API, the scripted
 * SDK. Meta's webhook check, the signature gate, an owner's message answered,
 * a family member's sensitive action put to them as Oui / Non buttons and run
 * once they press Oui, and an unknown number ignored.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server-harness.mjs';

const SECRET = 'b'.repeat(32);
const OWNER = '32470123456';
const WIFE = '32470998877';
const PHONE_ID = '1112223334';

let h, graph, graphUrl;
const sent = [];   // bodies POSTed to /<phone>/messages

function signedPost(body, { secret = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${h.baseUrl}/whatsapp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
}
const message = (from, m) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: from, profile: { name: 'x' } }], messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...m }] } }] }] });
async function waitSent(pred, label, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const hit = sent.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > timeout) throw new Error(`no ${label} sent; saw ${JSON.stringify(sent.map((s) => s.type || s.status))}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  graph = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.url === `/${PHONE_ID}/messages`) { try { sent.push(JSON.parse(b)); } catch {} }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }));
    });
  });
  await new Promise((r) => graph.listen(0, '127.0.0.1', r));
  graphUrl = `http://127.0.0.1:${graph.address().port}`;
  h = await startServer({
    env: { WHATSAPP_GRAPH_URL: graphUrl, WHATSAPP_PROGRESS_MS: '600000' },
    scenario: {
      runs: [
        { steps: [{ tool: { name: 'Bash', input: { command: 'ha-tools call light turn_on \'{"entity_id": "light.salon"}\'' } } }, { text: 'Le **salon** est allumé.' }] },
        { steps: [{ tool: { name: 'Bash', input: { command: 'ha-tools call cover open_cover \'{"entity_id": "cover.garage_porte_de_garage"}\'' } } }, { text: 'Garage ouvert.' }] },
      ],
    },
  });
  const dir = path.join(h.dataDir, 'connectors');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'whatsapp.json'), JSON.stringify({
    phoneNumberId: PHONE_ID, accessToken: 'EAAGtest', appSecret: SECRET, verifyToken: 'verify-me',
    contacts: [{ number: OWNER, name: 'Soufiane', profile: 'owner', person: 'person.soufiane' }, { number: WIFE, name: 'Maysa', profile: 'family', person: 'person.maysa' }],
  }));
});
after(async () => { await h?.stop(); graph?.close(); });

describe('WhatsApp webhook', () => {
  test('Meta\'s verification echoes the challenge only with the right token', async () => {
    const ok = await h.get('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242');
    assert.equal(ok.status, 200);
    assert.equal(ok.text, '4242');
    assert.equal((await h.get('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
  });

  test('an unsigned or wrongly signed call is refused', async () => {
    assert.equal((await signedPost(message(OWNER, { id: 'w0', type: 'text', text: { body: 'hi' } }), { secret: 'c'.repeat(32) })).status, 403);
    const res = await fetch(`${h.baseUrl}/whatsapp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
  });

  test('the owner\'s message is answered in WhatsApp syntax, with the full assistant', async () => {
    const res = await signedPost(message(OWNER, { id: 'w1', type: 'text', text: { body: 'allume le salon' } }));
    assert.equal(res.status, 200);
    const reply = await waitSent((s) => s.type === 'text' && s.to === OWNER, 'owner reply');
    assert.equal(reply.text.body, 'Le *salon* est allumé.');
    const q = h.records('query').find((r) => r.prompt === 'allume le salon');
    assert.ok(q, 'a run started with the message as its prompt');
    assert.match(q.options.systemPromptText, /talking with Soufiane/);
    assert.equal(q.options.settingSources, null, 'the owner keeps CLAUDE.md, memory and skills');
    const d = h.records('tool_decision').find((r) => r.tool === 'Bash');
    assert.equal(d.outcome.behavior, 'allow', 'an ordinary light is switched without asking');
    assert.ok(sent.some((s) => s.status === 'read'), 'the message was marked read');
  });

  test('a family member\'s garage door is asked first, then done on Oui', async () => {
    await signedPost(message(WIFE, { id: 'w2', type: 'text', text: { body: 'ouvre le garage' } }));
    const ask = await waitSent((s) => s.type === 'interactive' && s.to === WIFE, 'Oui / Non buttons');
    assert.match(ask.interactive.body.text, /cover\.open_cover → cover\.garage_porte_de_garage/);
    const yes = ask.interactive.action.buttons.find((b) => b.reply.title === 'Oui');
    const q = h.records('query').find((r) => r.prompt === 'ouvre le garage');
    assert.deepEqual(q.options.settingSources, [], 'family runs without the owner\'s instructions and memory');
    assert.match(q.options.systemPromptText, /Household profile/);
    assert.equal(q.options.settings.autoMemoryEnabled, true);
    assert.match(q.options.settings.autoMemoryDirectory, /whatsapp-memory\/32470998877$/);
    await signedPost(message(WIFE, { id: 'w3', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: yes.reply.id, title: 'Oui' } } }));
    const done = await waitSent((s) => s.type === 'text' && s.to === WIFE && /Garage ouvert/.test(s.text.body), 'the result');
    assert.ok(done);
    const decisions = h.records('tool_decision');
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1].outcome.behavior, 'allow', 'the call ran once Oui was pressed');
  });

  test('a message replayed by Meta is handled once; an unknown number is ignored', async () => {
    const before = h.records('query').length;
    await signedPost(message(OWNER, { id: 'w1', type: 'text', text: { body: 'allume le salon' } }));
    await signedPost(message('32499000000', { id: 'w9', type: 'text', text: { body: 'coucou' } }));
    await h.waitForLog('unknown number …0000 ignored');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.records('query').length, before);
    assert.ok(!sent.some((s) => s.to === '32499000000'));
  });

  test('Hub › WhatsApp shows the state without any secret', async () => {
    const r = await h.get('/api/whatsapp');
    assert.equal(r.json.configured, true);
    assert.equal(r.json.contacts.length, 2);
    assert.ok(r.json.contacts.find((c) => c.number === WIFE).lastInboundAt, 'when she last wrote is known');
    assert.ok(!r.text.includes('EAAGtest') && !r.text.includes(SECRET));
  });
});
