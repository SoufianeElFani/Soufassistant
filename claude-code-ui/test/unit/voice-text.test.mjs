/*
 * What the spoken conversation reads aloud (frontend/js/voice.js speakable)
 * and where streaming freezes a reply's settled part (transcript.js
 * settledEnd) — the two pure functions behind 0.7.0's voice and streaming.
 * Both modules touch the DOM at load, so the functions are pulled out of the
 * source text rather than imported.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

function extract(file, name) {
  const src = readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8');
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found in ${file}`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  const body = src.slice(start, i + 1).replace(/^export /, '');
  return new Function(`${body}; return ${name};`)();
}

const speakable = extract('voice.js', 'speakable');
const settledEnd = extract('transcript.js', 'settledEnd');

describe('speakable', () => {
  test('drops markdown, code, links and tables', () => {
    const md = '## Résumé\n\n**Bonjour**, voici [le lien](https://x.y) :\n\n- un\n- deux\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n\nVoir `light.salon` sur https://ha.local.';
    const out = speakable(md);
    assert.doesNotMatch(out, /[#*`|]|https?:/);
    assert.match(out, /Résumé/);
    assert.match(out, /Bonjour, voici le lien/);
    assert.match(out, /\(code omitted\)/);
    assert.match(out, /light\.salon/);
  });
  test('empty in, empty out', () => assert.equal(speakable(''), ''));
});

describe('settledEnd', () => {
  test('cuts after the last blank line', () => {
    const t = 'one\n\ntwo\n\nthr';
    assert.equal(t.slice(0, settledEnd(t)), 'one\n\ntwo\n\n');
  });
  test('never inside a code block', () => {
    const t = 'intro\n\n```\na\n\nb';
    assert.equal(t.slice(0, settledEnd(t)), 'intro\n\n');
    const closed = 'intro\n\n```\na\n\nb\n```\n\nafter';
    assert.equal(closed.slice(0, settledEnd(closed)), 'intro\n\n```\na\n\nb\n```\n\n');
  });
  test('nothing settled yet', () => assert.equal(settledEnd('just one paragraph'), 0));
  test('continues from where it last cut', () => {
    const t = 'one\n\ntwo';
    assert.equal(settledEnd(t, 5), 5);
  });
});
