/*
 * 0.4.0 end to end: conversation tools (rename, pin, search, export,
 * duplicate, changes + rewind), the workspace file editor, and the live
 * preview proxy.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';

describe('conversations', () => {
  let h;
  before(async () => {
    h = await startServer({
      sessions: {
        'sess-a': [
          userLine('Build the energy dashboard', { uuid: 'u-1' }),
          assistantLine([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/config/dash.html', content: '<h1>Energy</h1>' } }]),
          assistantLine([{ type: 'text', text: 'The dashboard shows the photovoltaic output.' }]),
        ],
        'sess-b': [userLine('Unrelated question about lights', { uuid: 'u-9' })],
      },
      data: { 'active-session.json': { sessionId: 'sess-a' } },
    });
  });
  after(async () => { await h.stop(); });

  test('rename and pin reorder and retitle the list', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'session_rename', id: 'sess-b', title: 'Lights' });
    c.send({ type: 'session_pin', id: 'sess-b', pinned: true });
    const m = await c.waitFor((x) => x.type === 'sessions' && x.sessions[0]?.id === 'sess-b' && x.sessions[0].pinned && x.sessions[0].title === 'Lights');
    assert.ok(m);
  });

  test('search finds text in replies, not only titles', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'session_search', q: 'photovoltaic' });
    const r = await c.waitFor('session_search_results');
    assert.deepEqual(r.results.map((x) => x.id), ['sess-a']);
    assert.match(r.results[0].snippet, /photovoltaic/);
  });

  test('export writes Markdown into the workspace', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'session_export', id: 'sess-a' });
    const r = await c.waitFor('session_export_result');
    assert.equal(r.ok, true);
    const file = path.join(h.dataDir, 'workspace', r.path);
    assert.match(readFileSync(file, 'utf8'), /Build the energy dashboard/);
  });

  test('duplicate makes a new conversation', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'session_duplicate', id: 'sess-a' });
    const r = await c.waitFor('session_duplicate_result');
    assert.equal(r.ok, true);
    assert.ok(existsSync(path.join(h.store, `${r.id}.jsonl`)));
    assert.equal(h.records('fork').at(-1).from, 'sess-a');
  });

  test('turns list the file changes, and a rewind resumes the session with checkpoints', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'turns_list', id: 'sess-a' });
    const t = await c.waitFor('turns');
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].uuid, 'u-1');
    assert.equal(t.turns[0].changes[0].file, '/config/dash.html');

    c.send({ type: 'rewind', id: 'sess-a', uuid: 'u-1', dryRun: true });
    const r = await c.waitFor('rewind_result');
    assert.equal(r.canRewind, true);
    const rec = h.records('rewind').at(-1);
    assert.deepEqual([rec.resume, rec.uuid, rec.dryRun, rec.checkpointing], ['sess-a', 'u-1', true, true]);
  });

  test('a code turn runs with file checkpointing on', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hi', permissionMode: 'bypass', mode: 'code' });
    await c.waitFor('result');
    assert.equal(h.records('query').at(-1).options.enableFileCheckpointing, true);
  });
});

describe('workspace editor', () => {
  let h;
  before(async () => { h = await startServer({}); });
  after(async () => { await h.stop(); });

  test('create, save, conflict, delete — and refuse escapes and binaries', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    const send = (m) => c.send({ type: 'workspace_write', reqId: 'x', ...m });

    send({ path: 'App/notes.md', content: '# hi', create: true });
    let r = await c.waitFor('workspace_write_result');
    assert.equal(r.ok, true);
    const mtime = r.mtime;

    c.messages.length = 0;
    send({ path: 'App/notes.md', content: '# again', create: true });
    r = await c.waitFor('workspace_write_result');
    assert.equal(r.ok, false, 'create does not overwrite');

    c.messages.length = 0;
    send({ path: 'App/notes.md', content: '# v2', mtime: mtime - 5000 });
    r = await c.waitFor('workspace_write_result');
    assert.equal(r.conflict, true);

    c.messages.length = 0;
    send({ path: 'App/notes.md', content: '# v2', mtime: mtime - 5000, force: true });
    r = await c.waitFor('workspace_write_result');
    assert.equal(r.ok, true);
    assert.equal(readFileSync(path.join(h.dataDir, 'workspace', 'App', 'notes.md'), 'utf8'), '# v2');

    for (const bad of ['../../etc/x.txt', 'App/photo.png', '.hidden/x.md']) {
      c.messages.length = 0;
      send({ path: bad, content: 'x', create: true });
      r = await c.waitFor('workspace_write_result');
      assert.equal(r.ok, false, bad);
    }

    c.messages.length = 0;
    c.send({ type: 'workspace_delete', path: 'App/notes.md' });
    r = await c.waitFor('workspace_delete_result');
    assert.equal(r.ok, true);
    assert.equal(existsSync(path.join(h.dataDir, 'workspace', 'App', 'notes.md')), false);
  });
});

describe('live preview proxy', () => {
  let h, app;
  const PORT = 8151;
  before(async () => {
    app = http.createServer((req, res) => {
      if (req.url === '/go') { res.writeHead(302, { location: '/landed' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-frame-options': 'DENY' });
      res.end(`app saw ${req.method} ${req.url} cookie=${req.headers.cookie || 'none'}`);
    });
    await new Promise((r) => app.listen(PORT, '127.0.0.1', r));
    h = await startServer({});
  });
  after(async () => { await h.stop(); await new Promise((r) => app.close(r)); });

  test('proxies to the app with CORS, without cookies or frame blocking', async () => {
    const res = await fetch(`${h.baseUrl}/preview/${PORT}/api/x?y=1`, { headers: { cookie: 'ingress_session=secret' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.equal(await res.text(), 'app saw GET /api/x?y=1 cookie=none');
  });

  test('keeps redirects inside /preview/<port>/', async () => {
    const res = await fetch(`${h.baseUrl}/preview/${PORT}/go`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), `/preview/${PORT}/landed`);
  });

  test('refuses ports outside the preview range, and lists the running one', async () => {
    const res = await fetch(`${h.baseUrl}/preview/7681/`);
    assert.equal(res.status, 404);
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'previews_list' });
    const m = await c.waitFor('previews');
    assert.ok(m.previews.some((p) => p.port === PORT));
  });
});
