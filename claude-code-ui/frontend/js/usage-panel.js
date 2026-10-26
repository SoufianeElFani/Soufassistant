/*
 * The Usage panel — a permanently-available header button with two sections:
 *
 *   1. Plan limits (S.planUsage, from the server's 'plan_usage' message — see
 *      server/lib/plan-usage.js): the claude.ai subscription meters Claude
 *      Desktop shows — the 5-hour session window, the weekly window(s), and
 *      the monthly extra-usage budget when enabled — each with a bar and a
 *      "resets in …" countdown. The header button carries the session % so
 *      it is visible without opening the panel.
 *
 *   2. This conversation (S.usage, accumulated from 'result' events): token
 *      and cost totals, resetting on New chat — the same data /usage prints.
 */
import { registerPanel } from './panels.js';
import { S } from './state.js';
import { usageBtn, usagePanel, usageBodyEl } from './dom.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(label, value) {
  const r = el('div', 'usage-row');
  r.append(el('span', 'usage-label', label), el('span', 'usage-value', value));
  return r;
}

/** "2 h 14 min", "3 d 5 h", "< 1 min" — exported for tests. */
export function formatCountdown(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms <= 60000) return '< 1 min';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min`;
}

function formatResetAt(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** Bar colour band: normal < 75 % ≤ warn < 90 % ≤ high. Exported for tests. */
export function severity(p) {
  if (p == null) return 'normal';
  return p >= 90 ? 'high' : p >= 75 ? 'warn' : 'normal';
}

function meter(label, utilization, resetsAt) {
  const box = el('div', 'plan-meter');
  const head = el('div', 'plan-meter-head');
  head.append(el('span', 'plan-meter-label', label),
    el('span', 'plan-meter-pct', utilization == null ? '—' : `${Math.round(utilization)} %`));
  const bar = el('div', `plan-bar plan-bar-${severity(utilization)}`);
  const fill = el('div', 'plan-bar-fill');
  fill.style.width = `${utilization ?? 0}%`;
  bar.appendChild(fill);
  box.append(head, bar);
  if (resetsAt) {
    const left = resetsAt - Date.now();
    box.appendChild(el('div', 'plan-meter-reset',
      left > 0 ? `Resets in ${formatCountdown(left)} · ${formatResetAt(resetsAt)}` : 'Resetting…'));
  }
  return box;
}

function renderPlan(container) {
  const p = S.planUsage;
  container.appendChild(el('div', 'usage-section-title', p?.plan ? `Plan limits · ${p.plan.toUpperCase()}` : 'Plan limits'));
  if (!p) { container.appendChild(el('div', 'usage-note', 'Loading…')); return; }
  if (!p.available) {
    container.appendChild(el('div', 'usage-note',
      'Plan limits are not available (API-key login, or the account did not report them).'));
    return;
  }
  const session = p.windows.filter((w) => w.group === 'session');
  const weekly = p.windows.filter((w) => w.group === 'weekly');
  for (const w of [...session, ...weekly]) container.appendChild(meter(w.label, w.utilization, w.resetsAt));

  const ex = p.extra;
  if (ex?.enabled) {
    const cur = ex.currency ? ` ${ex.currency}` : '';
    const label = ex.monthlyLimit != null
      ? `Extra usage — month (${ex.used ?? 0} / ${ex.monthlyLimit}${cur})`
      : 'Extra usage — month';
    container.appendChild(meter(label, ex.utilization, null));
  } else {
    container.appendChild(row('Extra usage (monthly)', 'Off'));
  }
  const age = Math.round((Date.now() - (p.fetchedAt || Date.now())) / 60000);
  container.appendChild(el('div', 'usage-note',
    `Updated ${age <= 0 ? 'just now' : `${age} min ago`} · refreshes after each reply and every 5 min.`));
}

function renderSession(container) {
  const u = S.usage;
  container.appendChild(el('div', 'usage-section-title', 'This conversation'));
  container.append(
    row('Turns', u.turns.toLocaleString()),
    row('Input tokens', u.inputTokens.toLocaleString()),
    row('Output tokens', u.outputTokens.toLocaleString()),
    row('Cache read / write', `${u.cacheReadTokens.toLocaleString()} / ${u.cacheWriteTokens.toLocaleString()}`),
    row('Equivalent API cost', `$${u.cost.toFixed(4)}`),
  );
  container.appendChild(el('div', 'usage-note', 'Resets on New chat. Included in your plan — not billed separately.'));
}

/** Header badge: the session-window %, coloured by severity. */
export function renderUsageBadge() {
  let badge = usageBtn.querySelector('.usage-badge');
  const s = S.planUsage?.windows?.find((w) => w.key === 'five_hour');
  if (!s || s.utilization == null) { badge?.remove(); return; }
  if (!badge) { badge = el('span', 'usage-badge'); usageBtn.appendChild(badge); }
  badge.textContent = `${Math.round(s.utilization)}%`;
  badge.className = `usage-badge usage-badge-${severity(s.utilization)}`;
  usageBtn.title = `Session ${Math.round(s.utilization)} % used` +
    (s.resetsAt ? ` — resets in ${formatCountdown(s.resetsAt - Date.now())}` : '');
}

export function renderUsage() {
  usageBodyEl.innerHTML = '';
  renderPlan(usageBodyEl);
  usageBodyEl.appendChild(el('div', 'usage-divider'));
  renderSession(usageBodyEl);
  renderUsageBadge();
}

let tick = null;
export function openUsage() {
  renderUsage();
  usagePanel.classList.remove('hidden');
  usageBtn.classList.add('active');
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify({ type: 'plan_usage_refresh' }));
  clearInterval(tick);
  tick = setInterval(renderUsage, 30000);   // keep the countdowns honest while open
}
export function closeUsage() {
  usagePanel.classList.add('hidden');
  usageBtn.classList.remove('active');
  clearInterval(tick);
  tick = null;
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

// The badge tooltip's countdown drifts too; refresh it once a minute.
setInterval(renderUsageBadge, 60000);

registerPanel(usagePanel, closeUsage);
