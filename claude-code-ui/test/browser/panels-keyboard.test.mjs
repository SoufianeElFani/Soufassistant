/*
 * On a phone, the on-screen keyboard shrinks the visible band: a field low in a
 * panel (the vault passphrase in Hub › Confidentiel) must scroll back into view
 * instead of staying under the keyboard (panels.js revealField).
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
const phone = (height) => ({ width: 390, height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

describe('a panel field and the phone keyboard', { skip }, () => {
  let h, browser, page;
  const errors = [];
  before(async () => {
    h = await startServer({ scenario: { runs: [] } });
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewport(phone(844));
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
  });
  after(async () => { await browser?.close(); await h?.stop(); });

  test('inside a frame that keeps its height (the HA app), the sheet rides above the keyboard', async () => {
    // Same-origin parent with the app in an 844px iframe; the parent's visible band
    // then shrinks to 420px (the keyboard) while the iframe stays 844px tall.
    const p = await browser.newPage();
    await p.setViewport(phone(844));
    await p.goto(h.baseUrl, { waitUntil: 'domcontentloaded' });
    await p.evaluate((src) => {
      document.open();
      document.write(`<body style="margin:0"><iframe id="f" src="${src}" style="border:0;width:390px;height:844px;display:block"></iframe></body>`);
      document.close();
    }, h.baseUrl);
    const frameOf = async () => (await (await p.$('#f')).contentFrame());
    let f = await frameOf();
    await f.waitForSelector('#prompt-input', { timeout: 10000 });
    await f.evaluate(() => import('./js/hub.js').then((m) => m.openHub('confidential')));
    await f.waitForSelector('#hub-panel .pass-field', { timeout: 5000 });
    await f.focus('#hub-panel .pass-field');
    await p.setViewport(phone(420));               // the keyboard opens over the parent
    f = await frameOf();
    await f.waitForFunction(() => {
      const r = document.getElementById('hub-panel').getBoundingClientRect();
      const field = document.activeElement.getBoundingClientRect();
      return r.bottom <= 420 + 2 && field.top >= 0 && field.bottom <= 420;
    }, { timeout: 4000 });
    if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
    await p.close();
  });

  test('opening the Hub from the phone drawer closes the drawer', async () => {
    await page.click('#menu-btn');
    await page.waitForFunction(() => document.body.classList.contains('drawer-open'), { timeout: 3000 });
    await page.click('#hub-btn');
    await page.waitForFunction(() => !document.body.classList.contains('drawer-open'), { timeout: 3000 });
    assert.equal(await page.$eval('#hub-panel', (p) => p.classList.contains('hidden')), false, 'the Hub is open');
  });

  test('the vault passphrase stays above the keyboard and takes what is typed', async () => {
    await page.evaluate(() => import('./js/hub.js').then((m) => m.openHub('confidential')));
    await page.waitForSelector('#hub-panel .pass-field', { timeout: 5000 });
    const field = await page.$('#hub-panel .pass-field');
    // not a password field: iOS's AutoFill would take it and show no keyboard
    assert.deepEqual(await field.evaluate((i) => [i.type, i.autocomplete, getComputedStyle(i).webkitTextSecurity]), ['text', 'off', 'disc']);
    const bb = await field.boundingBox();
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.keyboard.type('abcd');
    await page.setViewport(phone(420));            // the keyboard opens
    await page.waitForFunction(() => {
      const r = document.activeElement.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight - 8;
    }, { timeout: 3000 });
    await page.keyboard.type('efgh');
    assert.equal(await page.$eval('#hub-panel .pass-field', (i) => i.value), 'abcdefgh');
    assert.equal(await page.$eval('#hub-panel', (p) => p.classList.contains('hidden')), false, 'the Hub stays open');
    assert.deepEqual(errors, []);
  });
});
