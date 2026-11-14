/*
 * The pre-send check (vault.js suspects): the first word of a sentence or a line
 * counts like any other (a list of client names, one per line, used to slip
 * through), sentence starters are not asked about, and a protected name with
 * more capitalised words around it is proposed whole, as a name of its own.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'suspects-'));
process.env.VAULT_DIR = path.join(tmp, 'coffre');
process.env.DATA_DIR = tmp;
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const V = await import('../../server/lib/vault.js');
const names = (t) => V.suspects(t).unknown.map((x) => x.real);

describe('pre-send check', () => {
  test('a list, one name per line: every line is flagged', () => {
    assert.deepEqual(names('Mes clients sont :\nGlobex\nInitech\nUmbrella Corp'), ['Globex', 'Initech', 'Umbrella Corp']);
  });

  test('a name first in a sentence is flagged; a sentence starter is not', () => {
    assert.deepEqual(names('Globex signe demain. Prépare la relance. Bonjour, merci. Peux-tu regarder ?'), ['Globex']);
    assert.deepEqual(names('Prépare Initech pour lundi'), ['Initech'], 'the starter is dropped, the name kept');
    assert.deepEqual(names('Merci\nCordialement\nOui'), []);
    assert.deepEqual(names('Offre pour Globex. Projet Phoenix.'), ['Globex', 'Phoenix'], 'common business nouns are not asked about');
  });

  test('marks and apostrophes: one name', () => {
    // « Livraison » opening the sentence is asked about on its own (once: then « Ne plus signaler »)
    assert.deepEqual(names("Livraison de L'Oréal et HyperWind"), ['Livraison', "L'Oréal", 'HyperWind']);
    assert.deepEqual(names('Umbrella Corp\nJean Dupont'), ['Umbrella Corp', 'Jean Dupont'], 'a name on its own line stays whole');
  });

  test('a protected name with more words around it: the group, as a new name of the same kind', () => {
    V.addEntity({ real: 'Acme', kind: 'client' });
    const u = V.suspects('Contrat Acme Service pour Acme et Acme. Puis Groupe Acme Belgium.').unknown;
    const svc = u.find((x) => x.real === 'Acme Service');
    assert.ok(svc, JSON.stringify(u));
    assert.equal(svc.kind, 'client');
    assert.equal(svc.group, 'Client-A');
    assert.ok(u.some((x) => x.real === 'Groupe Acme Belgium'));
    assert.ok(!u.some((x) => x.real === 'Acme'), 'the protected name alone is not asked again');
    // once added, the group gets its own pseudonym and masks before the shorter name
    V.addEntity({ real: 'Acme Service', kind: 'client' });
    assert.equal(V.mask('Acme Service et Acme', { learn: false }), 'Client-B et Client-A');
    assert.ok(!names('Acme Service et Acme').length);
  });

  test('« Ne plus signaler » and exemptions still apply, at the start too', () => {
    V.addIgnored(['Globex']);
    assert.deepEqual(names('Globex\nEquans'), []);
  });
});
