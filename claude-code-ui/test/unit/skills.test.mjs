/*
 * The Skills panel's backend (server/lib/skills.js) and the .zip export (zip.js).
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const { parseSkillMd, buildSkillMd, sanitizeSkillName, discoverSkills, invocationName, disabledOverrides } =
  await import('../../server/lib/skills.js');
const { makeZip, crc32 } = await import('../../server/lib/zip.js');

describe('parseSkillMd', () => {
  test('reads quoted, plain and folded front matter', () => {
    const { meta, body } = parseSkillMd('---\nname: pptx\ndescription: "Use it \\"always\\""\nlicense: MIT\nnote: >\n  folded\n  text\n---\n\n# Body\n');
    assert.equal(meta.name, 'pptx');
    assert.equal(meta.description, 'Use it "always"');
    assert.equal(meta.note, 'folded text');
    assert.equal(body.trim(), '# Body');
  });

  test('no front matter = all body', () => {
    assert.deepEqual(parseSkillMd('# just text'), { meta: {}, body: '# just text' });
  });

  test('buildSkillMd round-trips through parseSkillMd', () => {
    const md = buildSkillMd({ name: 'weekly-report', description: 'Use when: "weekly" report\nplease', body: '1. do it' });
    const { meta, body } = parseSkillMd(md);
    assert.equal(meta.name, 'weekly-report');
    assert.equal(meta.description, 'Use when: "weekly" report please');
    assert.equal(body.trim(), '1. do it');
  });
});

test('sanitizeSkillName', () => {
  assert.equal(sanitizeSkillName('  Weekly Energy Report! '), 'weekly-energy-report');
  assert.equal(sanitizeSkillName('---'), null);
  assert.equal(sanitizeSkillName('x'.repeat(65)), null);
});

describe('discoverSkills / overrides', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  const user = path.join(root, 'skills');
  const write = (dir, name, desc) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody`); };
  write(path.join(user, 'synced', 'bucket1', 'pptx'), 'pptx', 'slides');
  writeFileSync(path.join(user, 'synced', 'bucket1', 'manifest.json'), JSON.stringify({ lastUpdated: 1234 }));
  write(path.join(user, 'my-skill'), 'my-skill', 'mine');
  const plugin = path.join(root, 'plug');
  mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ha-config' }));
  write(path.join(plugin, 'skills', 'yaml'), 'yaml', 'yaml help');

  const { skills, lastSync } = discoverSkills({ userDir: user, plugins: [{ path: plugin }] });

  test('finds account, plugin and local skills', () => {
    assert.deepEqual(skills.map((s) => [s.source, s.name, s.editable]),
      [['account', 'pptx', false], ['plugin', 'yaml', false], ['local', 'my-skill', true]]);
    assert.equal(lastSync, 1234);
    assert.equal(skills[1].plugin, 'ha-config');
  });

  test('invocation names follow what the CLI reported', () => {
    assert.equal(invocationName(skills[0], ['anthropic-skills:pptx', 'compact']), 'anthropic-skills:pptx');
    assert.equal(invocationName(skills[1], ['ha-config:yaml']), 'ha-config:yaml');
    assert.equal(invocationName(skills[2], []), 'my-skill');
  });

  test('disabledOverrides keys both names, and is null when nothing is off', () => {
    assert.equal(disabledOverrides(skills, new Set(), []), null);
    assert.deepEqual(disabledOverrides(skills, new Set([skills[0].id]), ['anthropic-skills:pptx']),
      { pptx: 'off', 'anthropic-skills:pptx': 'off' });
  });
});

describe('makeZip', () => {
  test('crc32 of a known string', () => {
    assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });

  test('produces a zip that unzips to the same files', { skip: !existsSync('/usr/bin/python3') && 'needs python3' }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
    const zipPath = path.join(dir, 'a.zip');
    writeFileSync(zipPath, makeZip([{ name: 'skill/SKILL.md', data: Buffer.from('# hé') }, { name: 'skill/ref/x.txt', data: Buffer.from('x') }]));
    execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zipPath, dir]);
    assert.equal(readFileSync(path.join(dir, 'skill', 'SKILL.md'), 'utf8'), '# hé');
    assert.equal(readFileSync(path.join(dir, 'skill', 'ref', 'x.txt'), 'utf8'), 'x');
  });
});
