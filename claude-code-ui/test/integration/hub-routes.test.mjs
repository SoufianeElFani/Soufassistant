/*
 * The Hub's routes (server/lib/hub-routes.js) end to end: memory, agents,
 * project knowledge upload, connectors status, shared links (conversation and
 * file), published apps — static and a real server process behind the proxy.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';

const SID = '11111111-2222-3333-4444-555555555555';

describe('hub routes', () => {
  let h, ws, shareDir;
  const get = (u) => fetch(`${h.baseUrl}${u}`).then((r) => r.json());
  const post = (u, b, type = 'application/json') => fetch(`${h.baseUrl}${u}`, { method: 'POST', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(b) : b }).then((r) => r.json());
  before(async () => {
    h = await startServer({ sessions: { [SID]: [userLine('Bonjour <script>x</script>'), assistantLine([{ type: 'text', text: 'Salut **toi**' }])] } });
    ws = path.join(h.dataDir, 'workspace');
    shareDir = path.join(h.root, 'www', 'soufassistant-share');
    mkdirSync(path.join(ws, 'Demo'), { recursive: true });
    writeFileSync(path.join(ws, 'Demo', 'index.html'), '<h1>Demo</h1>');
  });
  after(async () => { await post('/api/apps/unpublish', { slug: 'api-demo' }).catch(() => {}); await h.stop(); });

  test('memory and agents', async () => {
    let r = await post('/api/memory', { title: 'Langue', description: 'Répondre en français', type: 'feedback', body: 'Toujours en français.' });
    assert.equal(r.ok, true);
    const m = await get('/api/memory');
    assert.equal(m.facts[0].title, 'Langue');
    r = await post('/api/agents', { name: 'Testeur', instructions: 'Teste tout.' });
    assert.equal(r.ok, true);
    assert.ok((await get('/api/agents')).agents.some((a) => a.name === 'Testeur'));
  });

  test('project knowledge upload and listing', async () => {
    let r = await post('/api/projects/Demo/knowledge?file=ref.txt', Buffer.from('référence'), 'application/octet-stream');
    assert.equal(r.ok, true);
    r = await post('/api/projects/Demo/instructions', { instructions: 'Sois bref.' });
    const k = await get('/api/projects/Demo/knowledge');
    assert.equal(k.instructions.trim(), 'Sois bref.');
    assert.deepEqual(k.files.map((f) => f.name), ['ref.txt']);
    assert.equal((await get('/api/projects/Nope/knowledge')).ok, false);
  });

  test('connectors status', async () => {
    const c = await get('/api/connectors');
    assert.equal(c.google.connected, false);
    assert.equal(typeof c.browser, 'boolean');
  });

  test('share a conversation: escaped, under the HA www folder; revoke', async () => {
    const r = await post('/api/shares/conversation', { id: SID });
    assert.equal(r.ok, true, r.error);
    const file = path.join(h.dataDir, '..', 'work', 'www', 'soufassistant-share', r.share.token, 'index.html');
    const html = readFileSync(existsSync(file) ? file : path.join(h.workDir, 'www', 'soufassistant-share', r.share.token, 'index.html'), 'utf8');
    assert.match(html, /<strong>toi<\/strong>/);
    assert.doesNotMatch(html, /<script>x/);
    assert.equal((await post('/api/shares/revoke', { token: r.share.token })).ok, true);
    assert.equal((await post('/api/shares/file', { path: '../../etc/passwd' })).ok, false);
  });

  test('published apps: static, and a server process behind the proxy', async () => {
    let r = await post('/api/apps', { project: 'Demo', name: 'Demo statique', kind: 'static' });
    assert.equal(r.ok, true, r.error);
    let res = await fetch(`${h.baseUrl}/apps/demo-statique/`);
    assert.equal(await res.text(), '<h1>Demo</h1>');
    assert.match(res.headers.get('content-security-policy'), /^sandbox allow-scripts/);
    r = await post('/api/apps', { project: 'Demo', name: 'API demo', kind: 'server', command: 'exec python3 -m http.server "$PORT" --bind 127.0.0.1' });
    assert.equal(r.ok, true, r.error);
    let text = '';
    for (let i = 0; i < 40 && !text.includes('Demo'); i++) {
      await new Promise((ok) => setTimeout(ok, 250));
      res = await fetch(`${h.baseUrl}/apps/api-demo/index.html`);
      text = await res.text();
    }
    assert.equal(text, '<h1>Demo</h1>');
    const list = (await get('/api/apps')).apps;
    assert.ok(list.find((a) => a.slug === 'api-demo').running);
    assert.equal((await post('/api/apps/unpublish', { slug: 'api-demo' })).ok, true);
    assert.equal((await fetch(`${h.baseUrl}/apps/api-demo/`)).status, 404);
    assert.equal((await post('/api/apps', { project: 'Nope', name: 'x' })).ok, false);
  });
});
