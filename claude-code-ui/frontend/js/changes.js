/*
 * The Changes panel (server: session-tools.js listTurns / rewindTo).
 *
 * One entry per message you sent in a conversation, newest first, with the
 * files Claude changed while answering it (expand for a before/after view of
 * each edit) and "Restore files to before this message": a dry run shows what
 * would change, then a confirmation runs the real rewind (SDK file
 * checkpoints). Changes made through shell commands are not tracked.
 */
import { registerPanel } from './panels.js';
import { S } from './state.js';
import { changesPanel, changesTitle, changesList, changesClose, changesOpenBtn, sessionsPanel, sessionsBtn } from './dom.js';
import { confirmAction } from './confirm.js';

let current = { id: null, title: '', turns: [] };
const expanded = new Set();

function send(msg) {
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify(msg));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Lines for a change, each { sign: '-'|'+'|' ', text }. Exported for tests. */
export function changeLines(change, maxLines = 80) {
  const out = [];
  if (change.tool === 'Write') {
    for (const l of String(change.content || '').split('\n').slice(0, maxLines)) out.push({ sign: '+', text: l });
  } else {
    for (const e of change.edits || []) {
      for (const l of String(e.old).split('\n')) out.push({ sign: '-', text: l });
      for (const l of String(e.new).split('\n')) out.push({ sign: '+', text: l });
      out.push({ sign: ' ', text: '' });
    }
  }
  return out.length > maxLines ? [...out.slice(0, maxLines), { sign: ' ', text: `… ${out.length - maxLines} more lines` }] : out;
}

function shortPath(p) {
  const parts = String(p).split('/');
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}

function render() {
  changesTitle.textContent = current.title ? `Changes — ${current.title}` : 'Changes';
  changesList.innerHTML = '';
  if (!current.id) {
    changesList.appendChild(el('div', 'sessions-empty', 'Open a conversation first.'));
    return;
  }
  const turns = [...current.turns].reverse();
  if (!turns.length) {
    changesList.appendChild(el('div', 'sessions-empty', 'No messages yet.'));
    return;
  }
  for (const t of turns) {
    const box = el('div', 'change-turn');
    const head = el('div', 'change-head');
    const files = [...new Set(t.changes.map((c) => c.file))];
    head.append(
      el('div', 'change-prompt', t.text.replace(/\s+/g, ' ')),
      el('div', 'session-time', `${t.ts ? new Date(t.ts).toLocaleString() : ''}${files.length ? ` · ${files.length} file${files.length > 1 ? 's' : ''} changed` : ' · no file changes'}`),
    );
    box.appendChild(head);
    if (files.length) {
      head.classList.add('clickable');
      head.title = 'Show the changes';
      head.onclick = () => { expanded.has(t.uuid) ? expanded.delete(t.uuid) : expanded.add(t.uuid); render(); };
    }
    if (expanded.has(t.uuid)) {
      for (const c of t.changes) {
        const f = el('div', 'change-file');
        f.appendChild(el('div', 'change-file-name', `${c.tool} · ${shortPath(c.file)}`));
        const pre = el('pre', 'change-diff');
        for (const l of changeLines(c)) {
          const line = el('span', `diff-${l.sign === '-' ? 'del' : l.sign === '+' ? 'add' : 'ctx'}`, `${l.sign} ${l.text}\n`);
          pre.appendChild(line);
        }
        f.appendChild(pre);
        box.appendChild(f);
      }
    }
    const restore = el('button', 'scheduled-new-btn change-restore', '↶ Restore files to before this message');
    restore.type = 'button';
    restore.onclick = () => send({ type: 'rewind', id: current.id, uuid: t.uuid, dryRun: true });
    box.appendChild(restore);
    changesList.appendChild(box);
  }
}

export function openChanges(id = S.activeSessionId, title = '') {
  const s = S.sessions.find((x) => x.id === id);
  current = { id, title: title || s?.title || '', turns: [] };
  expanded.clear();
  render();
  changesPanel.classList.remove('hidden');
  if (id) send({ type: 'turns_list', id });
}

export function closeChanges() {
  changesPanel.classList.add('hidden');
}

export function applyTurns(msg) {
  if (msg.id !== current.id) return;
  current.turns = Array.isArray(msg.turns) ? msg.turns : [];
  if (!changesPanel.classList.contains('hidden')) render();
}

export async function applyRewindResult(msg) {
  if (msg.dryRun) {
    if (!msg.canRewind) { alert(`Cannot restore: ${msg.error || 'no recorded changes from that point (older conversations were not checkpointed).'}`); return; }
    const files = msg.filesChanged || [];
    if (!files.length) { alert('Nothing to restore — the files are already as they were before that message.'); return; }
    const ok = await confirmAction({
      title: 'Restore these files?',
      body: `${files.length} file${files.length > 1 ? 's' : ''} will go back to how ${files.length > 1 ? 'they were' : 'it was'} just before that message`
        + ` (+${msg.insertions ?? 0} / −${msg.deletions ?? 0} lines):\n${files.map(shortPath).join('\n')}`,
      confirm: 'Restore',
      cancel: 'Cancel',
    });
    if (ok) send({ type: 'rewind', id: msg.id, uuid: msg.uuid, dryRun: false });
  } else if (msg.canRewind) {
    alert('Files restored.');
    send({ type: 'turns_list', id: current.id });
  } else {
    alert(`Restore failed: ${msg.error || 'unknown error'}`);
  }
}

changesClose.onclick = closeChanges;
changesOpenBtn.onclick = (e) => {
  e.stopPropagation();
  sessionsPanel.classList.add('hidden');
  sessionsBtn.classList.remove('active');
  openChanges();
};
document.addEventListener('click', (e) => {
  // A click that re-rendered the panel leaves its target detached — it was
  // still inside, so it must not count as a click outside.
  if (!e.target.isConnected) return;
  if (changesPanel.classList.contains('hidden')) return;
  if (changesPanel.contains(e.target) || e.target.closest?.('.session-menu') || e.target === changesOpenBtn) return;
  if (document.querySelector('#confirm-overlay:not(.hidden)')) return;
  closeChanges();
});

registerPanel(changesPanel, closeChanges);
