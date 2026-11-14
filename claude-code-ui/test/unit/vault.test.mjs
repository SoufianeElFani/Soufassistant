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
  test('nos pseudonymes ne sont jamais appris comme de vrais noms', () => {
    const n = V.listEntities().length;
    V.mask('Mr Personne-01 et Client-A NV, tél. +32\n400 00 00 03, contact02@exemple.invalid, REF-0004');
    assert.equal(V.listEntities().length, n);
    assert.equal(V.addEntity({ real: 'Personne-', kind: 'personne' }), null);
    assert.equal(V.mask('une personne habilitée', { learn: false }), 'une personne habilitée');
  });
  test('Office : texte alternatif des images, métadonnées JPEG', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08]), Buffer.from('Acme!!'), Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])]);
    assert.ok(!V.stripJpeg(jpeg).includes(Buffer.from('Acme')));
    assert.deepEqual([...V.stripJpeg(jpeg).subarray(-4)], [0x11, 0x22, 0xff, 0xd9]);
    const slide = '<p:sld><p:pic><p:nvPicPr><p:cNvPr id="2" name="Logo Acme Brewing" descr="Acme Brewing logo"/></p:nvPicPr></p:pic><p:sp><p:txBody><a:p><a:r><a:t>Hi</a:t></a:r></a:p></p:txBody></p:sp></p:sld>';
    const a = path.join(tmp, 's.pptx'), b = path.join(tmp, 's2.pptx');
    writeFileSync(a, makeZip([{ name: 'ppt/slides/slide1.xml', data: slide }, { name: 'ppt/media/image1.jpeg', data: jpeg }]));
    await V.maskFile(a, b);
    const all = readZip(readFileSync(b)).map((e) => e.data.toString('latin1')).join(' ');
    assert.doesNotMatch(all, /Acme/);
    assert.match(all, /descr="Client-A logo"/);
  });
  test('anonymiser deux fois ne refait rien (les originaux du coffre restent intacts)', async () => {
    const root = path.join(tmp, 'ws');
    const { mkdirSync } = await import('fs');
    mkdirSync(path.join(root, 'T'), { recursive: true });
    writeFileSync(path.join(root, 'T', 'note.md'), 'Acme Brewing à Gent');
    const r1 = await V.anonymizeTree(root, 'T');
    assert.equal(r1.anonymises, 1);
    const orig = readFileSync(path.join(process.env.VAULT_DIR, 'originaux', 'T', 'note.md'), 'utf8');
    const r2 = await V.anonymizeTree(root, 'T');
    assert.equal(r2.anonymises, 0);
    assert.equal(r2.deja_faits, 1);
    assert.equal(readFileSync(path.join(process.env.VAULT_DIR, 'originaux', 'T', 'note.md'), 'utf8'), orig);
    assert.equal(orig, 'Acme Brewing à Gent');
  });
  test('la table pour l\'écran', () => {
    assert.equal(V.revealMap()['Client-A'], 'Acme Brewing');
  });
  test('la garde : l\'API du coffre, et « du » dans une phrase n\'est pas la commande du', () => {
    const g = (tool, ti) => V.vaultGuard({ tool_name: tool, tool_input: ti }).hookSpecificOutput?.permissionDecision || 'allow';
    assert.equal(g('Bash', { command: 'curl -s http://127.0.0.1:8099/api/vault' }), 'deny');
    assert.equal(g('Bash', { command: `cd /data/dev && python x.py "le texte du message" ${tmp}/y` }), 'allow');
    assert.equal(g('Bash', { command: `ls && du -sh ${tmp}` }), 'deny');
  });
});

