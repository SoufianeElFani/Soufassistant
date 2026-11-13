/*
 * Old and OpenDocument formats (.doc, .xls, .ppt, .rtf, .odt…) converted by
 * LibreOffice then masked; the pictures of an anonymised folder's documents,
 * listed until checked. The conversion tests need LibreOffice (in the app's
 * image; skipped where it is absent).
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
process.env.VAULT_DIR = path.join(tmp, 'coffre');
process.env.DATA_DIR = tmp;
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const V = await import('../../server/lib/vault.js');
const { makeZip, readZip } = await import('../../server/lib/zip.js');
const hasSoffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 60000 }); return true; } catch { return false; } })();
const skip = hasSoffice ? false : 'LibreOffice absent';
const text = (buf) => readZip(buf).map((e) => e.data.toString('latin1')).join('\n');

V.addEntity({ real: 'Acme Brewing', kind: 'client', variants: ['Acme'] });

describe('old formats', () => {
  test('.rtf and .doc: converted, masked, given the new extension', { skip }, async () => {
    const rtf = path.join(tmp, 'offre.rtf');
    writeFileSync(rtf, '{\\rtf1\\ansi Offre pour Acme Brewing, contact Mme Alice MARTIN.\\par}');
    const r = await V.maskFile(rtf, path.join(tmp, 'out.rtf'));
    assert.equal(r.ok, true);
    assert.equal(r.how, 'rtf→docx');
    assert.match(r.dst, /out\.docx$/);
    const t = text(readFileSync(r.dst));
    assert.doesNotMatch(t, /Acme|Alice|MARTIN/);
    assert.match(t, /Client-A/);
    // a real .doc, made from that file by LibreOffice itself
    execFileSync('soffice', [`-env:UserInstallation=file://${tmp}/p`, '--headless', '--convert-to', 'doc', '--outdir', tmp, rtf], { stdio: 'ignore', timeout: 180000 });
    const doc = path.join(tmp, 'offre.doc');
    assert.ok(existsSync(doc));
    const r2 = await V.maskFile(doc, path.join(tmp, 'out2.doc'));
    assert.equal(r2.how, 'doc→docx');
    assert.doesNotMatch(text(readFileSync(r2.dst)), /Acme|Alice|MARTIN/);
  });

  test('an attachment in an old format reaches the agent as a masked .docx', { skip }, async () => {
    const up = path.join(tmp, 'up');
    mkdirSync(up, { recursive: true });
    const p = path.join(up, 'note.rtf');
    writeFileSync(p, '{\\rtf1\\ansi Relance Acme Brewing\\par}');
    const a = { path: p, name: 'note Acme.rtf', isImage: false };
    await V.maskAttachments([a]);
    assert.match(a.path, /note\.docx$/);
    assert.equal(a.name, 'note Client-A.docx');
    assert.doesNotMatch(text(readFileSync(a.path)), /Acme/);
    assert.equal(existsSync(p), false, 'the clear original is gone');
  });

  test('anonymising a folder converts its old formats', { skip }, async () => {
    const root = path.join(tmp, 'ws');
    mkdirSync(path.join(root, 'F'), { recursive: true });
    writeFileSync(path.join(root, 'F', 'cr Acme.rtf'), '{\\rtf1\\ansi Compte rendu Acme Brewing\\par}');
    const rep = await V.anonymizeTree(root, 'F');
    assert.deepEqual(rep.convertis, ['F/cr Client-A.docx']);
    assert.deepEqual(readdirSync(path.join(root, 'F')), ['cr Client-A.docx']);
  });
});

describe('pictures of the documents of an anonymised folder', () => {
  test('listed until checked; repainted / blanked / « rien de sensible »', async () => {
    const root = path.join(tmp, 'ws2');
    mkdirSync(path.join(root, 'G'), { recursive: true });
    const deck = makeZip([
      { name: 'ppt/slides/slide1.xml', data: '<p:sld><a:p><a:r><a:t>Acme</a:t></a:r></a:p></p:sld>' },
      { name: 'ppt/media/image1.png', data: Buffer.from('89504e470d0a1a0a', 'hex') },
      { name: 'ppt/media/image2.emf', data: Buffer.from(' EMF logo') },
    ]);
    writeFileSync(path.join(root, 'G', 'deck Acme.pptx'), deck);
    writeFileSync(path.join(root, 'G', 'texte.pptx'), makeZip([{ name: 'ppt/slides/slide1.xml', data: '<p:sld/>' }]));
    const rep = await V.anonymizeTree(root, 'G');
    assert.deepEqual(rep.documents_images, ['G/deck Client-A.pptx']);
    assert.deepEqual(V.docsToCheck(root), [{ path: 'G/deck Client-A.pptx', images: 1, other: 1 }]);
    assert.equal(V.saveDocMedia(root, 'G/deck Client-A.pptx', new Map([['ppt/media/image1.png', Buffer.from('painted')]]), true), true);
    const files = Object.fromEntries(readZip(readFileSync(path.join(root, 'G', 'deck Client-A.pptx'))).map((e) => [e.name, e.data]));
    assert.equal(files['ppt/media/image1.png'].toString(), 'painted');
    assert.equal(files['ppt/media/image2.emf'].subarray(40, 44).toString('latin1'), ' EMF', 'blanked, still an EMF');
    assert.deepEqual(V.docsToCheck(root), []);
    assert.equal(V.saveDocMedia(root, '../x.pptx'), false);
  });
});
