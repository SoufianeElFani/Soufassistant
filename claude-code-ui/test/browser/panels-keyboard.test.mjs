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

  test('the vault passphrase stays above the keyboard and takes what is typed', async () => {
    await page.evaluate(() => import('./js/hub.js').then((m) => m.openHub('confidential')));
    await page.waitForSelector('#hub-panel input[type=password]', { timeout: 5000 });
    const field = await page.$('#hub-panel input[type=password]');
    const bb = await field.boundingBox();
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.keyboard.type('abcd');
    await page.setViewport(phone(420));            // the keyboard opens
    await page.waitForFunction(() => {
      const r = document.activeElement.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight - 8;
    }, { timeout: 3000 });
    await page.keyboard.type('efgh');
    assert.equal(await page.$eval('#hub-panel input[type=password]', (i) => i.value), 'abcdefgh');
    assert.equal(await page.$eval('#hub-panel', (p) => p.classList.contains('hidden')), false, 'the Hub stays open');
    assert.deepEqual(errors, []);
  });
});
