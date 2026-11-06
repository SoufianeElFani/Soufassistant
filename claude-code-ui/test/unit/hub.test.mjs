/*
 * 1.0.0 modules, the pure parts and file round trips: memory (memory.js),
 * agents (agents.js), project knowledge (knowledge.js), shared links
 * (shares.js — script-free pages), Google helpers (google.js), app slugs.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hub-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.FRONTEND_DIR = path.resolve('frontend');
process.env.SHARE_DIR = path.join(tmp, 'www', 'share');
mkdirSync(process.env.DATA_DIR, { recursive: true });
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const memory = await import('../../server/lib/memory.js');
const agents = await import('../../server/lib/agents.js');
const knowledge = await import('../../server/lib/knowledge.js');
const shares = await import('../../server/lib/shares.js');
const google = await import('../../server/lib/google.js');
const { appSlug } = await import('../../server/lib/apps.js');
const { makeZip } = await import('../../server/lib/zip.js');

describe('memory', () => {
  test('index parsing and upserting', () => {
    const idx = '- [A](a.md) — first\n- [B](b.md) — second\n';
    assert.deepEqual(memory.parseIndex(idx).map((x) => [x.title, x.file, x.hook]), [['A', 'a.md', 'first'], ['B', 'b.md', 'second']]);
    assert.equal(memory.upsertIndexLine(idx, { title: 'B2', file: 'b.md', hook: 'new' }), '- [A](a.md) — first\n- [B2](b.md) — new\n');
    assert.match(memory.upsertIndexLine(idx, { title: 'C', file: 'c.md', hook: 'x' }), /- \[C\]\(c\.md\) — x\n$/);
    assert.equal(memory.removeIndexLines(idx, ['a.md']), '- [B](b.md) — second\n');
  });
  test('save, list, dangling, clean, delete', () => {
    const dir = path.join(tmp, 'mem');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'MEMORY.md'), '- [Ghost](ghost.md) — gone\n');
    assert.equal(memory.saveFact({ title: 'Présentations', description: 'Arial, footer', type: 'feedback', body: 'Use Arial.' }, dir).ok, true);
    let m = memory.listMemory(dir);
    assert.equal(m.facts.length, 1);
    assert.equal(m.facts[0].type, 'feedback');
    assert.equal(m.facts[0].indexed, true);
    assert.deepEqual(m.dangling, ['ghost.md']);
    assert.equal(memory.saveFact({ title: 'Présentations', description: 'dup', type: 'user', body: 'x' }, dir).ok, false, 'no silent overwrite');
    memory.cleanDangling(dir);
    assert.deepEqual(memory.listMemory(dir).dangling, []);
    memory.deleteFact(m.facts[0].file, dir);
    m = memory.listMemory(dir);
    assert.equal(m.facts.length, 0);
    assert.equal(readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim(), '');
    assert.equal(memory.deleteFact('../x.md', dir).ok, false);
  });
});

describe('agents', () => {
  test('seeded, validated, saved, remembered per conversation, prompt and skill allow-list', () => {
    agents.reset();
    assert.ok(agents.listAgents().length >= 2);
    assert.equal(agents.cleanAgent({ name: '', instructions: 'x' }).error, 'A name is required.');
    const r = agents.saveAgent({ name: 'Veilleur', icon: '📰', instructions: 'Fais la veille.', mode: 'bogus', effort: 'high', skills: ['livrables-drive'] });
    assert.equal(r.ok, true);
    const a = agents.getAgent(r.id);
    assert.equal(a.mode, '');
    assert.equal(agents.setSessionAgent('s1', r.id), true);
    assert.equal(agents.agentFor('s1').name, 'Veilleur');
    assert.match(agents.agentPrompt(a), /You are the agent "Veilleur"[\s\S]*Fais la veille\./);
    const o = agents.agentSkillOverrides(a, [{ name: 'livrables-drive' }, { name: 'deck-equans', invocation: 'deck-equans' }]);
    assert.deepEqual(o, { 'deck-equans': 'off' });
    agents.reset();
    assert.equal(agents.agentFor('s1').name, 'Veilleur', 'persisted');
    assert.equal(agents.deleteAgent(r.id).ok, true);
    assert.equal(agents.agentFor('s1'), null);
  });
});

describe('project knowledge', () => {
  test('instructions, files, listing prompt, inline text from docx and text', async () => {
    const dir = path.join(tmp, 'Projet');
    mkdirSync(dir);
    assert.equal(await knowledge.knowledgePrompt('Projet', dir), '');
    knowledge.saveInstructions(dir, 'Ton formel. Toujours en néerlandais.');
    knowledge.addKnowledge(dir, 'tarifs.md', Buffer.from('# Tarifs\n115 €/h'));
    knowledge.addKnowledge(dir, 'offre.docx', makeZip([{ name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>Contrat de service SCADA</w:t></w:r></w:p></w:body></w:document>' }]));
    assert.equal(knowledge.addKnowledge(dir, '.secret', Buffer.from('x')).ok, false);
    const listed = await knowledge.knowledgePrompt('Projet', dir);
    assert.match(listed, /Ton formel/);
    assert.match(listed, /Knowledge\/offre\.docx/);
    assert.doesNotMatch(listed, /115 €/);
    const inline = await knowledge.knowledgePrompt('Projet', dir, { inline: true });
    assert.match(inline, /115 €\/h/);
    assert.match(inline, /Contrat de service SCADA/);
    const cut = await knowledge.knowledgePrompt('Projet', dir, { inline: true, budget: 10 });
    assert.match(cut, /cut|not included/);
    assert.equal(knowledge.removeKnowledge(dir, '../PROJECT.md').ok, false);
    assert.equal(knowledge.removeKnowledge(dir, 'tarifs.md').ok, true);
    assert.equal(existsSync(path.join(dir, 'Knowledge', 'tarifs.md')), false);
  });
});

describe('shared links', () => {
  test('markdown is rendered without any script or unsafe link', () => {
    const html = shares.renderMarkdownSafe('# T\nHi <img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.b)\n\n<script>alert(2)</script>');
    assert.doesNotMatch(html, /<script|<img src=x|javascript:/i);
    assert.match(html, /href="https:\/\/a\.b"/);
    assert.match(shares.pageHtml('t', '<p>x</p>'), /Content-Security-Policy/);
  });
  test('a file share wraps HTML in a sandboxed frame; revoke deletes it', async () => {
    const f = path.join(tmp, 'page.html');
    writeFileSync(f, '<script>alert(1)</script><h1>demo</h1>');
    const r = await shares.shareFile(f, 'page.html');
    assert.equal(r.ok, true);
    const index = readFileSync(path.join(process.env.SHARE_DIR, r.share.token, 'index.html'), 'utf8');
    assert.match(index, /<iframe class="frame" sandbox="allow-scripts allow-forms allow-popups" srcdoc="&lt;script&gt;/);
    assert.doesNotMatch(index, /allow-same-origin/);
    assert.match(r.share.url, /\/local\/share\/[\w-]{32}\/$/);
    assert.equal((await shares.listShares()).length, 1);
    shares.revokeShare(r.share.token);
    assert.equal(existsSync(path.join(process.env.SHARE_DIR, r.share.token)), false);
    assert.equal((await shares.listShares()).length, 0);
  });
});

describe('google helpers', () => {
  test('code from the pasted address; message text; raw message', () => {
    assert.equal(google.codeFrom('http://127.0.0.1:53682/?state=x&code=4/0AbC-d_e&scope=y'), '4/0AbC-d_e');
    assert.equal(google.codeFrom('nonsense url'), null);
    const b64 = (s) => Buffer.from(s).toString('base64url');
    assert.equal(google.messageText({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi<br>there</p>') } }, { mimeType: 'text/plain', body: { data: b64('Hi there') } }] }), 'Hi there');
    assert.match(google.messageText({ mimeType: 'text/html', body: { data: b64('<style>x</style><p>Bonjour</p>') } }), /^Bonjour/);
    const raw = Buffer.from(google.rawMessage({ to: 'a@b.c', subject: 'Réunion', body: 'Texte' }), 'base64url').toString();
    assert.match(raw, /^To: a@b\.c\r\nSubject: =\?UTF-8\?B\?/);
  });
  test('client setup refuses junk; status hides secrets', () => {
    assert.equal(google.setClient({ client_id: 'x', client_secret: 'y' }).ok, false);
    assert.equal(google.setClient({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'sec' }).ok, true);
    const st = google.googleStatus();
    assert.deepEqual([st.configured, st.connected], [true, false]);
    assert.ok(!JSON.stringify(st).includes('sec'));
    assert.match(google.authUrl().url, /access_type=offline.*gmail\.modify|gmail\.modify.*access_type=offline/);
  });
});

describe('apps', () => {
  test('slugs', () => {
    assert.equal(appSlug('Démo Énergie 2027!'), 'demo-energie-2027');
    assert.equal(appSlug('   '), null);
  });
});
