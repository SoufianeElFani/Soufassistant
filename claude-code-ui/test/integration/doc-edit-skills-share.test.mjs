/*
 * 0.9.0 end to end: editing documents over HTTP (/api/doc, /api/workspace-binary)
 * and sharing skills (/api/skills/import, /shared, /import-shared, /share, /bundle).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { startServer } from '../helpers/server-harness.mjs';
import { makeZip, readZip } from '../../server/lib/zip.js';

const json = (res) => res.json();
const post = (h, url, body, type = 'application/json') => fetch(`${h.baseUrl}${url}`, {
  method: 'POST', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body,
}).then(json);

describe('document editing', () => {
  let h, ws;
  before(async () => {
    h = await startServer({});
    ws = path.join(h.dataDir, 'workspace');
    mkdirSync(path.join(ws, 'Docs'), { recursive: true });
    writeFileSync(path.join(ws, 'Docs', 'offre.docx'), makeZip([
      { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>Prix : [à compléter]</w:t></w:r></w:p></w:body></w:document>' },
    ], { deflate: true }));
    writeFileSync(path.join(ws, 'Docs', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  after(async () => { await h.stop(); });

  test('model, save, conflict — and refuse escapes', async () => {
    const m = await fetch(`${h.baseUrl}/api/doc?path=Docs/offre.docx`).then(json);
    assert.equal(m.ok, true);
    assert.equal(m.parts[0].paragraphs[0].text, 'Prix : [à compléter]');
    let r = await post(h, '/api/doc', { path: 'Docs/offre.docx', mtime: m.mtime, edits: [{ part: 'word/document.xml', i: 0, old: 'Prix : [à compléter]', text: 'Prix : 4.675 €/an' }] });
    assert.equal(r.ok, true, r.error);
    const xml = readZip(readFileSync(path.join(ws, 'Docs', 'offre.docx'))).find((e) => e.name === 'word/document.xml').data.toString();
    assert.match(xml, /Prix : 4\.675 €\/an/);
    r = await post(h, '/api/doc', { path: 'Docs/offre.docx', mtime: m.mtime - 60000, edits: [{ part: 'word/document.xml', i: 0, text: 'x' }] });
    assert.equal(r.conflict, true);
    for (const bad of ['../../etc/passwd', '.hidden/x.docx']) {
      const res = await fetch(`${h.baseUrl}/api/doc?path=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, bad);
    }
  });

  test('binary save: images only, mtime checked', async () => {
    let r = await post(h, '/api/workspace-binary?path=Docs/pic.png', Buffer.from('new image'), 'application/octet-stream');
    assert.equal(r.ok, true, r.error);
    assert.equal(readFileSync(path.join(ws, 'Docs', 'pic.png'), 'utf8'), 'new image');
    r = await post(h, '/api/workspace-binary?path=Docs/pic.png&mtime=5', Buffer.from('x'), 'application/octet-stream');
    assert.equal(r.conflict, true);
    r = await post(h, '/api/workspace-binary?path=Docs/x.html', Buffer.from('<script>'), 'application/octet-stream');
    assert.equal(r.ok, false);
    r = await post(h, '/api/workspace-binary?path=Docs/pic.png&create=1', Buffer.from('x'), 'application/octet-stream');
    assert.equal(r.ok, false, 'create does not overwrite');
  });
});

describe('sharing skills', () => {
  let h;
  const md = (n) => `---\nname: ${n}\ndescription: Use for ${n}\n---\n\nSteps`;
  before(async () => { h = await startServer({}); });
  after(async () => { await h.stop(); });

  test('import a bundle, share to the workspace, list and reinstall from there, export all', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    let r = await post(h, '/api/skills/import', makeZip([{ name: 'a/SKILL.md', data: md('a') }, { name: 'b/SKILL.md', data: md('b') }]), 'application/octet-stream');
    assert.deepEqual(r.installed, ['a', 'b']);
    const sk = await c.waitFor((m) => m.type === 'skills' && m.skills.some((s) => s.name === 'b'));
    assert.ok(sk);
    r = await post(h, '/api/skills/share', {});
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dir, 'Skills');
    assert.deepEqual(r.written.sort(), ['Skills/a.zip', 'Skills/b.zip']);
    const shared = await fetch(`${h.baseUrl}/api/skills/shared`).then(json);
    assert.deepEqual(shared.files.map((f) => f.name).sort(), ['a.zip', 'b.zip']);
    r = await post(h, '/api/skills/import-shared', { path: 'Skills/a.zip' });
    assert.deepEqual(r.skipped, [{ name: 'a', reason: 'already installed' }]);
    r = await post(h, '/api/skills/import-shared', { path: 'Skills/a.zip', replace: true });
    assert.deepEqual(r.installed, ['a']);
    r = await post(h, '/api/skills/import-shared', { path: '../home/x.zip' });
    assert.equal(r.ok, false);
    const bundle = Buffer.from(await (await fetch(`${h.baseUrl}/api/skills/bundle`)).arrayBuffer());
    assert.deepEqual(readZip(bundle).map((e) => e.name).sort(), ['a/SKILL.md', 'b/SKILL.md']);
    assert.equal(existsSync(path.join(h.home, '.claude', 'skills', 'a', 'SKILL.md')), true);
  });
});
