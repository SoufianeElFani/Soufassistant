/*
 * Masquage d'images et de plans (server/lib/redact.js) : lignes OCR / texte
 * d'un PDF → zones à masquer. L'analyse réelle (pdftoppm, pdftotext,
 * tesseract) n'est testée que si ces outils sont installés (image de l'app).
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'redact-'));
process.env.VAULT_DIR = path.join(tmp, 'coffre');
process.env.DATA_DIR = tmp;
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const V = await import('../../server/lib/vault.js');
const R = await import('../../server/lib/redact.js');
const has = (cmd) => { try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };

/** A one-page vector PDF (Helvetica), text lines at (x, y) in points from the top. */
function pdf(lines, W = 842, H = 595) {
  const ops = lines.map(([x, y, s, t]) => `BT /F1 ${s} Tf ${x} ${H - y} Td (${t.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
const PLAN = [
  [40, 40, 14, 'P&ID - Utilities - Pump P-101 to tank T-201'],
  [40, 80, 10, 'Contact: Mme Alice MARTIN, alice@globex.example, +32 475 12 34 56'],
  [560, 500, 10, 'CLIENT: Globex Industries'],
  [560, 520, 10, 'Site: Rue de la Station 12, 9000 Gent'],
  [560, 540, 10, 'DWG No 2026_07-1234'],
];

describe('redact — zones à masquer', () => {
  test('une ligne : coffre, e-mail, téléphone, adresse, champs du cartouche ; pas les repères', () => {
    V.addEntity({ real: 'Globex Industries', kind: 'client', variants: ['Globex'] });
    const at = (t) => V.sensitiveSpans(t).filter((s) => s.sure).map((s) => t.slice(s.start, s.end));
    assert.deepEqual(at('Pump P-101 to tank T-201, valve XV-2003 open'), []);
    assert.ok(at('CLIENT: Globex Industries').includes('Globex Industries'));
    assert.ok(at('Site: Rue de la Station 12, 9000 Gent').some((s) => /Rue de la Station/.test(s)));
    assert.ok(at('Site: Rue de la Station 12, 9000 Gent').includes('9000 Gent'));
    assert.ok(at('DWG No 2026_07-1234').some((s) => /2026_07-1234/.test(s)));
    assert.ok(at('voir https://portal.globex.example/x').some((s) => s.startsWith('https://')));
  });
  test('mots OCR → rectangles autour des seuls mots concernés', () => {
    const line = [['Contact:', 0], ['alice@globex.example', 100], ['merci', 400]].map(([text, x]) => ({ text, x, y: 10, w: text.length * 8, h: 12 }));
    const b = R.boxesFor([line]);
    assert.equal(b.length, 1);
    assert.equal(b[0].why, 'email');
    assert.ok(b[0].x < 100 && b[0].x > 90 && b[0].x + b[0].w < 400);
  });
  test('Tesseract TSV et pdftotext -bbox-layout', () => {
    const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t91\tHello\n5\t1\t1\t1\t1\t2\t45\t20\t30\t12\t90\tworld\n5\t1\t1\t1\t2\t1\t10\t40\t30\t12\t-1\tnoise';
    assert.deepEqual(R.parseTsv(tsv).map((l) => l.map((w) => w.text)), [['Hello', 'world']]);
    const x = '<page width="100" height="100"><flow><block><line><word xMin="72" yMin="36" xMax="144" yMax="48">Gent&amp;Co</word></line></block></flow></page>';
    assert.deepEqual(R.parseBbox(x, 144), [[[{ text: 'Gent&Co', x: 144, y: 72, w: 144, h: 24 }]]]);
  });
});

describe('redact — analyse réelle', () => {
  const tools = has('pdftoppm') && has('pdftotext');
  test('un plan PDF vectoriel : page rendue, zones sûres au bon endroit', { skip: tools ? false : 'poppler absent' }, async () => {
    const r = await R.analyze({ name: 'plan.pdf', mediaType: 'application/pdf', data: pdf(PLAN).toString('base64') });
    assert.equal(r.ok, true);
    assert.equal(r.pages.length, 1);
    const p = r.pages[0];
    assert.equal(p.text, 'vecteur');
    assert.equal(p.w, Math.round(842 * r.dpi / 72), `rendered at ${r.dpi} dpi`);
    assert.ok(r.dpi >= 150);
    const k = r.dpi / 72;
    const sure = p.boxes.filter((b) => b.sure);
    const why = sure.map((b) => b.why);
    for (const w of ['email', 'tel', 'personne', 'coffre', 'adresse']) assert.ok(why.includes(w), `${w} in ${why}`);
    assert.ok(sure.some((b) => /2026_07-1234/.test(b.text)), 'the drawing number (as a reference or a drawing no.)');
    const mail = sure.find((b) => b.why === 'email');
    assert.ok(Math.abs(mail.y - (80 - 10) * k) < 12 * k, 'the box is on the contact line');
    assert.ok(!sure.some((b) => /P-101|T-201/.test(b.text)), 'equipment tags stay');
  });
  test('une capture (OCR local)', { skip: tools && has('tesseract') ? false : 'tesseract absent' }, async () => {
    const f = path.join(tmp, 'plan.pdf');
    execFileSync('sh', ['-c', `cat > ${f}`], { input: pdf(PLAN) });
    execFileSync('pdftoppm', ['-r', '110', '-png', '-singlefile', f, path.join(tmp, 'cap')]);
    const r = await R.analyze({ name: 'capture.png', mediaType: 'image/png', data: readFileSync(path.join(tmp, 'cap.png')).toString('base64') });
    assert.equal(r.ok, true);
    assert.equal(r.pages[0].text, 'ocr');
    const why = r.pages[0].boxes.filter((b) => b.sure).map((b) => b.why);
    assert.ok(why.includes('email') && why.includes('coffre'), why.join(','));
  });
  test('coffre verrouillé : pas d\'analyse', async () => {
    assert.equal(V.setPassphrase('phrase de test').ok, true);
    V.lock();
    const r = await R.analyze({ name: 'x.png', mediaType: 'image/png', data: '' });
    assert.equal(r.locked, true);
    assert.equal(V.unlock('phrase de test'), true);
  });
});

describe('redact — images du workspace « à vérifier »', () => {
  test('anonymiser un dossier les liste ; les masquer les remplace, l\'original au coffre', async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import('fs');
    const root = path.join(tmp, 'ws');
    mkdirSync(path.join(root, 'D'), { recursive: true });
    writeFileSync(path.join(root, 'D', 'photo Globex.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await V.anonymizeTree(root, 'D');
    assert.deepEqual(V.imagesToCheck(root), ['D/photo Client-A.jpg']);
    const out = V.saveRedacted(root, 'D/photo Client-A.jpg', Buffer.from('png'));
    assert.equal(out, 'D/photo Client-A.png');
    assert.equal(existsSync(path.join(root, 'D', 'photo Client-A.jpg')), false);
    assert.equal(readFileSync(path.join(root, out), 'utf8'), 'png');
    assert.deepEqual(V.imagesToCheck(root), []);
    assert.equal(V.saveRedacted(root, '../x.png', Buffer.from('x')), null);
  });
});

describe('redact — mode strict et pièces jointes', () => {
  test('une image masquée est lisible par l\'agent, une image brute non', async () => {
    const up = '/srv/uploads';      // outside /tmp, which strict mode allows anyway (no file is touched here)
    const a = { path: path.join(up, 'a.png'), name: 'Globex_plan.png', isImage: true, redacted: true };
    const b = { path: path.join(up, 'b.png'), name: 'brut.png', isImage: true };
    const notes = await V.maskAttachments([a, b]);
    assert.equal(a.name, 'Client-A_plan.png');
    assert.deepEqual(notes, ['image non masquée : brut.png']);
    const G = V.strictGuard(() => [], '/config');
    const g = async (p) => (await G({ tool_name: 'Read', tool_input: { file_path: p } })).hookSpecificOutput?.permissionDecision || 'allow';
    assert.equal(await g(a.path), 'allow');
    assert.equal(await g(b.path), 'deny');
  });
});
