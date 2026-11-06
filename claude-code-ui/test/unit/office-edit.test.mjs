/*
 * Editing documents in the viewer (server/lib/office-edit.js) and the ZIP
 * reader it stands on (zip.js): minimal paragraph edits that keep formatting,
 * Excel cells, and whole files round-tripped through documentModel/saveDocument.
 */
import { register } from 'node:module';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'office-edit-'));
process.env.EDIT_BACKUP_DIR = path.join(tmp, 'backups');
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const oe = await import('../../server/lib/office-edit.js');
const { makeZip, readZip } = await import('../../server/lib/zip.js');

const text = (px, f) => oe.paragraphText(oe.scanParagraph(px, f));

describe('zip', () => {
  test('readZip reads back STORE and DEFLATE archives', () => {
    const files = [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'd/b.xml', data: Buffer.from('<x/>'.repeat(500)) }];
    for (const deflate of [false, true]) {
      const back = readZip(makeZip(files, { deflate }));
      assert.deepEqual(back.map((e) => [e.name, e.data.toString()]), files.map((f) => [f.name, f.data.toString()]));
    }
  });
  test('refuses what is not a zip', () => {
    assert.throws(() => readZip(Buffer.from('not a zip at all, really')), /Not a ZIP/);
  });
});

describe('editParagraph (docx)', () => {
  const px = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> big world</w:t></w:r><w:r><w:tab/><w:t>end</w:t></w:r></w:p>';
  test('reads text with tabs', () => assert.equal(text(px, 'docx'), 'Hello big world\tend'));
  test('a change in the middle touches only that run', () => {
    const out = oe.editParagraph(px, 'docx', 'Hello small world\tend');
    assert.match(out, /<w:b\/><\/w:rPr><w:t>Hello<\/w:t>/, 'the bold run is untouched');
    assert.equal(text(out, 'docx'), 'Hello small world\tend');
  });
  test('edits at both ends stay two edits (the bold word keeps its run)', () => {
    const out = oe.editParagraph(px, 'docx', 'Hi! Hello big world\tend.');
    assert.match(out, /<w:b\/><\/w:rPr><w:t xml:space="preserve">Hi! Hello<\/w:t>/);
    assert.match(out, /<w:t xml:space="preserve">end\.<\/w:t>/);
  });
  test('a new line becomes a break, a removed tab goes', () => {
    const out = oe.editParagraph(px, 'docx', 'Hello big world end\nmore');
    assert.match(out, /<w:br\/>/);
    assert.doesNotMatch(out, /<w:tab\/>/);
    assert.equal(text(out, 'docx'), 'Hello big world end\nmore');
  });
  test('escapes and preserves spaces', () => {
    const out = oe.editParagraph('<w:p><w:r><w:t>a</w:t></w:r></w:p>', 'docx', ' a & <b> ');
    assert.match(out, /<w:t xml:space="preserve"> a &amp; &lt;b&gt; <\/w:t>/);
  });
  test('an empty paragraph gets a run, with the paragraph mark formatting', () => {
    const out = oe.editParagraph('<w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr></w:p>', 'docx', 'new');
    assert.match(out, /<w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">new<\/w:t><\/w:r><\/w:p>$/);
    assert.equal(text(oe.editParagraph('<w:p w:rsidR="1"/>', 'docx', 'x'), 'docx'), 'x');
  });
  test('unchanged text returns the same XML', () => assert.equal(oe.editParagraph(px, 'docx', text(px, 'docx')), px));
});

describe('editParagraph (pptx)', () => {
  const pp = '<a:p><a:r><a:rPr lang="fr" b="1"/><a:t>Titre</a:t></a:r><a:br><a:rPr lang="fr"/></a:br><a:r><a:rPr lang="fr"/><a:t>sous</a:t></a:r><a:endParaRPr lang="fr"/></a:p>';
  test('line breaks are a:br, and new lines split the run', () => {
    assert.equal(text(pp, 'pptx'), 'Titre\nsous');
    const out = oe.editParagraph(pp, 'pptx', 'Titre\nsous\ntrois');
    assert.match(out, /<a:br\/><a:r><a:rPr lang="fr"\/><a:t>trois<\/a:t><\/a:r>/);
    assert.equal(text(out, 'pptx'), 'Titre\nsous\ntrois');
  });
  test('an empty paragraph takes the end-of-paragraph properties', () => {
    const out = oe.editParagraph('<a:p><a:endParaRPr lang="fr" sz="1200"/></a:p>', 'pptx', 'vide');
    assert.equal(out, '<a:p><a:r><a:rPr lang="fr" sz="1200"/><a:t>vide</a:t></a:r><a:endParaRPr lang="fr" sz="1200"/></a:p>');
  });
});

describe('leafElements', () => {
  test('skips paragraphs that hold others, and mc:Fallback copies', () => {
    const xml = '<w:body><w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>in box</w:t></w:r></w:p></w:txbxContent></mc:Choice>'
      + '<mc:Fallback><w:txbxContent><w:p><w:r><w:t>in box</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:t>b</w:t></w:r></w:p><w:p/></w:body>';
    const paras = oe.partParagraphs(xml, 'docx');
    assert.deepEqual(paras.map((p) => p.text), ['in box', 'b', '']);
  });
  test('setPartParagraphs refuses a stale paragraph', () => {
    const xml = '<w:body><w:p><w:r><w:t>one</w:t></w:r></w:p></w:body>';
    assert.throws(() => oe.setPartParagraphs(xml, 'docx', [{ i: 0, old: 'other', text: 'x' }]), /changed/);
    assert.match(oe.setPartParagraphs(xml, 'docx', [{ i: 0, old: 'one', text: 'two' }]), /two/);
  });
});

describe('diffHunks', () => {
  test('word-level hunks', () => {
    assert.deepEqual(oe.diffHunks('a b c', 'a x c'), [[2, 3, 'x']]);
    assert.deepEqual(oe.diffHunks('one two', 'zero one two three'), [[0, 0, 'zero '], [7, 7, ' three']]);
    assert.deepEqual(oe.diffHunks('same', 'same'), []);
  });
});

describe('Excel cells', () => {
  const sheet = '<worksheet><sheetData><row r="1" spans="1:2"><c r="A1" s="2" t="s"><v>0</v></c><c r="B1"><v>5</v></c></row>'
    + '<row r="3"><c r="C3"><f t="shared" ref="C3:C5" si="0">A1*2</f><v>2</v></c></row></sheetData></worksheet>';
  test('reads shared strings, numbers and formulas', () => {
    const { rows, maxRow, maxCol } = oe.sheetCells(sheet, ['Titre']);
    assert.equal(rows[0][0].v, 'Titre');
    assert.equal(rows[0][1].v, '5');
    assert.equal(rows[2][2].f, 'A1*2');
    assert.deepEqual([maxRow, maxCol], [3, 3]);
  });
  test('setCell keeps the style, types the value, inserts rows and cells in order', () => {
    let x = oe.setCell(sheet, 'A1', 'Nouveau');
    assert.match(x, /<c r="A1" s="2" t="inlineStr"><is><t xml:space="preserve">Nouveau<\/t><\/is><\/c>/);
    x = oe.setCell(x, 'B1', '=A1&"!"');
    assert.match(x, /<c r="B1"><f>A1&amp;"!"<\/f><\/c>/);
    x = oe.setCell(x, 'B2', '3.5');
    assert.match(x, /<\/row><row r="2"><c r="B2"><v>3.5<\/v><\/c><\/row><row r="3">/);
    x = oe.setCell(x, 'A3', 'TRUE');
    assert.match(x, /<row r="3"><c r="A3" t="b"><v>1<\/v><\/c><c r="C3">/);
    assert.doesNotMatch(x, /spans=/);
    assert.equal(oe.setCell(x, 'Z99', ''), x, 'clearing a missing cell changes nothing');
  });
  test('the anchor of a shared formula is refused', () => {
    assert.throws(() => oe.setCell(sheet, 'C3', '1'), /shared formula/);
  });
});

describe('whole files', () => {
  const docx = path.join(tmp, 'a.docx');
  const pptx = path.join(tmp, 'b.pptx');
  const xlsx = path.join(tmp, 'c.xlsx');
  before(() => {
    writeFileSync(docx, makeZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p><w:p><w:r><w:t>Body text</w:t></w:r></w:p></w:body></w:document>' },
      { name: 'word/footer1.xml', data: '<w:ftr><w:p><w:r><w:t>Fait par Soufiane</w:t></w:r></w:p></w:ftr>' },
    ], { deflate: true }));
    writeFileSync(pptx, makeZip([
      { name: 'ppt/presentation.xml', data: '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>' },
      { name: 'ppt/_rels/presentation.xml.rels', data: '<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>' },
      { name: 'ppt/slides/slide1.xml', data: '<p:sld><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp>'
        + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Slide Number"/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp></p:sld>' },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: '<Relationships><Relationship Id="rId9" Type="http://x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>' },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: '<p:notes><p:sp><p:txBody><a:p><a:r><a:t>Say hi</a:t></a:r></a:p></p:txBody></p:sp></p:notes>' },
      { name: 'ppt/slides/slide2.xml', data: '<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp></p:sld>' },
    ]));
    writeFileSync(xlsx, makeZip([
      { name: '[Content_Types].xml', data: '<Types><Override PartName="/xl/calcChain.xml" ContentType="x"/></Types>' },
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Synthèse" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="1"/></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId5" Type="x/calcChain" Target="calcChain.xml"/></Relationships>' },
      { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Prix</t></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10</v></c></row></sheetData></worksheet>' },
      { name: 'xl/calcChain.xml', data: '<calcChain/>' },
    ]));
  });

  test('docx: body and footer, headings hinted; a save changes only the text', async () => {
    const m = await oe.documentModel(docx);
    assert.equal(m.ok, true);
    assert.deepEqual(m.parts.map((p) => p.label), ['Document', 'Footer 1']);
    assert.equal(m.parts[0].paragraphs[0].hint, 'h1');
    const r = await oe.saveDocument(docx, { mtime: m.mtime, edits: [{ part: 'word/document.xml', i: 1, old: 'Body text', text: 'Body text, edited' }] });
    assert.equal(r.ok, true, r.error);
    const files = new Map(readZip(readFileSync(docx)).map((e) => [e.name, e.data.toString()]));
    assert.match(files.get('word/document.xml'), /Body text, edited/);
    assert.match(files.get('word/document.xml'), /Heading1/);
    assert.equal(files.get('word/footer1.xml'), '<w:ftr><w:p><w:r><w:t>Fait par Soufiane</w:t></w:r></w:p></w:ftr>');
  });

  test('a stale mtime is a conflict; a stale paragraph too', async () => {
    const m = await oe.documentModel(docx);
    let r = await oe.saveDocument(docx, { mtime: m.mtime - 10000, edits: [{ part: 'word/document.xml', i: 0, old: 'Intro', text: 'x' }] });
    assert.equal(r.conflict, true);
    r = await oe.saveDocument(docx, { mtime: m.mtime, edits: [{ part: 'word/document.xml', i: 0, old: 'not it', text: 'x' }] });
    assert.equal(r.conflict, true);
    r = await oe.saveDocument(docx, { mtime: m.mtime, edits: [{ part: 'word/evil.xml', i: 0, text: 'x' }] });
    assert.equal(r.ok, false);
  });

  test('pptx: slides in order, notes after their slide, slide numbers left out', async () => {
    const m = await oe.documentModel(pptx);
    assert.deepEqual(m.parts.map((p) => p.label), ['Slide 1', 'Notes 1', 'Slide 2']);
    assert.deepEqual(m.parts[0].paragraphs.map((p) => [p.text, p.shape]), [['Hello', 'Title 1']]);
    const r = await oe.saveDocument(pptx, { mtime: m.mtime, edits: [
      { part: 'ppt/notesSlides/notesSlide1.xml', i: 0, old: 'Say hi', text: 'Say hello' },
      { part: 'ppt/slides/slide2.xml', i: 0, old: 'Second', text: 'Deuxième' },
    ] });
    assert.equal(r.ok, true, r.error);
    const m2 = await oe.documentModel(pptx);
    assert.equal(m2.parts[1].paragraphs[0].text, 'Say hello');
    assert.equal(m2.parts[2].paragraphs[0].text, 'Deuxième');
  });

  test('xlsx: cells read and written; recalculated on open, calc chain dropped', async () => {
    const m = await oe.documentModel(xlsx);
    assert.equal(m.sheets[0].label, 'Synthèse');
    assert.equal(m.sheets[0].rows[0][0].v, 'Prix');
    const r = await oe.saveDocument(xlsx, { mtime: m.mtime, edits: [{ sheet: 'xl/worksheets/sheet1.xml', ref: 'B2', value: '=B1*2' }] });
    assert.equal(r.ok, true, r.error);
    const files = new Map(readZip(readFileSync(xlsx)).map((e) => [e.name, e.data.toString()]));
    assert.match(files.get('xl/worksheets/sheet1.xml'), /<row r="2"><c r="B2"><f>B1\*2<\/f><\/c><\/row>/);
    assert.match(files.get('xl/workbook.xml'), /<calcPr calcId="1" fullCalcOnLoad="1"\/>/);
    assert.equal(files.has('xl/calcChain.xml'), false);
    assert.doesNotMatch(files.get('xl/_rels/workbook.xml.rels'), /calcChain/);
    assert.doesNotMatch(files.get('[Content_Types].xml'), /calcChain/);
  });

  test('saveBinary keeps a backup and checks the mtime', () => {
    const f = path.join(tmp, 'p.png');
    writeFileSync(f, 'old');
    utimesSync(f, new Date(1000000), new Date(1000000));
    assert.equal(oe.saveBinary(f, Buffer.from('new'), { mtime: 5 }).conflict, true);
    assert.equal(oe.saveBinary(f, Buffer.from('new'), { mtime: 1000000 }).ok, true);
    assert.equal(readFileSync(f, 'utf8'), 'new');
  });
});
