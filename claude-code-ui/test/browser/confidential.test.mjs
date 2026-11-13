/*
 * Mode Confidentiel à l'écran : l'alerte avant envoi (noms que le coffre ne
 * connaît pas) et la phrase de passe demandée quand le coffre chiffré est
 * verrouillé — dans les deux cas, rien ne part avant la réponse de l'utilisateur.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startServer } from '../helpers/server-harness.mjs';
import { makeZip, readZip } from '../../server/lib/zip.js';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
const skip = executablePath ? false : 'no Chrome found (set CHROME_PATH)';

describe('confidential shield in the browser', { skip }, () => {
  let h, browser, page;
  const errors = [];
  const post = (u, b) => fetch(`${h.baseUrl}${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ text: 'Ok 1' }] }, { steps: [{ text: 'Ok 2' }] }, { steps: [{ text: 'Ok 3' }] },
      { steps: [{ tool: { name: 'AskUserQuestion', input: { questions: [{ header: 'Client-A', question: 'On relance Client-A ?', options: [{ label: 'Oui, Client-A', description: 'Mail à Client-A' }, { label: 'Non' }] }] }, id: 'qa' } }] },
      { steps: [{ text: 'Ok 5' }] }, { steps: [{ text: 'Ok 6' }] }] } });
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
  });
  after(async () => { await browser?.close(); await h?.stop(); });

  async function send(text) {
    await page.$eval('#prompt-input', (el) => { el.value = ''; });
    await page.type('#prompt-input', text);
    await page.click('#send-btn');
  }

  test('the shield is on by default, Chat included', async () => {
    assert.equal(await page.$eval('#conf-btn', (b) => b.classList.contains('active')), true);
  });

  test('a name the vault does not know is flagged before sending, and protected', async () => {
    const queries = h.records('query').length;
    await send('Prépare une offre pour Globex Industries.');
    await page.waitForSelector('.conf-dialog .conf-row', { timeout: 5000 });
    assert.match(await page.$eval('.conf-dialog .conf-row b', (b) => b.textContent), /Globex Industries/);
    assert.equal(h.records('query').length, queries, 'nothing sent while the dialog is open');
    await page.click('.conf-dialog .btn-allow');
    await h.waitForRecord((r) => r.kind === 'query' && /Client-A/.test(r.prompt || ''), { timeout: 8000 });
    assert.doesNotMatch(h.records('query').at(-1).prompt, /Globex/);
  });

  test('a locked vault asks for the passphrase, then sends', async () => {
    await page.waitForFunction(() => !document.querySelector('#send-btn.stop'), { timeout: 8000 });
    assert.equal((await post('/api/vault/passphrase', { pass: 'phrase de test' })).ok, true);
    assert.equal((await post('/api/vault/lock', {})).ok, true);
    await page.waitForFunction(() => document.getElementById('conf-btn').classList.contains('locked'), { timeout: 5000 });
    const queries = h.records('query').length;
    await send('Relance Globex Industries');
    await page.waitForSelector('#conf-pass', { timeout: 5000 });
    await page.type('#conf-pass', 'faux');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /incorrecte/.test(document.querySelector('.conf-err')?.textContent || ''), { timeout: 5000 });
    assert.equal(h.records('query').length, queries);
    await page.$eval('#conf-pass', (el) => { el.value = ''; });
    await page.type('#conf-pass', 'phrase de test');
    await page.keyboard.press('Enter');
    await h.waitForRecord((r) => r.kind === 'query' && /Relance Client-A/.test(r.prompt || ''), { timeout: 8000 });
    assert.equal(await page.$eval('#conf-btn', (b) => b.classList.contains('locked')), false);
    assert.deepEqual(errors, []);
  });

  test('an attached picture goes through the redaction editor: only the painted PNG is sent', async () => {
    await page.waitForFunction(() => !document.querySelector('#send-btn.stop'), { timeout: 8000 });
    // a 400×200 white picture with a red square where the "secret" is
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 200;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 200); g.fillStyle = '#f00'; g.fillRect(40, 40, 120, 60);
      return c.toDataURL('image/png').split(',')[1];
    });
    const f = path.join(h.dataDir, 'capture.png');
    writeFileSync(f, Buffer.from(png, 'base64'));
    const input = await page.$('#attach-input');
    await input.uploadFile(f);
    const queries = h.records('query').length;
    await send('regarde cette capture');
    await page.waitForSelector('.redact-card canvas', { timeout: 20000 });
    // the first draw sizes the canvas (next animation frame): measure after it
    await page.waitForFunction(() => /zone/.test(document.querySelector('.redact-info')?.textContent || ''), { timeout: 5000 });
    assert.equal(h.records('query').length, queries, 'nothing sent while the editor is open');
    // draw a zone over the red square (canvas coordinates → page coordinates)
    const box = await page.$eval('.redact-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, k: r.width / 400 }; });
    await page.mouse.move(box.x + 30 * box.k, box.y + 30 * box.k);
    await page.mouse.down();
    await page.mouse.move(box.x + 100 * box.k, box.y + 70 * box.k, { steps: 4 });
    await page.mouse.move(box.x + 170 * box.k, box.y + 110 * box.k, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => [...document.querySelectorAll('.redact-bar button')].find((b) => /Envoyer masqué/.test(b.textContent)).click());
    const q = await h.waitForRecord((r) => r.kind === 'query' && /regarde cette capture/.test(r.prompt || '') , { timeout: 10000 });
    const sent = q.prompt.match(/- (\S+\.png)/)[1];
    const pixels = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
      return { w: img.width, inside: px(100, 70), outside: px(300, 150) };
    }, readFileSync(sent).toString('base64'));
    assert.equal(pixels.w, 400, 'full resolution');
    assert.deepEqual(pixels.inside, [0, 0, 0], 'the zone is painted black');
    assert.deepEqual(pixels.outside, [255, 255, 255]);
    assert.deepEqual(errors, []);
  });

  test('a question shows the real names; the answer sent back keeps the pseudonym', async () => {
    await page.waitForFunction(() => !document.querySelector('#send-btn.stop'), { timeout: 8000 });
    await page.select('#perm-mode', 'default').catch(() => {});
    await send('pose-moi la question');
    await page.waitForSelector('#dialog-overlay:not(.hidden) .dialog-q-text', { timeout: 10000 });
    const shown = await page.$eval('#dialog-overlay', (o) => o.innerText);
    assert.match(shown, /On relance Globex Industries \?/);
    assert.match(shown, /Oui, Globex Industries/);
    assert.doesNotMatch(shown, /Client-A/, 'no pseudonym left on screen');
    assert.match(await page.$eval('#dialog-overlay .dialog-q-text .pii', (s) => s.title), /Client-A/, 'hover shows what Claude wrote');
    await page.evaluate(() => document.querySelector('#dialog-overlay .dialog-option input').click());
    await page.click('#dialog-submit');
    const d = await h.waitForRecord((r) => r.kind === 'tool_decision' && r.id === 'qa', { timeout: 8000 });
    assert.match(d.outcome.message, /Oui, Client-A/);
    assert.doesNotMatch(d.outcome.message, /Globex/);
  });

  // a PowerPoint with one red picture; returns the colour of its centre once sent
  async function sendDeck(text, choose) {
    await page.waitForFunction(() => !document.querySelector('#send-btn.stop'), { timeout: 8000 });
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 60; c.height = 30;
      const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 60, 30);
      return c.toDataURL('image/png').split(',')[1];
    });
    const f = path.join(h.dataDir, 'deck.pptx');
    writeFileSync(f, makeZip([{ name: 'ppt/slides/slide1.xml', data: '<p:sld><a:t>Offre Globex Industries</a:t></p:sld>' }, { name: 'ppt/media/image1.png', data: Buffer.from(png, 'base64') }]));
    await (await page.$('#attach-input')).uploadFile(f);
    await send(text);
    await page.waitForFunction(() => [...document.querySelectorAll('.conf-dialog .confirm-body')].some((p) => /image/.test(p.textContent)), { timeout: 10000 });
    await choose();
    const q = await h.waitForRecord((r) => r.kind === 'query' && r.prompt?.includes(text), { timeout: 15000 });
    const sent = q.prompt.match(/- (\S+\.pptx)/)[1];
    const files = Object.fromEntries(readZip(readFileSync(sent)).map((e) => [e.name, e.data]));
    assert.doesNotMatch(files['ppt/slides/slide1.xml'].toString(), /Globex/);
    return page.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return [...g.getImageData(30, 15, 1, 1).data].slice(0, 3);
    }, files['ppt/media/image1.png'].toString('base64'));
  }
  const clickText = (sel, re) => page.evaluate((s, r) => [...document.querySelectorAll(s)].find((b) => new RegExp(r).test(b.textContent)).click(), sel, re);

  test('an Office attachment\'s pictures: « Tout masquer » blacks them out', async () => {
    const px = await sendDeck('voici le deck', () => clickText('.conf-dialog .perm-buttons button', 'Tout masquer'));
    assert.deepEqual(px, [0, 0, 0]);
  });

  test('an Office attachment\'s pictures: checked one by one in the editor', async () => {
    const px = await sendDeck('voici le deck encore', async () => {
      await clickText('.conf-dialog .perm-buttons button', 'une à une');
      await page.waitForFunction(() => /zone/.test(document.querySelector('.redact-info')?.textContent || ''), { timeout: 20000 });
      await clickText('.redact-bar button', 'Image entière');
      await clickText('.redact-bar button', 'Terminer');
    });
    assert.deepEqual(px, [0, 0, 0]);
    assert.deepEqual(errors, []);
  });

  test('Hub: an anonymised folder\'s document with pictures is listed, then checked', async () => {
    const API = '/api/' + 'vault';
    const { mkdirSync } = await import('node:fs');
    const ws = path.join(h.dataDir, 'workspace', 'Dossier');
    mkdirSync(ws, { recursive: true });
    const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 20; c.height = 10; return c.toDataURL('image/png').split(',')[1]; });
    writeFileSync(path.join(ws, 'deck Globex Industries.pptx'), makeZip([{ name: 'ppt/slides/slide1.xml', data: '<p:sld/>' }, { name: 'ppt/media/image1.png', data: Buffer.from(png, 'base64') }]));
    const r = await post(API + '/anonymize', { rel: 'Dossier' });
    assert.deepEqual(r.report.documents_images, ['Dossier/deck Client-A.pptx']);
    await page.evaluate(() => import('./js/hub.js').then((m) => m.openHub('confidential')));
    await page.waitForFunction(() => /documents avec images/i.test(document.getElementById('hub-panel').innerText) && /deck/.test(document.getElementById('hub-panel').innerText), { timeout: 8000 });
    await page.evaluate(() => [...document.querySelectorAll('#hub-panel button')].find((b) => /Rien de sensible/.test(b.textContent)).click());
    await page.waitForFunction(() => ![...document.querySelectorAll('#hub-panel button')].some((b) => /Rien de sensible/.test(b.textContent)), { timeout: 8000 });
    assert.deepEqual(errors, []);
  });
});
