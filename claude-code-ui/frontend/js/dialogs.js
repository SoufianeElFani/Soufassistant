/*
 * The two things that can be waiting on you: a permission prompt and a question.
 * 
 * Both can be *set aside* rather than answered. Reading the conversation is usually
 * how you work out what the answer should be, and a modal offering only yes/no
 * forces a guess; the strip above the composer is the way back to either.
 */
import { S } from './state.js';
import { dialogBack, dialogBody, dialogLater, dialogOverlay, dialogProgress, dialogSkip, dialogSubmit, dialogTitle, permAllow, permAlways, permAlwaysHint, permDeny, permInputEl, permLater, permOverlay, permTitle, permToolChip, questionStrip, questionStripOpen, questionStripText } from './dom.js';

// ── Things waiting on you ────────────────────────────────────────────────────
// Both the permission card and Claude's questions can be *set aside* rather than
// answered: reading the conversation is usually how you work out what the answer
// should be, and a modal that only offers yes/no forces a guess. Closing one
// leaves the request pending on the server — the turn stays paused — and the
// strip above the composer is the way back to it. Nothing is lost and nothing
// pops up again on its own.

export const pendingDialogs = new Map();    // id → payload, still waiting on the server
export const dismissedDialogs = new Set();  // ids closed with ✕, re-openable from the strip

export function refreshQuestionStrip() {
  const dialogs = pendingDialogs.size;
  const perms = pendingPerms.size;
  const overlayUp = !dialogOverlay.classList.contains('hidden') ||
                    !permOverlay.classList.contains('hidden');
  if (!(dialogs + perms) || overlayUp) { questionStrip.classList.add('hidden'); return; }
  questionStripText.textContent =
    dialogs && perms ? `${dialogs + perms} things need you`
      : dialogs ? (dialogs === 1 ? 'Claude has a question' : `Claude has ${dialogs} questions`)
      : perms === 1 ? 'Claude needs permission' : `Claude needs ${perms} permissions`;
  questionStrip.classList.remove('hidden');
}

questionStripOpen.onclick = () => {
  const next = [...pendingDialogs.keys()][0];
  if (next) openDialog(next);
  else if (pendingPerm) openPermission();
};

// ── Permission prompt ──────────────────────────────────────────────────────
// Every prompt still waiting (shown or queued behind another), keyed by id —
// a main agent and a subagent can both have one in flight at once, and a
// request is now broadcast to every tab (see permissions.js), so a reconnect
// replay can resend one this tab already knows about. `pendingPerms` is the
// full set; `pendingPerm` is whichever of them is on screen right now, or null.

export const pendingPerms = new Map();   // id → req, still waiting on an answer
export let pendingPerm = null;

// Nothing on screen and something queued — show the oldest of them. Called
// after a new request arrives with nothing showing, and after one is resolved.
function openNextPermission() {
  if (pendingPerm) { refreshQuestionStrip(); return; }
  const next = pendingPerms.values().next().value;
  if (next) { pendingPerm = next; openPermission(); }
  else refreshQuestionStrip();
}

export function showPermissionPrompt(req) {
  // Map.set on an id already present just updates the stored request — a
  // reconnect replay resending one this tab already has queued is a no-op
  // beyond that, not a second entry.
  pendingPerms.set(req.id, req);
  openNextPermission();
}

/**
 * A prompt raised by a conversation other than the one on screen says whose it
 * is — several conversations can be running at once.
 */
function setFrom(card, req) {
  let from = card.querySelector('.card-from');
  const elsewhere = req && req.sid && req.sid !== S.viewKey;
  if (!elsewhere) { if (from) from.remove(); return; }
  if (!from) {
    from = document.createElement('div');
    from.className = 'card-from';
    card.insertBefore(from, card.firstChild);
  }
  from.textContent = `From another conversation: ${req.conversation || 'running in the background'}`;
}

export function openPermission() {
  const { toolName, input, title, canAlways, alwaysLabel } = pendingPerm || {};
  if (!pendingPerm) return;
  setFrom(permOverlay.querySelector('.permission-card'), pendingPerm);
  permToolChip.textContent = toolName;
  permTitle.textContent = title || `Allow ${toolName}?`;
  const raw = JSON.stringify(input, null, 2);
  permInputEl.textContent = raw.length > 600 ? raw.slice(0, 600) + '\n…' : raw;
  // "Always" is only offered when the SDK supplied rules that would stop it
  // asking again; the label shows exactly what's being allowed from now on.
  permAlways.classList.toggle('hidden', !canAlways);
  permAlwaysHint.classList.toggle('hidden', !canAlways);
  if (canAlways) {
    permAlwaysHint.textContent = alwaysLabel
      ? `Always = don't ask again for: ${alwaysLabel}`
      : "Always = don't ask again for this tool";
  }
  permOverlay.classList.remove('hidden');
  refreshQuestionStrip();
}

