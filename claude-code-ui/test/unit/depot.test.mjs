/*
 * Le dépôt confidentiel (server/lib/depot.js) : un fichier réel déposé est
 * pseudonymisé sur place, vérifié, puis rangé dans <workspace>/Confidentiel ;
 * s'il reste un nom inconnu, il attend la décision de l'utilisateur.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'depot-'));
process.env.VAULT_DIR = path.join(tmp, 'coffre-test');
process.env.DATA_DIR = tmp;
process.env.DEPOT_STABLE_MS = '0';
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const V = await import('../../server/lib/vault.js');
const D = await import('../../server/lib/depot.js');

const root = path.join(tmp, 'Claude_Travail');
const dir = path.join(tmp, 'Depot_confidentiel');
mkdirSync(root, { recursive: true });
const conf = (...p) => path.join(root, 'Confidentiel', ...p);

describe('dépôt confidentiel', () => {
  test('le dossier est à côté du workspace, hors de lui', () => {
    assert.equal(D.depotDir(root), dir);
  });

  test('un fichier sans nom inconnu : pseudonymisé puis rangé dans Confidentiel', async () => {
    V.addEntity({ real: 'Globex Industries', kind: 'client' });
    mkdirSync(path.join(dir, 'Globex Industries'), { recursive: true });
    writeFileSync(path.join(dir, 'Globex Industries', 'note Globex Industries.md'), 'offre pour Globex Industries, contact jean.dupont@globex.be.\n');
    assert.equal(await D.tick(root), true);
    assert.deepEqual(readdirSync(dir), [], 'nothing left in the drop folder (empty folders pruned)');
    const out = conf('Client-A', 'note Client-A.md');
    assert.ok(existsSync(out), readdirSync(conf()).join('|'));
    const t = readFileSync(out, 'utf8');
    assert.doesNotMatch(t, /Globex|dupont/i);
    assert.match(t, /Client-A/);
    assert.ok(V.protectedRoots(root).includes(conf()));
  });

  test('un nom inconnu : le fichier attend, hors de portée, puis part après la décision', async () => {
    writeFileSync(path.join(dir, 'cr.md'), 'compte rendu : Zorblax Quentrop valide le planning.\n');
    await D.tick(root);
    const st = await D.depotStatus(root);
    const p = st.pending.find((x) => x.rel === 'cr.md');
    assert.ok(p, JSON.stringify(st));
    assert.ok(p.unknown.some((u) => /Zorblax/.test(u.real)), JSON.stringify(p.unknown));
    assert.ok(existsSync(path.join(dir, 'cr.md')), 'still in the drop folder');
    assert.ok(!existsSync(conf('cr.md')));
    // the drop folder is not among the folders strict mode lets the agent read
    // (the test runs under /tmp, which strict mode allows: checked on the roots themselves)
    assert.ok(!V.protectedRoots(root).some((r) => dir === r || dir.startsWith(r + path.sep)));

    const names = p.unknown.map((u) => u.real);
    const res = await D.resolve(root, 'cr.md', { protect: names.filter((n) => /Zorblax/.test(n)).map((real) => ({ real, kind: 'personne' })), ignore: names.filter((n) => !/Zorblax/.test(n)) });
    assert.equal(res.ok, true);
    assert.equal(res.released, true);
    const t = readFileSync(conf('cr.md'), 'utf8');
    assert.doesNotMatch(t, /Zorblax/);
    assert.match(t, /Personne-\d+/);
  });

  test('coffre verrouillé : rien n\'est traité', async () => {
    assert.equal(V.setPassphrase('une phrase de passe').ok, true);
    V.lock();
    writeFileSync(path.join(dir, 'attente.md'), 'texte\n');
    assert.equal(await D.tick(root), false);
    assert.ok(existsSync(path.join(dir, 'attente.md')));
    const st = await D.depotStatus(root);
    assert.equal(st.locked, true);
    assert.equal(st.waiting, 1);
    assert.deepEqual(st.pending, []);
  });
});
