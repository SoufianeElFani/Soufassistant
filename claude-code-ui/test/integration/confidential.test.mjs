/*
 * Mode Confidentiel de bout en bout : le message arrive pseudonymisé au modèle,
 * la table de démasquage va au navigateur, le coffre est refusé à l'agent,
 * l'anonymisation d'un dossier et la version réelle d'un livrable.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { startServer } from '../helpers/server-harness.mjs';

describe('confidential mode', () => {
  let h, ws;
  before(async () => {
    h = await startServer({ scenario: { runs: [
      { steps: [{ text: 'Ok' }] },
      { steps: [{ tool: { name: 'Bash', input: { command: 'cat /data/.coffre-souf/coffre.json' }, id: 'v' } }, { text: 'done' }] },
      { steps: [{ tool: { name: 'Read', input: { file_path: '/config/configuration.yaml' }, id: 's1' } }, { tool: { name: 'WebFetch', input: { url: 'https://example.com' }, id: 's2' } }, { text: 'done' }] },
    ] } });
    ws = path.join(h.dataDir, 'workspace');
    mkdirSync(path.join(ws, 'Travail', 'Offre_Zeta-Corp'), { recursive: true });
    writeFileSync(path.join(ws, 'Travail', 'Offre_Zeta-Corp', 'note.md'), '# Zeta Corp SA\nContact : Mme Alice MARTIN, alice@zeta.example');
  });
  after(async () => { await h.stop(); });

  test('message pseudonymisé, table envoyée, coffre refusé', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'Prépare une offre pour Zeta Corp SA, contact Mme Alice MARTIN (alice@zeta.example).', mode: 'code', confidential: true, permissionMode: 'bypass' });
    const map = await c.waitFor((m) => m.type === 'vault_map' && Object.values(m.map).includes('Zeta Corp'));
    assert.ok(map);
    await c.waitFor((m) => m.type === 'result' || m.type === 'done');
    const q = h.records('query').at(-1);
    assert.doesNotMatch(q.prompt, /Zeta|Alice|MARTIN|alice@/);
    assert.match(q.prompt, /Client-A SA/);
    assert.match(q.options.systemPromptText, /Confidential mode/);
    c.messages.length = 0;
    c.send({ type: 'prompt', text: 'lis le coffre', mode: 'code', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'result' || m.type === 'done');
    const hook = h.records('tool_decision').at(-1) || h.records('hook').at(-1);
    assert.ok(JSON.stringify(h.records('tool_decision').concat(h.records('hook'))).includes('deny'), 'vault access denied');
  });

  test('anonymiser un dossier, puis particulariser', async () => {
    const post = (u, b) => fetch(`${h.baseUrl}${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const dry = await post('/api/vault/anonymize', { rel: 'Travail', dryRun: true });
    assert.equal(dry.report.fichiers, 1);
    const r = await post('/api/vault/anonymize', { rel: 'Travail' });
    assert.equal(r.report.anonymises, 1);
    assert.equal(existsSync(path.join(ws, 'Travail', 'Offre_Zeta-Corp')), false, 'the real name left the file names');
    const dir = readdirSync(path.join(ws, 'Travail'))[0];
    assert.match(dir, /^Offre_Client-A$/);
    const txt = readFileSync(path.join(ws, 'Travail', dir, 'note.md'), 'utf8');
    assert.doesNotMatch(txt, /Zeta|Alice|alice@/);
    const p = await post('/api/vault/particularize', { path: `Travail/${dir}/note.md` });
    assert.equal(p.ok, true);
    const real = await (await fetch(`${h.baseUrl}/api/vault/reel?id=${encodeURIComponent(p.reels[0].id)}`)).text();
    assert.match(real, /Zeta Corp SA/);
  });

  test('mode strict : avec le bouclier, lecture hors des dossiers anonymisés et web refusés', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'new_session' });
    c.send({ type: 'prompt', text: 'lis la config', mode: 'code', confidential: true, permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'result' || m.type === 'done');
    const d = h.records('tool_decision');
    for (const id of ['s1', 's2']) {
      const x = d.find((r) => r.id === id);
      assert.equal(x?.outcome.behavior, 'deny', id);
      assert.match(x.outcome.message, /strict/);
    }
    assert.match(h.records('query').at(-1).options.systemPromptText, /Strict mode is on/);
  });

  test('coffre chiffré et verrouillé : rien n\'est envoyé, puis déverrouillage', async () => {
    const post = (u, b) => fetch(`${h.baseUrl}${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    assert.equal((await post('/api/vault/passphrase', { pass: 'phrase de test' })).ok, true);
    assert.equal((await post('/api/vault/lock', {})).ok, true);
    const v = await (await fetch(`${h.baseUrl}/api/vault`)).json();
    assert.equal(v.locked, true);
    assert.deepEqual(v.entities, []);
    const c = await h.connect();
    const st = await c.waitFor('vault_status');
    assert.equal(st.locked, true);
    const queries = h.records('query').length;
    c.send({ type: 'prompt', text: 'Offre pour Zeta Corp SA', mode: 'code', confidential: true, permissionMode: 'bypass' });
    const l = await c.waitFor('vault_locked');
    assert.equal(l.text, 'Offre pour Zeta Corp SA');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.records('query').length, queries, 'nothing reached the model');
    assert.equal((await post('/api/vault/preview', { text: 'x' })).locked, true);
    assert.equal((await post('/api/vault/unlock', { pass: 'faux' })).ok, false);
    assert.equal((await post('/api/vault/unlock', { pass: 'phrase de test' })).ok, true);
    const pv = await post('/api/vault/preview', { text: 'Offre pour Zeta Corp et Globex Industries' });
    assert.deepEqual(pv.unknown.map((x) => x.real), ['Globex Industries']);
    const vdir = readdirSync(h.dataDir).find((n) => n.startsWith('.coffre'));
    const files = readdirSync(path.join(h.dataDir, vdir));
    assert.ok(files.includes('coffre.enc') && !files.includes('coffre.json'));
  });
});
