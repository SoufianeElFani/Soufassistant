import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { attributeArtifacts, mentionScore, addEvidence } from '../../server/lib/artifact-attribution.js';

const e = (p, mtime) => ({ path: p, name: p.split('/').pop(), mtime });
const run = (startedAt, endedAt, { written = [], evidence = '' } = {}) =>
  ({ startedAt, endedAt, written: new Set(written), evidence });

describe('attributeArtifacts (parallel conversations)', () => {
  test('alone, a run claims everything changed while it ran', () => {
    const r = attributeArtifacts(run(1000_000, 1100_000), [], [e('a.md', 1050_000), e('old.md', 10)]);
    assert.deepEqual(r.claimed.map((f) => f.path), ['a.md']);
  });

  test("never another run's file-tool writes, even inside its own window", () => {
    const other = run(1000_000, null, { written: ['B/deck.pptx'] });
    const r = attributeArtifacts(run(1000_000, 1100_000), [other], [e('B/deck.pptx', 1050_000)], { now: 1100_000 });
    assert.deepEqual(r.claimed, []);
  });

  test('its own file-tool writes, whatever the others did', () => {
    const other = run(1000_000, null);
    const r = attributeArtifacts(run(1000_000, 1100_000, { written: ['A/x.md'] }), [other], [e('A/x.md', 1050_000)], { now: 1100_000 });
    assert.deepEqual(r.claimed.map((f) => f.path), ['A/x.md']);
  });

  test('overlapping shell writes go to the run that names them; unnamed ones to no one', () => {
    const a = run(1000_000, 1100_000, { evidence: 'python build.py -o A/slides.pptx' });
    const b = run(1010_000, null, { evidence: 'pandoc -o report.md' });
    const files = [e('A/slides.pptx', 1050_000), e('B/report.md', 1050_000), e('B/mystery.txt', 1050_000)];
    const ra = attributeArtifacts(a, [b], files, { now: 1100_000 });
    const rb = attributeArtifacts(b, [a], files, { now: 1100_000 });
    assert.deepEqual(ra.claimed.map((f) => f.path), ['A/slides.pptx']);
    assert.deepEqual(rb.claimed.map((f) => f.path), ['B/report.md']);
    assert.deepEqual(ra.contested.map((f) => f.path), ['B/mystery.txt']);
  });

  test('a finished run still competes for what changed while it ran, not after', () => {
    const done = run(1000_000, 1020_000);
    const later = run(1010_000, 1100_000);
    const r = attributeArtifacts(later, [done], [e('x.md', 1015_000), e('y.md', 1060_000)], { now: 1100_000 });
    assert.deepEqual(r.claimed.map((f) => f.path), ['y.md']);
  });

  test('mentions: file name beats folder; evidence stays bounded', () => {
    assert.equal(mentionScore({ evidence: 'ls 03_Travail/Projet' }, '03_Travail/Projet/a.docx'), 1);
    assert.equal(mentionScore({ evidence: 'cp a.docx x' }, '03_Travail/Projet/a.docx'), 2);
    const r = {};
    for (let i = 0; i < 50; i++) addEvidence(r, 'x'.repeat(10000));
    assert.ok(r.evidence.length <= 200000);
  });
});