export function resolvePermission(decision) {
  if (!pendingPerm) return;
  S.ws.send(JSON.stringify({ type: 'permission_response', id: pendingPerm.id, decision }));
  closePermission(pendingPerm.id);
}

// The request is gone — answered on this tab or another, or cancelled by the
// server (Stop, a new prompt, a session switch). `id` may belong to a card
// that is not even the one on screen — a prompt queued behind another can be
// resolved elsewhere before its turn comes, and it must not then pop up as a
// stale, already-answered card once it would have been shown.
export function closePermission(id) {
  pendingPerms.delete(id);
  if (pendingPerm && pendingPerm.id === id) {
    pendingPerm = null;
    permOverlay.classList.add('hidden');
  }
  openNextPermission();
}

// Set aside: still pending server-side (and still queued, if others are too),
// reachable from the strip — the one on screen specifically, not whichever is
// next in the queue. Nothing else pops up in its place.
export function laterPermission() {
  if (!pendingPerm) return;
  permOverlay.classList.add('hidden');
  refreshQuestionStrip();
}

permAllow.onclick  = () => resolvePermission('allow');
permAlways.onclick = () => resolvePermission('always');
permDeny.onclick   = () => resolvePermission('deny');
permLater.onclick  = () => laterPermission();

// A tap on the backdrop sets the card aside rather than denying: a stray tap
// should never be the thing that refuses a tool call.
permOverlay.onclick = (e) => { if (e.target === permOverlay) laterPermission(); };

// ── User dialog (AskUserQuestion) ──────────────────────────────────────────
// Claude asking the human something. The tool never runs: the server intercepts
// the call, puts the question here, and hands the answer back as the tool's
// result (see the server's formatQuestionDenial).
//
// One question per page, so a three-question ask isn't a wall of radio buttons —
// and every question carries an "Other" box, because the option that fits is
// often not one of the ones offered.

export let dialogBuild = null;   // { id, controls, pages, index } for the dialog on screen

export function showUserDialog({ id, payload, sid, conversation }) {
  const questions = Array.isArray(payload && payload.questions) ? payload.questions
    : (payload && Array.isArray(payload.options)) ? [payload] : [];
  // A shape we don't understand can't be rendered, and leaving the turn paused
  // on a dialog nobody can answer is worse than declining it.
  if (!questions.length) { S.ws.send(JSON.stringify({ type: 'user_dialog_response', id })); return; }
  pendingDialogs.set(id, { questions, sid, conversation });
  // Don't barge in over a question already on screen — finish that one first —
  // and don't reopen one that was deliberately set aside. (The server replays
  // pending questions on every connect, so this runs again after a reconnect.)
  if (!dialogBuild && !dismissedDialogs.has(id)) openDialog(id);
  else refreshQuestionStrip();
}

export function openDialog(id) {
  const entry = pendingDialogs.get(id);
  if (!entry) return;
  dismissedDialogs.delete(id);
  if (!dialogBuild || dialogBuild.id !== id) buildDialog(id, entry.questions);
  setFrom(dialogOverlay.querySelector('.permission-card'), entry);
  dialogOverlay.classList.remove('hidden');
  refreshQuestionStrip();
}

