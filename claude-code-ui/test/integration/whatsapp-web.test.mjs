/*
 * WhatsApp through a number linked by QR code (1.8.0): the real server, the
 * scripted SDK and a fake sidecar instead of Baileys. The owner's message is
 * answered, a family member's garage door is put to them as a numbered list
 * and done on "1", and unlinking stops the sidecar.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server-harness.mjs';

const OWNER = '32470123456';
const WIFE = '32470998877';
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'fake-wa-sidecar.mjs');

let h, fakeDir, n = 0;
const outbox = () => (existsSync(path.join(fakeDir, 'outbox.jsonl')) ? readFileSync(path.join(fakeDir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function receive(from, text) {
  n += 1;
  writeFileSync(path.join(fakeDir, 'inbox', `${String(n).padStart(4, '0')}.json`), JSON.stringify({ id: `web${n}`, from, name: 'x', ts: Date.now(), type: 'text', text }));
}
async function post(route, body) {
  const res = await fetch(h.baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function waitOut(pred, label, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const hit = outbox().find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > timeout) throw new Error(`no ${label}; saw ${JSON.stringify(outbox())}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  fakeDir = mkdtempSync(path.join(tmpdir(), 'fake-wa-'));
  mkdirSync(path.join(fakeDir, 'inbox'), { recursive: true });
  h = await startServer({
    env: { WHATSAPP_NODE: process.execPath, WHATSAPP_SIDECAR: FAKE, WA_FAKE_DIR: fakeDir, WHATSAPP_PROGRESS_MS: '600000' },
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
    contacts: [{ number: OWNER, name: 'Soufiane', profile: 'owner', person: 'person.soufiane' }, { number: WIFE, name: 'Maysa', profile: 'family', person: 'person.maysa' }],
  }));
});
after(async () => { await h?.stop(); rmSync(fakeDir, { recursive: true, force: true }); });

describe('WhatsApp linked by QR code', () => {
  test('the sidecar is started and reports the linked number', async () => {
    const r = await post('/api/whatsapp/web/start', {});
    assert.equal(r.json.ok, true);
    assert.equal(r.json.web.available, true);
    const t0 = Date.now();
    let w;
    do { w = (await h.get('/api/whatsapp')).json; } while (w.web.state !== 'open' && Date.now() - t0 < 5000 && await new Promise((ok) => setTimeout(ok, 50, true)));
    assert.equal(w.transport, 'web');
    assert.equal(w.web.state, 'open');
    assert.equal(w.web.me, '32460000000');
    assert.equal(w.maxContacts, 20, 'no test-number limit');
  });

  test('the owner\'s message is answered through the sidecar', async () => {
    receive(OWNER, 'allume le salon');
    const reply = await waitOut((o) => o.op === 'send' && o.to === OWNER, 'owner reply');
    assert.equal(reply.text, 'Le *salon* est allumé.');
    assert.ok(outbox().some((o) => o.op === 'read' && o.msgId === 'web1'), 'marked read');
  });

  test('a family member\'s garage door is a numbered list, done on "1"', async () => {
    receive(WIFE, 'ouvre le garage');
    const ask = await waitOut((o) => o.op === 'send' && o.to === WIFE && /Je peux/.test(o.text), 'the question');
    assert.match(ask.text, /1\. Oui\n2\. Non/);
    receive(WIFE, '1');
    await waitOut((o) => o.op === 'send' && o.to === WIFE && /Garage ouvert/.test(o.text), 'the result');
    const d = h.records('tool_decision');
    assert.equal(d[d.length - 1].outcome.behavior, 'allow');
  });

  test('an unknown number is ignored; unlinking stops it', async () => {
    receive('32499000000', 'coucou');
    await h.waitForLog('unknown number …0000 ignored');
    assert.ok(!outbox().some((o) => o.to === '32499000000'));
    await post('/api/whatsapp/web/logout', {});
    const w = (await h.get('/api/whatsapp')).json;
    assert.equal(w.web.state, 'stopped');
    assert.equal(w.web.linked, false);
  });
});
