/*
 * Image generation (server/lib/image-gen.js): naming, the request URL, and the
 * download against a local fake of the image service.
 */
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
let server, base, lastUrl;
before(async () => {
  server = http.createServer((req, res) => {
    lastUrl = req.url;
    if (req.url.includes('broken')) { res.writeHead(500); return res.end('nope'); }
    if (req.url.includes('html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<p>hi</p>'); }
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.IMAGE_GEN_URL = base;
});
after(() => server.close());

const { imageBaseName, imageUrl, generateImage, imageMcpServer, IMAGE_TOOL } = await import('../../server/lib/image-gen.js');

describe('image generation', () => {
  test('file names follow the workspace convention', () => {
    const d = new Date('2026-10-26T10:00:00Z');
    assert.equal(imageBaseName('A red lighthouse on a cliff, watercolour, at dusk', d), '2026-10-26_a-red-lighthouse-on-a-cliff');
    assert.equal(imageBaseName('Équipe énergie', d), '2026-10-26_equipe-energie');
    assert.equal(imageBaseName('', d, 'Logo idée'), '2026-10-26_logo-idee');
    assert.equal(imageBaseName('!!!', d), '2026-10-26_image');
  });

  test('the request carries prompt, size and seed', () => {
    const u = new URL(imageUrl({ prompt: 'a cat & a dog', width: 512, height: 768, seed: 7 }));
    assert.equal(decodeURIComponent(u.pathname), '/prompt/a cat & a dog');
    assert.equal(u.searchParams.get('width'), '512');
    assert.equal(u.searchParams.get('height'), '768');
    assert.equal(u.searchParams.get('seed'), '7');
  });

  test('saves the image under the target folder, never overwriting', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'img-')), 'Images');
    const now = new Date('2026-10-26T10:00:00Z');
    const a = await generateImage({ prompt: 'a small house' }, { dir, now });
    const b = await generateImage({ prompt: 'a small house' }, { dir, now });
    assert.equal(a.name, '2026-10-26_a-small-house.png');
    assert.equal(b.name, '2026-10-26_a-small-house-2.png');
    assert.deepEqual(readFileSync(a.abs), PNG);
    assert.ok(lastUrl.startsWith('/prompt/a%20small%20house'));
  });

  test('a failing or non-image answer is an error, and nothing is saved', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'img-')), 'Images');
    await assert.rejects(generateImage({ prompt: 'broken please' }, { dir }), /HTTP 500/);
    await assert.rejects(generateImage({ prompt: 'html please' }, { dir }), /not an image/);
    assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, 'nothing saved');
  });

  test('the tool reports the saved path to Claude and the file to the run', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'img-')), 'Images');
    const saved = [];
    const srv = imageMcpServer({ targetDir: () => dir, onSaved: (p) => saved.push(p) });
    assert.equal(IMAGE_TOOL, 'mcp__soufassistant__generate_image');
    const t = srv.tools.find((x) => x.name === 'generate_image');
    const ok = await t.handler({ prompt: 'a blue door' });
    assert.ok(!ok.isError && /Image saved: .*a-blue-door\.png/.test(ok.content[0].text));
    assert.equal(saved.length, 1);
    const bad = await t.handler({ prompt: 'broken door' });
    assert.ok(bad.isError && /HTTP 500/.test(bad.content[0].text));
  });
});