describe('vault — alerte avant envoi', () => {
  test('noms inconnus signalés, connus / exemptés / débuts de phrase ignorés', () => {
    const r = V.suspects('Prépare la relance pour Acme Brewing et Globex Industries, avec Jean Dupont. Equans signe. Merci à KUL et à Claude.');
    const names = r.unknown.map((x) => x.real);
    assert.ok(names.includes('Globex Industries'), names.join('|'));
    assert.ok(names.includes('Jean Dupont'));
    assert.ok(names.includes('KUL'));
    assert.ok(!names.some((n) => /Acme|Prépare|Equans|Claude|Merci/.test(n)), names.join('|'));
    assert.equal(r.unknown.find((x) => x.real === 'Jean Dupont').kind, 'personne');
    assert.equal(r.unknown.find((x) => x.real === 'Globex Industries').kind, 'client');
    V.addIgnored(['KUL']);
    assert.ok(!V.suspects('Voir KUL demain').unknown.some((x) => x.real === 'KUL'));
  });
});

describe('vault — mode strict', () => {
  const ws = path.join(tmp, 'ws');
  const G = V.strictGuard(() => [path.join(ws, 'T')], '/config');
  const g = async (tool, ti) => (await G({ tool_name: tool, tool_input: ti })).hookSpecificOutput?.permissionDecision || 'allow';
  test('lecture : seulement les dossiers anonymisés et /tmp', async () => {
    assert.equal(await g('Read', { file_path: path.join(ws, 'T', 'note.md') }), 'allow');
    assert.equal(await g('Read', { file_path: '/tmp/x.txt' }), 'allow');
    assert.equal(await g('Read', { file_path: '/config/automations.yaml' }), 'deny');
    assert.equal(await g('Read', { file_path: 'automations.yaml' }), 'deny', 'relative = cwd /config');
    assert.equal(await g('Grep', { pattern: 'x' }), 'deny', 'no path = cwd');
    assert.equal(await g('Glob', { pattern: '/config/**/*.yaml' }), 'deny');
    assert.equal(await g('Write', { file_path: '/config/out.md', content: 'x' }), 'allow', 'writing leaks nothing');
  });
  test('web, connecteurs, navigateur refusés ; image permise', async () => {
    assert.equal(await g('WebFetch', { url: 'https://x' }), 'deny');
    assert.equal(await g('WebSearch', { query: 'x' }), 'deny');
    assert.equal(await g('mcp__google__gmail_search', {}), 'deny');
    assert.equal(await g('mcp__soufassistant__browser_open', {}), 'deny');
    assert.equal(await g('mcp__soufassistant__generate_image', {}), 'allow');
    assert.equal(await g('TodoWrite', {}), 'allow');
  });
  test('Bash : placé d\'office dans le dossier de travail, pas de réseau ni de chemin ailleurs', async () => {
    const T = path.join(ws, 'T');
    const run = async (command) => (await G({ tool_name: 'Bash', tool_input: { command, description: 'd' } })).hookSpecificOutput;
    assert.equal(await g('Bash', { command: `cd "${T}" && /data/tools/pyenv/bin/python build.py` }), 'allow');
    assert.equal(await run(`cd "${T}" && ls`), undefined, 'already in place: unchanged');
    assert.equal(await g('Bash', { command: `cd "${T}" && ls -la /tmp && cat /usr/share/dict/x` }), 'allow');
    // no cd: run in the first allowed folder, the rest of the input kept
    const o = await run('ls && cat note.md');
    assert.equal(o.permissionDecision, undefined);
    assert.equal(o.updatedInput.command, `cd ${JSON.stringify(T)} && ls && cat note.md`);
    assert.equal(o.updatedInput.description, 'd');
    assert.equal((await run('cd sous-dossier && ls')).updatedInput.command, `cd ${JSON.stringify(T)} && cd sous-dossier && ls`);
    assert.equal(await g('Bash', { command: 'cd /config && cat automations.yaml' }), 'deny');
    assert.equal(await g('Bash', { command: 'cat /config/secrets.yaml' }), 'deny');
    assert.equal(await g('Bash', { command: `cd "${T}" && cat /config/secrets.yaml` }), 'deny');
    assert.equal(await g('Bash', { command: `cd "${T}" && cat ../../x` }), 'deny');
    assert.equal(await g('Bash', { command: `cd "${T}" && cat ~/.claude/x` }), 'deny');
    assert.equal(await g('Bash', { command: `cd "${T}" && curl https://x` }), 'deny');
    assert.equal(await g('Bash', { command: `cd "${T}" && ha-tools state sun.sun` }), 'deny');
    assert.equal(await g('Bash', { command: `cd "${T}" && cd /config && ls` }), 'deny');
    for (const c of ['cd - && cat secrets.yaml', 'cd && ls', `cd "${T}"; cd; ls`, 'popd && ls', 'pushd /config']) assert.equal(await g('Bash', { command: c }), 'deny', c);
  });
  test('un lien symbolique ne fait pas sortir du dossier', async () => {
    const { mkdirSync, symlinkSync } = await import('fs');
    const T = path.join(ws, 'T');
    mkdirSync(T, { recursive: true });
    symlinkSync('/etc', path.join(T, 'lien'));   // outside every allowed folder (/tmp is allowed)
    assert.equal(await g('Read', { file_path: path.join(T, 'lien', 'hostname') }), 'deny');
    assert.equal(await g('Read', { file_path: path.join(T, 'note.md') }), 'allow');
  });
  test('Confidentiel est toujours un dossier autorisé, en tête', () => {
    const r = V.protectedRoots(ws);
    assert.equal(r[0], path.join(ws, 'Confidentiel'));
  });
});

