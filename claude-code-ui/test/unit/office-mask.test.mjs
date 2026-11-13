/*
 * Office files in confidential mode (vault.js transformOffice): what used to
 * slip through — sheet names, table columns, pivot caches, external links,
 * authors and creators, tracked deletions, field codes, embedded files,
 * picture metadata — and the pictures repainted in the redaction editor.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'office-'));
process.env.VAULT_DIR = path.join(tmp, 'coffre');
process.env.DATA_DIR = tmp;
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const V = await import('../../server/lib/vault.js');
const { makeZip, readZip } = await import('../../server/lib/zip.js');

V.addEntity({ real: 'Acme Brewing', kind: 'client', variants: ['Acme'] });
const SECRET = /Acme|acme\.be|Jean Testeur|john@|Testeur/;

/** every byte of a zip, nested Office zips opened too */
function allText(buf) {
  return readZip(buf).map((e) => (/\.(xlsx|docx|pptx)$/.test(e.name) && e.data.length ? allText(e.data) : e.data.toString('latin1'))).join('\n');
}
const pngWithText = () => {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Author\0Acme Brewing')), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);
};

describe('Office files: the gaps', () => {
  test('Excel: sheet names, table columns, pivot cache, links, creator, embedded object', async () => {
    const inner = makeZip([{ name: 'xl/sharedStrings.xml', data: '<sst><si><t>Acme Brewing</t></si></sst>' }]);
    const x = makeZip([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Acme Brewing" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Acme Brewing</t></si><si><t>Total</t></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row><c><f>\'Acme Brewing\'!A1</f></c></row></sheetData></worksheet>' },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="hyperlink" Target="https://www.acme.be/offre?x=1" TargetMode="External"/><Relationship Id="rId2" Type="hyperlink" Target="mailto:john@acme.be" TargetMode="External"/><Relationship Id="rId3" Type="drawing" Target="../drawings/drawing1.xml"/></Relationships>' },
      { name: 'xl/tables/table1.xml', data: '<table id="1" name="Acme" displayName="Acme_Brewing" ref="A1:B2"><tableColumns count="1"><tableColumn id="1" name="Acme Brewing"/></tableColumns></table>' },
      { name: 'xl/pivotCache/pivotCacheDefinition1.xml', data: '<pivotCacheDefinition><cacheFields><cacheField name="Client"><sharedItems><s v="Acme Brewing"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>' },
      { name: 'docProps/core.xml', data: '<cp:coreProperties><dc:creator>Jean Testeur</dc:creator><cp:lastModifiedBy>Jean Testeur</cp:lastModifiedBy></cp:coreProperties>' },
      { name: 'xl/embeddings/oleObject1.bin', data: Buffer.from('binary Acme Brewing') },
      { name: 'xl/embeddings/Book1.xlsx', data: inner },
      { name: 'xl/media/image1.png', data: pngWithText() },
    ]);
    const a = path.join(tmp, 'a.xlsx'), b = path.join(tmp, 'b.xlsx');
    writeFileSync(a, x);
    const r = await V.maskFile(a, b);
    const out = readFileSync(b);
    assert.doesNotMatch(allText(out), SECRET);
    const files = Object.fromEntries(readZip(out).map((e) => [e.name, e.data]));
    const wb = files['xl/workbook.xml'].toString();
    assert.match(wb, /<sheet name="Client-A"/);
    assert.match(files['xl/worksheets/sheet1.xml'].toString(), /'Client-A'!A1/, 'formulas follow the renamed sheet');
    const t = files['xl/tables/table1.xml'].toString();
    assert.match(t, /tableColumn id="1" name="Client-A"/, 'column name = masked header');
    assert.match(t, /displayName="Client_A"/, 'a table name stays a valid identifier');
    assert.match(files['xl/worksheets/_rels/sheet1.xml.rels'].toString(), /Target="https:\/\/lien-masque\.invalid\/"/);
    assert.match(files['xl/worksheets/_rels/sheet1.xml.rels'].toString(), /mailto:contact\d+@exemple\.invalid/);
    assert.match(files['xl/worksheets/_rels/sheet1.xml.rels'].toString(), /Target="\.\.\/drawings\/drawing1\.xml"/, 'internal targets untouched');
    assert.equal(files['xl/embeddings/oleObject1.bin'].length, 0);
    assert.ok(r.notes.some((n) => /oleObject1\.bin/.test(n)));
    assert.ok(!files['xl/media/image1.png'].includes(Buffer.from('tEXt')), 'PNG text chunk removed');
  });

  test('Word: tracked deletions, authors, field codes; repainted and blanked pictures', async () => {
    const doc = '<w:document><w:body><w:p><w:del w:id="1" w:author="Jean Testeur"><w:r><w:delText>Acme Brewing</w:delText></w:r></w:del>'
      + '<w:r><w:instrText> HYPERLINK "https://acme.be/contact" </w:instrText></w:r><w:r><w:t>Bonjour</w:t></w:r></w:p></w:body></w:document>';
    const x = makeZip([
      { name: 'word/document.xml', data: doc },
      { name: 'word/comments.xml', data: '<w:comments><w:comment w:id="0" w:author="Jean Testeur" w:initials="JT"><w:p><w:r><w:t>voir Acme</w:t></w:r></w:p></w:comment></w:comments>' },
      { name: 'word/media/image1.jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
      { name: 'word/media/image2.emf', data: Buffer.from(' EMF Acme Brewing logo') },
    ]);
    const a = path.join(tmp, 'a.docx'), b = path.join(tmp, 'b.docx');
    writeFileSync(a, x);
    const painted = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00]);
    await V.maskFile(a, b, { media: new Map([['word/media/image1.jpeg', painted]]), blankMedia: true });
    const out = readFileSync(b);
    assert.doesNotMatch(allText(out), SECRET);
    const files = Object.fromEntries(readZip(out).map((e) => [e.name, e.data]));
    assert.match(files['word/document.xml'].toString(), /<w:delText>Client-A<\/w:delText>/);
    assert.match(files['word/document.xml'].toString(), /HYPERLINK "https:\/\/lien-masque\.invalid\/"/);
    assert.match(files['word/document.xml'].toString(), /w:author="Personne-\d+"/);
    assert.deepEqual([...files['word/media/image1.jpeg']], [...painted], 'the repainted picture replaces the original');
    assert.equal(files['word/media/image2.emf'].subarray(40, 44).toString('latin1'), ' EMF', 'a blank EMF, still an EMF');
    assert.ok(!files['word/media/image2.emf'].includes(Buffer.from('Acme')));
  });

  test('the pictures of an Office file, for the editor', () => {
    const x = makeZip([{ name: 'ppt/media/image1.png', data: pngWithText() }, { name: 'ppt/media/image2.wmf', data: Buffer.from('w') }, { name: 'ppt/slides/slide1.xml', data: '<p:sld/>' }]);
    const m = V.officeMedia(x);
    assert.deepEqual(m.images.map((i) => [i.path, i.mime]), [['ppt/media/image1.png', 'image/png']]);
    assert.deepEqual(m.other, ['ppt/media/image2.wmf']);
  });

  test('the vault guard: a lone slash in a sentence is not a search through /', () => {
    const g = (cmd) => V.vaultGuard({ tool_name: 'Bash', tool_input: { command: cmd } }).hookSpecificOutput?.permissionDecision || 'allow';
    assert.equal(g('grep -n x a.js && echo "tiff / bmp"'), 'allow');
    assert.equal(g('grep -rn Acme /'), 'deny');
    assert.equal(g('cd /tmp && find / -name x'), 'deny');
  });
});
