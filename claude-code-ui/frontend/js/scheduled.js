/*
 * The Scheduled-tasks panel — persisted cron-like prompts (server/lib/scheduler.js).
 * Each entry fires its own unattended turn; it does not touch the active chat
 * (see that module's header comment), so this panel only shows the list, a
 * last-run summary, and a small add/edit form — nothing here talks to the
 * transcript.
 */
import { registerPanel } from './panels.js';
import { S } from './state.js';
import { confirmAction } from './confirm.js';
import {
  scheduledBtn, scheduledPanel, scheduledListEl, scheduledNewBtn, scheduledForm,
  scheduledNameInput, scheduledCronInput, scheduledPromptInput, scheduledFormError,
  scheduledFormCancel, scheduledFormSave,
} from './dom.js';

function relTime(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_LABEL = { running: '⏳ running', success: '✅ ok', error: '⚠️ failed', timeout: '⌛ timed out' };

function send(msg) { if (S.ws && S.isConnected) S.ws.send(JSON.stringify(msg)); }

export function renderScheduled() {
  scheduledListEl.innerHTML = '';
  if (!S.scheduled.length) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = 'No scheduled tasks yet.';
    scheduledListEl.appendChild(empty);
    return;
  }
  for (const t of S.scheduled) {
    const row = document.createElement('div');
    row.className = 'session-item scheduled-item';

    const main = document.createElement('div');
    main.className = 'session-main';
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = `${t.enabled ? '' : '⏸ '}${t.name}`;
    const meta = document.createElement('div');
    meta.className = 'session-time';
    const statusTxt = t.lastStatus ? `${STATUS_LABEL[t.lastStatus] || t.lastStatus} · ${relTime(t.lastRunAt)}` : 'never run';
    meta.textContent = `${t.cron} — ${statusTxt}`;
    main.append(title, meta);
    if (t.lastSummary) {
      const summary = document.createElement('div');
      summary.className = 'scheduled-summary';
      summary.textContent = t.lastSummary;
      main.appendChild(summary);
    }

    const actions = document.createElement('div');
    actions.className = 'scheduled-actions';

    const runBtn = document.createElement('button');
    runBtn.className = 'session-del scheduled-action-btn';
    runBtn.textContent = '▶';
    runBtn.title = 'Run now';
    runBtn.onclick = (e) => { e.stopPropagation(); send({ type: 'run_scheduled_now', id: t.id }); };

    const editBtn = document.createElement('button');
    editBtn.className = 'session-del scheduled-action-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit';
    editBtn.onclick = (e) => { e.stopPropagation(); openForm(t); };

    const delBtn = document.createElement('button');
    delBtn.className = 'session-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmAction({
        title: 'Delete this scheduled task?', body: `"${t.name}" will stop running. This cannot be undone.`,
        confirm: 'Delete', cancel: 'Keep it',
      });
      if (ok) send({ type: 'delete_scheduled', id: t.id });
    };

    actions.append(runBtn, editBtn, delBtn);
    row.append(main, actions);
    scheduledListEl.appendChild(row);
  }
}

function openForm(entry) {
  S.scheduledEditingId = entry?.id || null;
  scheduledNameInput.value = entry?.name || '';
  scheduledCronInput.value = entry?.cron || '';
  scheduledPromptInput.value = entry?.prompt || '';
  scheduledFormError.classList.add('hidden');
  scheduledForm.classList.remove('hidden');
  scheduledNameInput.focus();
}
function closeForm() {
  scheduledForm.classList.add('hidden');
  S.scheduledEditingId = null;
}

scheduledNewBtn.onclick = () => openForm(null);

// A morning briefing (like Perplexity / Grok daily digests): a preset to adjust.
const BRIEFING_PROMPT = [
  'Veille du matin. Sujets suivis : [à adapter : efficacité énergétique et énergie en Belgique, smart building et GTB/BMS,',
  'IoT et plateformes de données pour les bâtiments, concurrents et partenaires, appels d\'offres publics du secteur].',
  '1) Pour chaque sujet, cherche sur le web les nouvelles des dernières 24 h (le lundi : depuis vendredi), sources fiables',
  '(FR, NL, EN), sans doublons.',
  '2) Écris le briefing dans le workspace : Veille/AAAA-MM-JJ_Veille.md — 5 à 10 points, chacun en deux lignes avec la',
  'source et le lien, puis « À surveiller » et « Idées d\'action ».',
  '3) Ta réponse finale part en notification sur le téléphone : les 3 points les plus importants, 250 caractères maximum.',
].join(' ');
const briefingBtn = document.createElement('button');
briefingBtn.type = 'button';
briefingBtn.className = 'scheduled-new-btn';
briefingBtn.textContent = '+ Briefing';
briefingBtn.title = 'A daily briefing on the topics you follow, as a notification and a file';
briefingBtn.onclick = () => openForm({ name: 'Veille du matin', cron: '30 7 * * 1-5', prompt: BRIEFING_PROMPT });
scheduledNewBtn.before(briefingBtn);
scheduledFormCancel.onclick = () => closeForm();

scheduledForm.onsubmit = (e) => {
  e.preventDefault();
  const name = scheduledNameInput.value.trim();
  const cron = scheduledCronInput.value.trim();
  const prompt = scheduledPromptInput.value.trim();
  if (!name || !cron || !prompt) {
    scheduledFormError.textContent = 'Name, schedule, and prompt are all required.';
    scheduledFormError.classList.remove('hidden');
    return;
  }
  send({ type: 'set_scheduled', task: { id: S.scheduledEditingId || undefined, name, cron, prompt, enabled: true } });
  closeForm();
};

export function showScheduledError(message) {
  scheduledFormError.textContent = message;
  scheduledFormError.classList.remove('hidden');
  scheduledForm.classList.remove('hidden');   // the error implies the form is still open
}

export function openScheduled() {
  renderScheduled();
  scheduledPanel.classList.remove('hidden');
  scheduledBtn.classList.add('active');
}
export function closeScheduled() {
  scheduledPanel.classList.add('hidden');
  scheduledBtn.classList.remove('active');
  closeForm();
}

scheduledBtn.onclick = (e) => {
  e.stopPropagation();
  if (scheduledPanel.classList.contains('hidden')) openScheduled();
  else closeScheduled();
};

document.addEventListener('click', (e) => {
  if (scheduledPanel.classList.contains('hidden')) return;
  if (scheduledPanel.contains(e.target) || scheduledBtn.contains(e.target)) return;
  closeScheduled();
});

registerPanel(scheduledPanel, closeScheduled);
