/*
 * Mode Confidentiel à l'écran : l'alerte avant envoi (noms que le coffre ne
 * connaît pas) et la phrase de passe demandée quand le coffre chiffré est
 * verrouillé — dans les deux cas, rien ne part avant la réponse de l'utilisateur.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer } from '../helpers/server-harness.mjs';

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
    h = await startServer({ scenario: { runs: [{ steps: [{ text: 'Ok 1' }] }, { steps: [{ text: 'Ok 2' }] }] } });
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
});
