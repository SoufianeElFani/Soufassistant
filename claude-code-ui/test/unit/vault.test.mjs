/*
 * Mode Confidentiel (server/lib/vault.js) : pseudonymiser avant l'envoi, rétablir
 * en local, dans le texte comme dans les fichiers ; la garde qui tient l'agent
 * hors du coffre.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'vault-'));
process.env.VAULT_DIR = path.join(tmp, '.coffre-souf');
process.env.DATA_DIR = tmp;
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const V = await import('../../server/lib/vault.js');
const { makeZip, readZip } = await import('../../server/lib/zip.js');

describe('vault', () => {
  test('dictionnaire + motifs : masquer puis rétablir', () => {
    V.addEntity({ real: 'Acme Brewing', kind: 'client', variants: ['ACME'] });
    const t = 'Offre 2026_07-1234 pour Acme Brewing NV (ACME), Mr John SMITH, john.smith@acme.be, +32 475 12 34 56. Equans NV/SA reste Equans.';
    const m = V.mask(t);
    assert.doesNotMatch(m, /Acme|ACME|SMITH|john\.smith|475 12|2026_07-1234/);
    assert.match(m, /Client-A NV/);
    assert.match(m, /Equans NV\/SA reste Equans/, 'Equans est exempté');
    assert.equal(V.reveal(m).replace('(Acme Brewing)', '(ACME)'), t);
  });
  test('noms de fichiers : séparateurs - et _', () => {
    assert.equal(V.mask('2026-11-03_Offre_Acme-Brewing_EN.docx', { learn: false }), '2026-11-03_Offre_Client-A_EN.docx');
  });
  test('Word : un nom coupé entre deux runs, la mise en forme gardée', async () => {
    const doc = '<w:document><w:body><w:p><w:r><w:t>Pour Ac</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>me Brewing</w:t></w:r></w:p></w:body></w:document>';
    const a = path.join(tmp, 'a.docx'), b = path.join(tmp, 'b.docx'), c = path.join(tmp, 'c.docx');
    writeFileSync(a, makeZip([{ name: 'word/document.xml', data: doc }]));
    await V.maskFile(a, b);
    const x = readZip(readFileSync(b))[0].data.toString();
    assert.equal(x.replace(/<[^>]+>/g, ''), 'Pour Client-A');
    await V.revealFile(b, c);
    assert.equal(readZip(readFileSync(c))[0].data.toString().replace(/<[^>]+>/g, ''), 'Pour Acme Brewing');
  });
  test('la garde : chemin du coffre, recherches récursives larges', () => {
    const g = (tool, ti) => V.vaultGuard({ tool_name: tool, tool_input: ti }).hookSpecificOutput?.permissionDecision || 'allow';
    assert.equal(g('Read', { file_path: path.join(process.env.VAULT_DIR, 'coffre.json') }), 'deny');
    assert.equal(g('Bash', { command: 'cat /x/.coffre-souf/coffre.json' }), 'deny');
    assert.equal(g('Bash', { command: `grep -r Acme ${tmp}` }), 'deny');
    assert.equal(g('Grep', { pattern: 'x', path: '/' }), 'deny');
    assert.equal(g('Bash', { command: 'grep -r Acme /config/Claude_Travail' }), 'allow');
    assert.equal(g('Read', { file_path: '/config/configuration.yaml' }), 'allow');
  });
  test('la table pour l\'écran', () => {
    assert.equal(V.revealMap()['Client-A'], 'Acme Brewing');
  });
});
