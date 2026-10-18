/*
 * lib/ha-args — the global flags that ha-ws-client accepted anywhere in argv,
 * and the rule that a flag a command does not declare is an error rather than
 * silently ignored.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseArgs, parseFlexibleDate, UsageError } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'lib', 'ha-args.cjs'));

describe('parseArgs', () => {
  test('global flags work before, between and after positionals', () => {
    for (const argv of [['--json', 'a', 'b'], ['a', '--json', 'b'], ['a', 'b', '--json']]) {
      const r = parseArgs(argv);
      assert.deepEqual(r.pos, ['a', 'b']);
      assert.equal(r.opt.fmt, 'json');
    }
  });
  test('--json and --compact win over --format', () => {
    assert.equal(parseArgs(['--format', 'compact', '--json']).opt.fmt, 'json');
    assert.equal(parseArgs(['--output', 'json', '--compact']).opt.fmt, 'compact');
    assert.equal(parseArgs(['--format', 'text']).opt.fmt, 'default');
    assert.equal(parseArgs([]).opt.fmt, 'default');
  });
  test('value flags take the next argument or =value', () => {
    assert.equal(parseArgs(['--max-items', '5']).opt.maxItems, 5);
    assert.equal(parseArgs(['--max-items=5']).opt.maxItems, 5);
    assert.equal(parseArgs(['--from', '2026-10-17']).opt.from, '2026-10-17');
  });
  test('a command\'s own flags are accepted; undeclared ones are rejected', () => {
    assert.equal(parseArgs(['--domain', 'script'], { domain: 'string' }).opt.domain, 'script');
    assert.equal(parseArgs(['--no-follow'], { 'no-follow': 'bool' }).opt.noFollow, true);
    assert.throws(() => parseArgs(['--domain', 'script']), UsageError);
    assert.throws(() => parseArgs(['--bogus']), /unknown option: --bogus/);
  });
  test('bad values are usage errors, not NaN', () => {
    assert.throws(() => parseArgs(['--max-items', 'lots']), /whole number/);
    assert.throws(() => parseArgs(['--max-items']), /needs a value/);
    assert.throws(() => parseArgs(['--format', 'yaml']), /invalid --format/);
  });
  test('-h and --help are reported, not treated as positionals', () => {
    assert.equal(parseArgs(['x', '--help']).help, true);
    assert.deepEqual(parseArgs(['x', '-h']).pos, ['x']);
  });
  test('-- ends flag parsing', () => {
    assert.deepEqual(parseArgs(['--', '--json']).pos, ['--json']);
  });
});

describe('parseFlexibleDate', () => {
  test('reads the formats ha-ws-client did, as UTC', () => {
    assert.equal(parseFlexibleDate('2026-10-17').toISOString(), '2026-10-17T00:00:00.000Z');
    assert.equal(parseFlexibleDate('2026-10-17 12:30').toISOString(), '2026-10-17T12:30:00.000Z');
    assert.equal(parseFlexibleDate('2026-10-17T12:30:15').toISOString(), '2026-10-17T12:30:15.000Z');
    assert.equal(parseFlexibleDate('2026-10-17T12:30:15+01:00').toISOString(), '2026-10-17T11:30:15.000Z');
  });
  test('rejects nonsense', () => {
    assert.throws(() => parseFlexibleDate('yesterday'), UsageError);
  });
});