export function buildDialog(id, questions) {
  dialogTitle.textContent = questions.length > 1 ? 'A few questions' : (questions[0].header || 'Question');
  dialogBody.innerHTML = '';

  const controls = [];
  const pages = [];

  questions.forEach((q, qi) => {
    const page = document.createElement('div');
    page.className = 'dialog-q';

    if (q.header) {
      const h = document.createElement('div');
      h.className = 'dialog-q-header';
      h.textContent = q.header;
      page.appendChild(h);
    }
    const qt = document.createElement('div');
    qt.className = 'dialog-q-text';
    qt.textContent = q.question || '';
    page.appendChild(qt);

    const group = `q${qi}-${Math.random().toString(36).slice(2)}`;
    const optionInputs = [];

    const mkOption = (labelText, description) => {
      const label = document.createElement('label');
      label.className = 'dialog-option';
      const input = document.createElement('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = group;
      label.appendChild(input);
      const textWrap = document.createElement('span');
      textWrap.className = 'dialog-option-text';
      const lab = document.createElement('span');
      lab.className = 'dialog-option-label';
      lab.textContent = labelText;
      textWrap.appendChild(lab);
      if (description) {
        const desc = document.createElement('span');
        desc.className = 'dialog-option-desc';
        desc.textContent = description;
        textWrap.appendChild(desc);
      }
      label.appendChild(textWrap);
      input.addEventListener('change', () => {
        page.querySelectorAll('.dialog-option').forEach((o) => {
          o.classList.toggle('selected', o.querySelector('input').checked);
        });
        updateDialogSubmit();
      });
      page.appendChild(label);
      return { input, label };
    };

    for (const opt of (q.options || [])) {
      const { input } = mkOption(opt.label || String(opt), opt.description);
      optionInputs.push({ input, label: opt.label || String(opt) });
    }

    // Always offered. Claude is told not to include an "Other" of its own, so
    // this is the only one — and typing in it implies picking it, without also
    // having to hit the radio button.
    const other = mkOption('Other', null);
    const otherText = document.createElement('input');
    otherText.type = 'text';
    otherText.className = 'dialog-other-text';
    otherText.placeholder = 'Type your own answer…';
    otherText.addEventListener('input', () => {
      other.input.checked = true;
      other.input.dispatchEvent(new Event('change'));
    });
    other.label.classList.add('dialog-option-other');
    other.label.querySelector('.dialog-option-text').appendChild(otherText);

    controls.push({ header: q.header, multiSelect: !!q.multiSelect, optionInputs,
      otherToggle: other.input, otherText });
    pages.push(page);
    dialogBody.appendChild(page);
  });

  dialogBuild = { id, controls, pages, index: 0 };
  renderDialogPage();
}

export function renderDialogPage() {
  if (!dialogBuild) return;
  const { pages, index } = dialogBuild;
  pages.forEach((p, i) => p.classList.toggle('hidden', i !== index));
  dialogProgress.textContent = `${index + 1}/${pages.length}`;
  dialogProgress.classList.toggle('hidden', pages.length <= 1);
  dialogBack.classList.toggle('hidden', index === 0);
  dialogSubmit.textContent = index < pages.length - 1 ? 'Next' : 'Submit';
  updateDialogSubmit();
  dialogBody.scrollTop = 0;
}

export function pagePicked(c) {
  const picked = c.optionInputs.filter((o) => o.input.checked).map((o) => o.label);
  const other = c.otherToggle.checked ? c.otherText.value.trim() : '';
  if (other) picked.push(other);
  return picked;
}

export function updateDialogSubmit() {
  if (!dialogBuild) return;
  dialogSubmit.disabled = pagePicked(dialogBuild.controls[dialogBuild.index]).length === 0;
}

export function collectDialogAnswers() {
  const answers = {};
  for (const c of (dialogBuild ? dialogBuild.controls : [])) {
    const picked = pagePicked(c);
    if (picked.length) answers[c.header] = c.multiSelect ? picked : picked[0];
  }
  return { answers };
}

export function submitDialog() {
  if (!dialogBuild) return;
  if (dialogBuild.index < dialogBuild.pages.length - 1) {
    dialogBuild.index++;
    renderDialogPage();
    return;
  }
  S.ws.send(JSON.stringify({ type: 'user_dialog_response', id: dialogBuild.id, result: collectDialogAnswers() }));
  dropDialog(dialogBuild.id);
}

// Answer it later — the question stays pending and the strip brings it back.
export function laterDialog() {
  if (!dialogBuild) return;
  dismissedDialogs.add(dialogBuild.id);
  dialogOverlay.classList.add('hidden');
  refreshQuestionStrip();
}

// Let Claude get on with it without an answer.
export function skipDialog() {
  if (!dialogBuild) return;
  S.ws.send(JSON.stringify({ type: 'user_dialog_response', id: dialogBuild.id }));   // no result
  dropDialog(dialogBuild.id);
}

// The request is gone — answered, skipped, or cancelled by the server.
export function dropDialog(id) {
  pendingDialogs.delete(id);
  dismissedDialogs.delete(id);
  if (dialogBuild && dialogBuild.id === id) {
    dialogBuild = null;
    dialogOverlay.classList.add('hidden');
  }
  const next = [...pendingDialogs.keys()].find((k) => !dismissedDialogs.has(k));
  if (next && !dialogBuild) openDialog(next);
  else refreshQuestionStrip();
}

dialogSubmit.onclick = () => submitDialog();
dialogSkip.onclick   = () => skipDialog();
dialogLater.onclick  = () => laterDialog();
dialogBack.onclick   = () => {
  if (!dialogBuild || dialogBuild.index === 0) return;
  dialogBuild.index--;
  renderDialogPage();
};
// Same reasoning as the permission backdrop: setting it aside, not answering for you.
dialogOverlay.onclick = (e) => { if (e.target === dialogOverlay) laterDialog(); };
