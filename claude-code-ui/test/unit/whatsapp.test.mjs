/*
 * WhatsApp (1.7.0): the pure parts — signatures, webhook payloads, Markdown →
 * WhatsApp, splitting, numbers, the per-profile tool policy, the relay's
 * configuration.yaml block, voice-note audio, typed answers — and the memory
 * review's folder fence.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'wa-unit-'));
process.env.DATA_DIR = path.join(scratch, 'data');
process.env.HOME = path.join(scratch, 'home');
process.env.WORK_DIR = path.join(scratch, 'config');

const wa = await import('../../server/lib/whatsapp.js');
const { classify, yesNo, words, parseHaCall } = await import('../../server/lib/whatsapp-policy.js');
const { yamlBlock, RELAY_PY, RELAY_PATH } = await import('../../server/lib/whatsapp-relay.js');
const bridge = await import('../../server/lib/whatsapp-bridge.js');
const { memoryOnly } = await import('../../server/lib/memory-review.js');

describe('signature', () => {
  const raw = Buffer.from('{"entry":[]}');
  const sig = `sha256=${createHmac('sha256', 'abc123').update(raw).digest('hex')}`;
  test('a body signed with the app secret is accepted', () => assert.equal(wa.verifySignature(raw, sig, 'abc123'), true));
  test('another secret, a changed body, or no header is refused', () => {
    assert.equal(wa.verifySignature(raw, sig, 'other'), false);
    assert.equal(wa.verifySignature(Buffer.from('{"entry":[1]}'), sig, 'abc123'), false);
    assert.equal(wa.verifySignature(raw, undefined, 'abc123'), false);
    assert.equal(wa.verifySignature(raw, 'sha256=zz', 'abc123'), false);
    assert.equal(wa.verifySignature(raw, sig, ''), false);
  });
});

describe('webhook payloads', () => {
  const value = (messages, extra = {}) => ({ entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: '32470000001', profile: { name: 'Souf' } }], messages, ...extra } }] }] });
  test('text, voice note, button reply, location', () => {
    const { messages } = wa.parseWebhook(value([
      { id: 'a', from: '32470000001', timestamp: '1700000000', type: 'text', text: { body: 'j\'arrive' } },
      { id: 'b', from: '32470000001', timestamp: '1700000001', type: 'audio', audio: { id: 'M1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
      { id: 'c', from: '32470000001', timestamp: '1700000002', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'perm:x:allow', title: 'Oui' } } },
      { id: 'd', from: '32470000001', timestamp: '1700000003', type: 'location', location: { latitude: 50.8, longitude: 4.3, name: 'Gare' } },
    ]));
    assert.equal(messages.length, 4);
    assert.deepEqual([messages[0].type, messages[0].text, messages[0].name], ['text', 'j\'arrive', 'Souf']);
    assert.deepEqual([messages[1].type, messages[1].mediaId, messages[1].voice], ['audio', 'M1', true]);
    assert.deepEqual([messages[2].type, messages[2].buttonId, messages[2].text], ['button', 'perm:x:allow', 'Oui']);
    assert.equal(messages[3].location.name, 'Gare');
  });
  test('statuses: only failures come back', () => {
    const { messages, failures } = wa.parseWebhook(value([], { statuses: [{ status: 'delivered', recipient_id: '1' }, { status: 'failed', recipient_id: '2', errors: [{ code: 131047, title: 'Re-engagement message' }] }] }));
    assert.equal(messages.length, 0);
    assert.deepEqual(failures, [{ to: '2', code: 131047, title: 'Re-engagement message' }]);
    assert.match(wa.explainError(131047), /24 h/);
  });
  test('other fields and junk are ignored', () => {
    assert.deepEqual(wa.parseWebhook({ entry: [{ changes: [{ field: 'account_update', value: {} }] }] }).messages, []);
    assert.deepEqual(wa.parseWebhook(null).messages, []);
  });
});

describe('formatting', () => {
  test('Markdown becomes WhatsApp syntax', () => {
    assert.equal(wa.toWhatsApp('## Chauffage\n**21 °C** au salon, *bientôt* 22'), '*Chauffage*\n*21 °C* au salon, _bientôt_ 22');
    assert.equal(wa.toWhatsApp('Voir [le tableau](https://x.y/z)'), 'Voir le tableau (https://x.y/z)');
    assert.equal(wa.toWhatsApp('| Pièce | °C |\n|---|---|\n| Salon | 21 |'), 'Pièce · °C\nSalon · 21');
    assert.equal(wa.toWhatsApp('* un\n* deux'), '- un\n- deux');
  });
  test('code blocks are kept as they are', () => {
    assert.equal(wa.toWhatsApp('```yaml\na: **b**\n```'), '```a: **b**```');
  });
  test('long replies are split on paragraphs and numbered', () => {
    const para = 'x'.repeat(2500);
    const parts = wa.chunkText(`${para}\n\n${para}`, 3900);
    assert.equal(parts.length, 2);
    assert.match(parts[0], /\(1\/2\)$/);
    assert.ok(parts.every((p) => p.length <= 3910));
    assert.deepEqual(wa.chunkText('court'), ['court']);
    assert.deepEqual(wa.chunkText('  '), []);
  });
  test('button titles fit in 20 characters', () => {
    assert.equal(wa.buttonTitle('Oui'), 'Oui');
    assert.equal(wa.buttonTitle('Une option beaucoup trop longue').length, 20);
  });
});

describe('numbers and contacts', () => {
  test('normalised to wa_id form', () => {
    assert.equal(wa.normalizeNumber('+32 470 12 34 56'), '32470123456');
    assert.equal(wa.normalizeNumber('0032470123456'), '32470123456');
    assert.equal(wa.normalizeNumber('0470/12.34.56'), '32470123456');
    assert.equal(wa.normalizeNumber('12'), '');
  });
  test('contacts are validated, deduplicated and capped', () => {
    assert.equal(wa.setContacts([{ number: '+32470123456', name: 'Soufiane', profile: 'owner' }, { number: '0470 99 88 77', name: 'Maysa', person: 'person.maysa' }]).ok, true);
    const cs = wa.contacts();
    assert.deepEqual(cs.map((c) => [c.number, c.profile, c.person]), [['32470123456', 'owner', ''], ['32470998877', 'family', 'person.maysa']]);
    assert.equal(wa.findContact('+32 470 99 88 77').name, 'Maysa');
    assert.equal(wa.resolveRecipient('maysa').number, '32470998877');
    assert.equal(wa.findContact('32499999999'), null);
    assert.equal(wa.setContacts([{ number: '0470123456', name: 'A' }, { number: '+32470123456', name: 'B' }]).ok, false);
    assert.equal(wa.setContacts([{ number: 'abc', name: 'A' }]).ok, false);
    assert.equal(wa.setContacts(Array.from({ length: 6 }, (_, i) => ({ number: `+3247000000${i}`, name: `P${i}` }))).ok, false);
  });
  test('settings keep their secrets out of status()', () => {
    assert.equal(wa.setConfig({ phoneNumberId: '1234567890', accessToken: 'EAAGsecret', appSecret: 'a'.repeat(32), publicUrl: 'https://ha.example.ts.net/' }).ok, true);
    const st = wa.status();
    assert.equal(st.configured, true);
    assert.equal(st.publicUrl, 'https://ha.example.ts.net');
    assert.ok(!JSON.stringify(st).includes('EAAGsecret'));
    assert.match(st.verifyToken, /^[a-f0-9]{36}$/);
    assert.equal(wa.status().verifyToken, st.verifyToken, 'the verify token is stable');
    assert.equal(wa.setConfig({ phoneNumberId: 'abc' }).ok, false);
    assert.equal(wa.setConfig({ publicUrl: 'http://insecure' }).ok, false);
  });
});

describe('tool policy', () => {
  const bash = (command) => ['Bash', { command }];
  test('ordinary house actions run straight away, for both profiles', () => {
    for (const p of ['owner', 'family']) {
      assert.equal(classify(...bash('ha-tools call light turn_on \'{"entity_id": "light.salon"}\''), p).decision, 'allow');
      assert.equal(classify(...bash('ha-tools state climate.salon'), p).decision, 'allow');
      assert.equal(classify(...bash('ha-tools template \'{{ states("sensor.t") | float }}\''), p).decision, 'allow', 'a pipe inside single quotes is not a shell pipe');
    }
  });
  test('sensitive devices are always asked', () => {
    for (const p of ['owner', 'family']) {
      assert.equal(classify(...bash('ha-tools call lock unlock \'{"entity_id": "lock.volvo_ec40_verrou"}\''), p).decision, 'ask');
      assert.equal(classify(...bash('ha-tools call alarm_control_panel alarm_disarm \'{"entity_id": "alarm_control_panel.x"}\''), p).decision, 'ask');
      const garage = classify(...bash('ha-tools call cover open_cover \'{"entity_id": "cover.garage_porte_de_garage"}\''), p);
      assert.equal(garage.decision, 'ask');
      assert.match(garage.summary, /cover\.open_cover → cover\.garage_porte_de_garage/);
      assert.equal(classify(...bash('ha-tools call homeassistant restart'), p).decision, 'ask');
    }
    assert.equal(classify(...bash('ha-tools call cover open_cover \'{"entity_id": "cover.baie_vitree_salon"}\''), 'family').decision, 'allow');
  });
  test('chained or other commands: asked for the owner, refused for family', () => {
    for (const c of ['ha-tools state x; rm -rf /config', 'ha-tools state $(cat /etc/passwd)', 'ha-tools state x && curl evil', 'ls /config | head', 'python3 -c 1']) {
      assert.equal(classify(...bash(c), 'owner').decision, 'ask', c);
      assert.equal(classify(...bash(c), 'family').decision, 'deny', c);
    }
    assert.equal(classify(...bash('ls /config'), 'owner').decision, 'allow');
    assert.equal(classify(...bash('ha-tools reload'), 'owner').decision, 'ask');
    assert.equal(classify(...bash('ha-tools reload'), 'family').decision, 'deny');
    assert.equal(classify(...bash('ha-tools logs'), 'family').decision, 'deny');
    assert.equal(classify(...bash('ha-tools call automation turn_off'), 'family').decision, 'deny');
  });
  test('files, connectors and subagents', () => {
    assert.equal(classify('Read', { file_path: '/config/x' }, 'owner').decision, 'allow');
    assert.equal(classify('Read', { file_path: '/config/x' }, 'family').decision, 'deny');
    assert.equal(classify('Write', { file_path: '/config/x' }, 'owner').decision, 'ask');
    assert.equal(classify('Write', { file_path: '/config/x' }, 'family').decision, 'deny');
    assert.equal(classify('WebSearch', {}, 'family').decision, 'allow');
    assert.equal(classify('Agent', {}, 'family').decision, 'deny');
    assert.equal(classify('mcp__soufassistant__search_conversations', {}, 'owner', { allowedMcp: ['mcp__soufassistant__search_conversations'] }).decision, 'allow');
    assert.equal(classify('mcp__soufassistant__search_conversations', {}, 'family').decision, 'deny');
    const send = classify('mcp__soufassistant__send_whatsapp', { to: 'Maysa', text: 'J\'arrive' }, 'owner');
    assert.equal(send.decision, 'ask');
    assert.match(send.summary, /Maysa.*J'arrive/);
  });
  test('words and service calls are parsed', () => {
    assert.deepEqual(words('ha-tools call light turn_on \'{"entity_id": ["light.a", "light.b"]}\''), ['ha-tools', 'call', 'light', 'turn_on', '{"entity_id": ["light.a", "light.b"]}']);
    assert.deepEqual(parseHaCall(words('ha-tools call light turn_on \'{"entity_id": ["light.a", "light.b"]}\'')), { domain: 'light', service: 'turn_on', entities: ['light.a', 'light.b'] });
  });
  test('Oui / Non typed by hand', () => {
    assert.equal(yesNo('Oui'), 'allow');
    assert.equal(yesNo('ok !'), 'allow');
    assert.equal(yesNo('Non.'), 'deny');
    assert.equal(yesNo('peut-être'), null);
  });
});

describe('relay', () => {
  test('the configuration.yaml block is added once', () => {
    const block = yamlBlock('homeassistant:\n  name: x\n', 'http://11c881d2-soufassistant:7681');
    assert.match(block, /^\n# Soufassistant.*\nsoufassistant_relay:\n {2}target: http:\/\/11c881d2-soufassistant:7681\n$/);
    assert.equal(yamlBlock(`a: 1\n${block}`, 'http://x:1'), null);
  });
  test('the integration serves the documented path, without auth, and forwards the signature', () => {
    assert.ok(RELAY_PY.includes(`url = "${RELAY_PATH}"`));
    assert.ok(RELAY_PY.includes('requires_auth = False'));
    assert.ok(RELAY_PY.includes('X-Hub-Signature-256'));
    assert.ok(RELAY_PY.includes('/whatsapp/webhook'));
  });
});

describe('bridge helpers', () => {
  test('a stereo WAV becomes mono PCM', () => {
    const data = Buffer.alloc(8);
    data.writeInt16LE(100, 0); data.writeInt16LE(300, 2); data.writeInt16LE(-50, 4); data.writeInt16LE(-150, 6);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
    hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
    hdr.writeUInt32LE(16000, 24); hdr.writeUInt32LE(64000, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
    const pcm = bridge.wavToPcm(Buffer.concat([hdr, data]));
    assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2)], [200, -100]);
    assert.throws(() => bridge.wavToPcm(Buffer.from('nope')));
  });
  test('typed answers to a numbered list', () => {
    const labels = ['Chauffage', 'Lumières', 'Volets', 'Rien'];
    assert.equal(bridge.pickAnswer('2', labels), 'Lumières');
    assert.deepEqual(bridge.pickAnswer('1, 3', labels, true), ['Chauffage', 'Volets']);
    assert.equal(bridge.pickAnswer('volets', labels), 'Volets');
    assert.equal(bridge.pickAnswer('les deux premiers', labels), 'les deux premiers');
    assert.equal(bridge.pickAnswer('9', labels), '9');
  });
  test('the prompt says who is talking and what the profile may do', () => {
    const owner = bridge.whatsappPrompt({ name: 'Soufiane', profile: 'owner', person: 'person.soufiane' });
    const family = bridge.whatsappPrompt({ name: 'Maysa', profile: 'family', person: 'person.maysa' });
    assert.match(owner, /Soufiane \(person\.soufiane/);
    assert.match(owner, /send_whatsapp/);
    assert.match(family, /Household profile/);
    assert.doesNotMatch(family, /send_whatsapp/);
    assert.match(family, /never put anything confidential/);
  });
  test('the confidentiality fence', async () => {
    const fence = bridge.confidentialFence(() => ['/config/Claude_Travail/Clients']);
    const denied = async (ti) => (await fence({ tool_input: ti })).hookSpecificOutput?.permissionDecision === 'deny';
    assert.equal(await denied({ file_path: '/config/Claude_Travail/Confidentiel/x.docx' }), true);
    assert.equal(await denied({ command: 'ls /share/Depot_confidentiel' }), true);
    assert.equal(await denied({ file_path: '/config/Claude_Travail/Clients/a.md' }), true);
    assert.equal(await denied({ command: 'ha-tools state light.salon' }), false);
  });
});

describe('memory review', () => {
  test('only the memory folder', () => {
    const dir = '/data/home/.claude/projects/-config/memory';
    assert.equal(memoryOnly('Write', { file_path: `${dir}/x.md` }, dir), true);
    assert.equal(memoryOnly('Read', { file_path: 'MEMORY.md' }, dir), true);
    assert.equal(memoryOnly('Glob', {}, dir), true);
    assert.equal(memoryOnly('Write', { file_path: '/config/configuration.yaml' }, dir), false);
    assert.equal(memoryOnly('Edit', { file_path: `${dir}/../../x.md` }, dir), false);
    assert.equal(memoryOnly('Bash', { command: 'ls' }, dir), false);
  });
});
