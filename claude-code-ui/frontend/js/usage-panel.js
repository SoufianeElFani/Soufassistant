/*
 * The Usage panel — a permanently-available header button showing this
 * session's running token/cost totals (S.usage, accumulated from 'result'
 * events — see connection.js and transcript.js). This is the same data
 * `/usage` has always printed as a text block; the panel just makes it
 * visible at a glance without typing a command, and stays live as the
 * numbers change.
 *
 * This is session-scoped, not an Anthropic account-wide billing dashboard —
 * subscription auth does not expose that kind of account-level usage data,
 * so showing anything claiming to be "your account's total spend" here
 * would be dishonest. See CLAUDE.md's Usage panel note.
 */
import { S } from './state.js';
import { usageBtn, usagePanel, usageBodyEl } from './dom.js';

function row(label, value) {
  const r = document.createElement('div');
  r.className = 'usage-row';
  const l = document.createElement('span');
  l.className = 'usage-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'usage-value';
  v.textContent = value;
  r.append(l, v);
  return r;
}

export function renderUsage() {
  usageBodyEl.innerHTML = '';
  const u = S.usage;
  const totalTokens = u.inputTokens + u.outputTokens;
  usageBodyEl.append(
    row('Messages', u.messages.toLocaleString()),
    row('Turns', u.turns.toLocaleString()),
    row('Input tokens', u.inputTokens.toLocaleString()),
    row('Output tokens', u.outputTokens.toLocaleString()),
    row('Cache read', u.cacheReadTokens.toLocaleString()),
    row('Cache write', u.cacheWriteTokens.toLocaleString()),
    row('Total tokens', totalTokens.toLocaleString()),
    row('Estimated cost', `$${u.cost.toFixed(4)}`),
  );
  const note = document.createElement('div');
  note.className = 'usage-note';
  note.textContent = 'This session only — resets on New chat. Not your Anthropic account’s overall usage.';
  usageBodyEl.appendChild(note);
}

export function openUsage() {
  renderUsage();
  usagePanel.classList.remove('hidden');
  usageBtn.classList.add('active');
}
export function closeUsage() {
  usagePanel.classList.add('hidden');
  usageBtn.classList.remove('active');
}

usageBtn.onclick = (e) => {
  e.stopPropagation();
  if (usagePanel.classList.contains('hidden')) openUsage();
  else closeUsage();
};

document.addEventListener('click', (e) => {
  if (usagePanel.classList.contains('hidden')) return;
  if (usagePanel.contains(e.target) || usageBtn.contains(e.target)) return;
  closeUsage();
});
