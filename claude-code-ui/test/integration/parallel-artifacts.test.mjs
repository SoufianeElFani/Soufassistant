/*
 * 0.5.0 end to end: several conversations running at once (runs.js), the
 * artifacts a reply produced remembered with its conversation, and the
 * document-preview endpoint.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { startServer, userLine } from '../helpers/server-harness.mjs';

describe('two conversations running at once', () => {
  let h, c;
  before(async () => {
    h = await startServer({
      scenario: { runs: [
        // Conversation "one": slow, so it is still running when "two" starts.
        { steps: [{ text: 'working on one' }, { sleep: 1500 }, { text: 'one done' }] },
        // Conversation "two": the test drops a file into the workspace meanwhile.
        { steps: [{ sleep: 400 }, { text: 'two done' }] },
      ] },
      sessions: {
        one: [userLine('First conversation')],
        two: [userLine('Second conversation')],
      },
      data: {
        'active-session.json': { sessionId: 'one' },
        'session-modes.json': { two: { mode: 'cowork', project: 'Proj' } },
      },
    });
    c = await h.connect();
    await c.waitFor('history');
  });
  after(async () => { await h.stop(); });

  test('switching away does not stop the run, and a prompt in the other one starts a second run', async () => {
    c.send({ type: 'prompt', text: 'go one', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'text' && m.text === 'working on one');

    c.send({ type: 'session_switch', id: 'two' });
    const hist = await c.waitFor((m) => m.type === 'history' && m.view === 'two');
    assert.equal(hist.running, false, 'the conversation switched to is idle');

    c.send({ type: 'prompt', text: 'go two', permissionMode: 'bypass' });
    mkdirSync(path.join(h.dataDir, 'workspace', 'Proj'), { recursive: true });
    writeFileSync(path.join(h.dataDir, 'workspace', 'Proj', 'report.md'), '# Report');

    const both = await c.waitFor((m) => m.type === 'runs' && m.runs.length === 2);
    assert.deepEqual(both.runs.map((r) => r.key).sort(), ['one', 'two']);

    const queries = h.records('query');
    assert.equal(queries.length, 2);
    assert.deepEqual(queries.map((q) => q.options.resume).sort(), ['one', 'two']);
  });

  test('only the conversation on screen streams into the transcript', async () => {
    await c.waitFor((m) => m.type === 'text' && m.text === 'two done');
    const finished = await c.waitFor((m) => m.type === 'run_finished' && m.key === 'one', { timeout: 8000 });
    assert.equal(finished.ok, true);
    assert.equal(c.all('text').some((m) => m.text === 'one done'), false,
      'a conversation not on screen leaked into the one that is');
    assert.equal(c.all('aborted').length, 0, 'nothing was stopped');
    await c.waitFor((m) => m.type === 'runs' && m.runs.length === 0);
  });

  test("a reply's files come back as its artifacts, and survive a reconnect", async () => {
    const art = await c.waitFor('turn_artifacts');
    assert.equal(art.sessionId, 'two');
    assert.deepEqual(art.files.map((f) => f.path), ['Proj/report.md']);

    const d = await h.connect();
    const hist = await d.waitFor('history');
    assert.equal(hist.view, 'two');
    assert.deepEqual(hist.artifacts.map((f) => f.path), ['Proj/report.md']);
    assert.ok(hist.artifacts[0].ts > 0, 'stamped with the reply that wrote it');

    // The Sessions list knows which conversations have artifacts, and which.
    const list = await d.waitFor('sessions');
    const two = list.sessions.find((s) => s.id === 'two');
    assert.equal(two.artifactCount, 1);
    assert.deepEqual(two.artifacts, [{ path: 'Proj/report.md', ext: 'md' }]);
  });

  test('a conversation shows its own artifacts, not the other one’s', async () => {
    c.send({ type: 'session_switch', id: 'one' });
    const hist = await c.waitFor((m) => m.type === 'history' && m.view === 'one');
    assert.deepEqual(hist.artifacts, []);
  });
});

describe('a new conversation running while another is opened', () => {
  let h, c;
  before(async () => {
    h = await startServer({
      scenario: { runs: [{ steps: [{ text: 'drafting' }, { sleep: 800 }, { text: 'draft done' }] }] },
      sessions: { old: [userLine('An old conversation')] },
    });
    c = await h.connect();
    await c.waitFor('history');
  });
  after(async () => { await h.stop(); });

  test('is filed under its real id once known, and finishing out of sight is announced', async () => {
    c.send({ type: 'prompt', text: 'start something new', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'text' && m.text === 'drafting');
    const runs = await c.waitFor((m) => m.type === 'runs' && m.runs.some((r) => r.sessionId));
    const run = runs.runs.find((r) => r.sessionId);
    assert.equal(run.key, run.sessionId, 're-keyed from its draft key');
    assert.equal(run.title, 'start something new');

    c.send({ type: 'session_switch', id: 'old' });
    await c.waitFor((m) => m.type === 'history' && m.view === 'old');
    const done = await c.waitFor((m) => m.type === 'run_finished', { timeout: 5000 });
    assert.equal(done.sessionId, run.sessionId);
    assert.equal(c.all('text').some((m) => m.text === 'draft done'), false);
  });
});

describe('stopping a conversation from the running list', () => {
  let h, c;
  before(async () => {
    h = await startServer({
      scenario: { runs: [{ steps: [{ text: 'long job' }, { sleep: 20000 }] }] },
      sessions: { a: [userLine('A')], b: [userLine('B')] },
      data: { 'active-session.json': { sessionId: 'a' } },
    });
    c = await h.connect();
    await c.waitFor('history');
  });
  after(async () => { await h.stop(); });

  test('abort with a key stops that one even when another is on screen', async () => {
    c.send({ type: 'prompt', text: 'run in a', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'text' && m.text === 'long job');
    c.send({ type: 'session_switch', id: 'b' });
    await c.waitFor((m) => m.type === 'history' && m.view === 'b');
    c.send({ type: 'abort', key: 'a' });
    const done = await c.waitFor((m) => m.type === 'run_finished' && m.key === 'a');
    assert.equal(done.aborted, true);
    await c.waitFor((m) => m.type === 'runs' && m.runs.length === 0);
  });
});

describe('document previews', () => {
  let h;
  before(async () => { h = await startServer({}); });
  after(async () => { await h.stop(); });

  test('refuse paths outside the workspace and kinds they cannot show', async () => {
    let res = await fetch(`${h.baseUrl}/api/preview?path=${encodeURIComponent('../../etc/passwd')}`);
    // Normalised into the workspace: a file that is not there, never /etc/passwd.
    let body = await res.json();
    assert.equal(body.ok, false);

    res = await fetch(`${h.baseUrl}/api/preview?path=`);
    assert.equal(res.status, 400);

    mkdirSync(path.join(h.dataDir, 'workspace'), { recursive: true });
    writeFileSync(path.join(h.dataDir, 'workspace', 'notes.txt'), 'hi');
    body = await (await fetch(`${h.baseUrl}/api/preview?path=notes.txt`)).json();
    assert.equal(body.ok, false);
    assert.match(body.error, /No document preview/);
  });

  test('say what this box can render', async () => {
    const caps = await (await fetch(`${h.baseUrl}/api/preview/capabilities`)).json();
    assert.equal(typeof caps.pdf, 'boolean');
    assert.equal(typeof caps.office, 'boolean');
  });

  test('serve only names they rendered', async () => {
    assert.equal((await fetch(`${h.baseUrl}/api/preview/0123456789abcdef0123/..%2Fmeta.json`)).status, 404);
    assert.equal((await fetch(`${h.baseUrl}/api/preview/nothex/page-1.png`)).status, 404);
  });
});