describe('vault — chiffrement', () => {
  test('chiffrer : table et originaux illisibles sur le disque, puis verrouiller / déverrouiller', async () => {
    const { existsSync, readdirSync } = await import('fs');
    const n = V.listEntities().length;
    assert.equal(V.setPassphrase('court').ok, false);
    const r = V.setPassphrase('une phrase de passe');
    assert.equal(r.ok, true);
    assert.ok(r.files >= 1, 'the original note was encrypted');
    const D = process.env.VAULT_DIR;
    assert.equal(existsSync(path.join(D, 'coffre.json')), false);
    assert.equal(existsSync(path.join(D, 'originaux')), false);
    const disk = [readFileSync(path.join(D, 'coffre.enc'), 'latin1'), ...readdirSync(path.join(D, 'blobs')).map((f) => readFileSync(path.join(D, 'blobs', f), 'latin1'))].join(' ');
    assert.doesNotMatch(disk, /Acme|Gent|Client-A/);
    assert.equal(V.listEntities().length, n, 'still unlocked');
    V.lock();
    assert.equal(V.isLocked(), true);
    assert.throws(() => V.mask('Acme Brewing'), (e) => e.code === 'VAULT_LOCKED');
    assert.deepEqual(V.revealMap(), {});
    assert.equal(V.unlock('mauvaise phrase'), false);
    assert.equal(V.isLocked(), true);
    V.reset();                                      // as after a restart
    assert.equal(V.isLocked(), true);
    assert.equal(V.unlock('une phrase de passe'), true);
    assert.equal(V.mask('Acme Brewing', { learn: false }), 'Client-A');
  });
  test('nouvelles entrées et versions réelles chiffrées ; changer la phrase', async () => {
    V.addEntity({ real: 'Initech', kind: 'client' });
    const ws = path.join(tmp, 'ws');
    writeFileSync(path.join(ws, 'T', 'r.md'), 'Client-A et ' + V.mask('Initech', { learn: false }));
    const r = await V.particularize(path.join(ws, 'T', 'r.md'), 'T/r.md');
    assert.equal(r.ok, true);
    const reel = V.listReels()[0];
    assert.match(reel.id, /^b:/);
    assert.equal(V.reelFile(reel.id).data.toString(), 'Acme Brewing et Initech');
    assert.equal(V.setPassphrase('nouvelle phrase !', 'faux').ok, false);
    assert.equal(V.setPassphrase('nouvelle phrase !', 'une phrase de passe').ok, true);
    V.reset();
    assert.equal(V.unlock('une phrase de passe'), false);
    assert.equal(V.unlock('nouvelle phrase !'), true);
    assert.equal(V.reelFile(reel.id).data.toString(), 'Acme Brewing et Initech');
    assert.ok(V.protectedRoots(ws).includes(path.join(ws, 'T')));
  });
});
