/*
 * The pre-send screening of 1.5.9: lowercase words no dictionary of the message's
 * language knows (a client written « fortis »), the people of an e-mail (headers,
 * greeting, signature), and the passages touching GDPR or business confidentiality.
 * The dictionary tests need the word lists (in the app's image; skipped elsewhere).
 */
import { register } from 'node:module';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'screen-'));
process.env.VAULT_DIR = path.join(tmp, 'coffre');
process.env.DATA_DIR = tmp;
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const V = await import('../../server/lib/vault.js');
const L = await import('../../server/lib/lexicon.js');
const { sensitivePassages } = await import('../../server/lib/sensitive.js');
const dicts = existsSync('/usr/share/dict/french') && existsSync('/usr/share/dict/american-english');
const skip = dicts ? false : 'word lists absent';
const names = (t) => V.suspects(t).unknown.map((x) => x.real);

describe('lowercase names (dictionaries)', { skip }, () => {
  before(async () => { await L.ready(); });
  test('a client in lowercase in a French sentence is flagged; French and English words are not', () => {
    const n = names('Le client travaille pour fortis et pour engie, la réunion de maintenance préventive est demain.');
    assert.ok(n.includes('fortis') && n.includes('engie'), n.join('|'));
    assert.ok(!n.some((w) => /client|travaille|réunion|maintenance|préventive|demain/.test(w)), n.join('|'));
  });
  test('the language of the message chooses the lists (a Latin word known in Dutch is still flagged in French)', () => {
    assert.deepEqual(L.languages('le client est pour nous et vous'), ['fr', 'en']);
    assert.equal(L.isWord('fortis', ['fr', 'en']), false);
  });
  test('accents, elisions, code and links are not flagged', () => {
    const n = names("La reunion de l'entreprise : voir `npm run build` et https://exemple.org/xyzzy");
    assert.deepEqual(n.filter((w) => /reunion|entreprise|npm|xyzzy/.test(w)), []);
  });
  test('« Ne plus signaler » and the vault apply to lowercase words too', () => {
    V.addIgnored(['scada']);
    V.addEntity({ real: 'fortis', kind: 'client' });
    const n = names('le scada de fortis');
    assert.ok(!n.includes('scada') && !n.includes('fortis'), n.join('|'));
  });
});

describe('the people of an e-mail', () => {
  test('headers, greeting and signature, even when the name is a common word', () => {
    const mail = 'De : Jean Martin <jean.martin@globex.example>\nÀ : Sophie Leroy; Paul\nObjet : relance\n\nBonjour Marc,\nMerci pour ton retour.\nCordialement,\nLéa Dubois\n';
    const n = names(mail);
    for (const x of ['Jean Martin', 'Sophie Leroy', 'Paul', 'Marc', 'Léa Dubois']) assert.ok(n.includes(x), `${x} in ${n.join('|')}`);
    assert.ok(!n.includes('Merci') && !n.includes('Cordialement'));
    assert.ok(!names('Comme convenu, suite à notre échange.').includes('Comme'));
  });
});

describe('sensitive passages', () => {
  test('health, HR, special categories, identifiers, addresses, business, amounts, security', () => {
    const t = [
      'Marc est en arrêt maladie depuis lundi.',
      'Son salaire passe à 4 000 € brut.',
      'Elle est déléguée syndicale.',
      'Son numéro de registre national est 85.07.30-033.61.',
      'Il habite au 12 rue des Lilas, 1000 Bruxelles.',
      'Notre marge sur ce contrat est de 18 %.',
      'Le mot de passe du serveur est dans le mail.',
      'La réunion est jeudi à 10 h.',
    ].join(' ');
    const p = sensitivePassages(t);
    const cats = (s) => p.find((x) => x.text.startsWith(s))?.cats || [];
    assert.ok(cats('Marc est').includes('sante'));
    assert.ok(cats('Son salaire').includes('rh') && cats('Son salaire').includes('montant'));
    assert.ok(cats('Elle est').includes('particulier'));
    assert.ok(cats('Son numéro').includes('identite'));
    assert.ok(cats('Il habite').includes('adresse'));
    assert.ok(cats('Notre marge').includes('entreprise'));
    assert.ok(cats('Le mot de passe').includes('securite'));
    assert.equal(cats('La réunion').length, 0, 'an ordinary sentence is not flagged');
    const m = p.find((x) => x.text.startsWith('Marc est'));
    assert.equal(t.slice(m.start, m.end), m.text, 'offsets point at the sentence');
    assert.equal(m.mention, '[information de santé masquée]');
  });
});
