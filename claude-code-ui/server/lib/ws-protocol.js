/*
 * The WebSocket protocol: what a connecting browser is told, and what it may
 * ask for.
 *
 * The inbound half is a dispatch table rather than a chain of `else if`s, so the
 * set of messages the client may send is a list you can read.
 */
import { DEFAULT_PERMISSION_MODE } from './config.js';
import { log } from './log.js';
import { runtime } from './state.js';
import { connections, send, broadcast } from './broadcast.js';
import {
  isAuthenticated, isSubscriptionAuth, startLoginFlow, loginUrl, loginProcess,
} from './auth.js';
import { listSessions, parseSession, deleteSession, saveActive } from './sessions.js';
import { pendingDialogs, answerDialog } from './dialogs.js';
import { pendingPermissions, resolvePermission, resolvePromptsAllowedBy } from './permissions.js';
import { saveAttachments, describeAttachments } from './uploads.js';
import { runQuery, abortActive } from './run-query.js';
import * as autoContinue from './auto-continue.js';
import * as notifier from './notify.js';
import { taskState } from './tasks.js';
import * as scheduler from './scheduler.js';
import * as team from './team.js';
import { planUsage, refreshPlanUsage } from './plan-usage.js';
import * as workspace from './workspace.js';
import * as skills from './skills.js';
import { sessionModeMap } from './modes.js';

/** Everything a newly connected (or reconnected) tab needs to render the app. */
function greet(ws) {
  send(ws, { type: 'connected' });
  send(ws, {
    type: 'config',
    defaultPermMode: DEFAULT_PERMISSION_MODE,
    autoContinue: autoContinue.autoContinue.enabled,
    autoContinueSupported: isSubscriptionAuth(),
  });
  sendNotifyState(ws);
  send(ws, { type: 'auth_status', authenticated: isAuthenticated() && !runtime.credentialsExpired });
  if (runtime.credentialsExpired) send(ws, { type: 'auth_expired', subscription: isSubscriptionAuth() });
  // A login is mid-flight (reconnected while waiting to paste the code) — restore
  // the URL and code box, so switching to the browser and back does not lose it.
  const url = loginUrl();
  if (url) send(ws, { type: 'auth_url', url });
  send(ws, { type: 'slash_commands', commands: runtime.cachedSlashCommands });
  send(ws, { type: 'models', models: runtime.cachedModels });
  send(ws, { type: 'ha_links', entities: runtime.haLinks.entities, automations: runtime.haLinks.automations });
  send(ws, { type: 'sessions', sessions: listSessions(), activeId: runtime.activeSessionId });
  send(ws, {
    type: 'history',
    items: parseSession(runtime.activeSessionId),
    running: !!runtime.activeQuery,
    // The foreground turn is done but a background task it spawned (a
    // subagent, a backgrounded shell command) is still running — distinct from
    // `running` so the UI can show "finishing up in the background" rather
    // than either idle or the ordinary thinking indicator.
    background: runtime.backgroundTasks.size > 0,
  });
  if (runtime.backgroundTasks.size) {
    send(ws, { type: 'background_tasks', tasks: [...runtime.backgroundTasks.values()] });
  }

  // The task-list widget and the scheduled-tasks list are both independent of
  // the active chat, so every connecting tab gets the current state up front.
  send(ws, { type: 'tasks', tasks: taskState.tasks });
  send(ws, { type: 'scheduled_tasks', tasks: scheduler.list() });
  send(ws, { type: 'team_members', members: team.list() });

  // Workspace (root, projects, sync status) and each conversation's last mode.
  send(ws, { type: 'workspace_state', state: workspace.workspaceState() });
  send(ws, { type: 'session_modes', modes: sessionModeMap() });

  // Plan limits (5-hour / weekly / extra usage): the last snapshot right away,
  // then a refresh (rate-limited inside plan-usage.js) that broadcasts if newer.
  if (planUsage.snapshot) send(ws, { type: 'plan_usage', usage: planUsage.snapshot });
  refreshPlanUsage();

  // Replay a scheduled resume so a reconnecting tab shows the countdown, or —
  // when nothing is scheduled — the standing offer to turn one on.
  const pending = autoContinue.autoContinue.pending;
  const offer = autoContinue.liveLimitOffer();
  if (pending) {
    send(ws, { type: 'auto_continue_pending', resetsAt: pending.resetsAt,
      rateLimitType: pending.rateLimitType, attempts: pending.attempts });
  } else if (offer) {
    send(ws, { type: 'limit_offer', resetsAt: offer.resetsAt,
      rateLimitType: offer.rateLimitType, supported: isSubscriptionAuth() });
  }

  // A question Claude asked while this tab was away belongs to the run, not to
  // the socket that happened to be open — so it is still waiting, and this is
  // what shows it rather than leaving the turn silently paused.
  for (const [id, d] of pendingDialogs) {
    send(ws, { type: 'user_dialog', id, dialogKind: 'askUserQuestion', payload: d.payload });
  }

  // Likewise a permission prompt: it belongs to the run, not to whichever tab
  // was open when it was asked (see permissions.js's pendingPermissions).
  for (const [, entry] of pendingPermissions) send(ws, entry.req);
}

function sendNotifyState(ws) {
  notifier.listNotifyServices().then((services) =>
    send(ws, { type: 'notify_state', ...notifier.notifySettings, services }));
}

function broadcastSessions() {
  broadcast({ type: 'sessions', sessions: listSessions(), activeId: runtime.activeSessionId });
}

/** Everything the browser may send. One entry per message type. */
function broadcastWorkspace() {
  broadcast({ type: 'workspace_state', state: workspace.workspaceState() });
  broadcast({ type: 'workspace', entries: workspace.listWorkspaceEntries() });
}

function sendSkills(ws) {
  send(ws, { type: 'skills', ...skills.listSkills() });
}

const handlers = {
  // ── Workspace panel ──
  workspace_state(ws) {
    send(ws, { type: 'workspace_state', state: workspace.workspaceState() });
  },
  workspace_set_root(ws, msg) {
    const r = workspace.setRoot(msg.path);
    send(ws, { type: 'workspace_result', action: 'set_root', ...r });
    if (r.ok) broadcastWorkspace();
  },
  workspace_create_project(ws, msg) {
    const r = workspace.createProject(msg.name);
    if (r.ok && msg.activate) workspace.setActiveProject(r.name);
    send(ws, { type: 'workspace_result', action: 'create_project', ...r });
    if (r.ok) broadcastWorkspace();
  },
  workspace_set_active(ws, msg) {
    const r = workspace.setActiveProject(msg.name);
    send(ws, { type: 'workspace_result', action: 'set_active', ...r });
    if (r.ok) broadcast({ type: 'workspace_state', state: workspace.workspaceState() });
  },

  // ── Skills panel ──
  skills_list(ws) { sendSkills(ws); },
  skill_toggle(ws, msg) {
    if (typeof msg.id !== 'string') return;
    skills.setSkillEnabled(msg.id, !!msg.enabled);
    broadcast({ type: 'skills', ...skills.listSkills() });
  },
  skill_get(ws, msg) {
    const s = typeof msg.id === 'string' ? skills.readSkill(msg.id) : null;
    send(ws, { type: 'skill_detail', skill: s });
  },
  skill_save(ws, msg) {
    const r = skills.saveLocalSkill({ id: msg.id || null, name: msg.name, description: msg.description, body: msg.body });
    send(ws, { type: 'skill_result', action: 'save', ...r });
    if (r.ok) broadcast({ type: 'skills', ...skills.listSkills() });
  },
  skill_delete(ws, msg) {
    const r = skills.deleteLocalSkill(msg.id);
    send(ws, { type: 'skill_result', action: 'delete', ...r });
    if (r.ok) broadcast({ type: 'skills', ...skills.listSkills() });
  },

  /** The Usage panel was opened — refresh plan limits (rate-limited; replies via broadcast). */
  plan_usage_refresh(ws) {
    refreshPlanUsage().then((snap) => { if (snap) send(ws, { type: 'plan_usage', usage: snap }); });
  },

  auth_check(ws) {
    send(ws, { type: 'auth_status', authenticated: isAuthenticated() });
  },

  auth_login() {
    startLoginFlow(broadcast, () => { runtime.credentialsExpired = false; });
  },

  auth_code(_ws, msg) {
    const proc = loginProcess();
    if (proc && proc.stdin) proc.stdin.write(msg.code + '\n');
  },

  prompt(ws, msg) {
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      msg.text = describeAttachments(msg.text, saveAttachments(msg.attachments));
    }
    delete msg.attachments;   // do not carry the base64 payload any further
    runQuery(ws, msg);
  },

  abort() {
    abortActive();
  },

  new_session() {
    abortActive();
    autoContinue.cancel('new-session');
    autoContinue.clearLimitOffer('new-session');
    runtime.activeSessionId = null;
    saveActive();
    broadcast({ type: 'cleared' });
    broadcastSessions();
  },

  sessions_list(ws) {
    send(ws, { type: 'sessions', sessions: listSessions(), activeId: runtime.activeSessionId });
  },

  session_switch(_ws, msg) {
    abortActive();
    autoContinue.cancel('session-switch');
    autoContinue.clearLimitOffer('session-switch');
    runtime.activeSessionId = msg.id || null;
    saveActive();
    broadcast({ type: 'history', items: parseSession(runtime.activeSessionId), running: false });
    broadcastSessions();
  },

  session_delete(_ws, msg) {
    deleteSession(msg.id);
    if (msg.id === runtime.activeSessionId) {
      runtime.activeSessionId = null;
      saveActive();
      broadcast({ type: 'cleared' });
    }
    broadcastSessions();
  },

  permission_response(_ws, msg) {
    // 'allow' | 'always' | 'deny' — 'always' also persists the SDK's suggested
    // rule so this tool stops prompting. Answerable from any tab — the prompt
    // is not tied to the one that raised it (see permissions.js).
    resolvePermission(msg.id, msg.decision);
  },

  user_dialog_response(_ws, msg) {
    // An answer to an AskUserQuestion. `result` absent means Skip — Claude is
    // told nobody answered and carries on. (Closing the card to read the chat
    // first sends nothing at all: the question stays pending, and the strip above
    // the composer is the way back to it.)
    answerDialog(msg.id, msg.result);
  },

  set_perm_mode(_ws, msg) {
    // Takes effect immediately for ask/acceptEdits/bypass, which route through
    // canUseTool. A run started in 'auto' keeps the SDK classifier for its
    // duration.
    runtime.activePermMode = msg.mode;
    resolvePromptsAllowedBy(msg.mode);
  },

  set_auto_continue(_ws, msg) {
    autoContinue.setEnabled(msg.enabled);
  },

  cancel_auto_continue() {
    autoContinue.cancel('user');
  },

  // Whether this tab is on screen right now. The push is suppressed while any
  // tab is — a dropped or hidden socket is exactly the phone-in-pocket case.
  presence(ws, msg) {
    ws.visible = !!msg.visible;
  },

  set_notify(_ws, msg) {
    notifier.setSettings(msg);
    broadcast({ type: 'notify_state', ...notifier.notifySettings });
  },

  async test_notify(ws) {
    send(ws, { type: 'notify_test', ...(await notifier.sendTest()) });
  },

  // ── Scheduled tasks ──────────────────────────────────────────────────────
  // Deliberately independent of the active chat (see scheduler.js) — these
  // just manage the persisted list; `upsert`/`remove` broadcast their own
  // 'scheduled_tasks' update, so no explicit reply is needed here.
  set_scheduled(ws, msg) {
    try {
      scheduler.upsert(msg.task || {});
    } catch (e) {
      send(ws, { type: 'scheduled_error', message: e.message });
    }
  },

  delete_scheduled(_ws, msg) {
    scheduler.remove(msg.id);
  },

  run_scheduled_now(_ws, msg) {
    scheduler.runNow(msg.id);
  },

  // ── Team panel ───────────────────────────────────────────────────────────
  // The person edits this directly from the panel; Claude can also log a note
  // via the team-notes CLI (/internal/team) — both converge on team.js, which
  // broadcasts its own 'team_members' update, so no explicit reply is needed.
  set_team_member(ws, msg) {
    try {
      team.upsert(msg.member || {});
    } catch (e) {
      send(ws, { type: 'team_error', message: e.message });
    }
  },

  delete_team_member(_ws, msg) {
    team.remove(msg.id);
  },
};

export function attach(wss) {
  wss.on('connection', (ws) => {
    connections.add(ws);

    greet(ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const handler = handlers[msg.type];
      if (!handler) return;
      try {
        handler(ws, msg);
      } catch (e) {
        log('ERROR', `handling ${msg.type} failed: ${e?.message || e}`);
      }
    });

    ws.on('close', () => {
      connections.delete(ws);
      // The active query is deliberately NOT aborted: it keeps running and
      // persisting, so the chat is complete when the user navigates back.
      // Pending permission prompts and questions are NOT cleared here either —
      // neither is tied to a connection. A phone backgrounding its browser
      // drops the socket routinely, and auto-denying (or auto-answering) on
      // that used to read as the request silently vanishing while the user was
      // away. Both belong to the run, not the socket that happened to be open
      // when they were raised: any tab may still answer, including one that
      // connects later (see greet()'s replay, and dialogs.js / permissions.js).
      // The run itself owns the wait via the tool call's own abort signal, so
      // Stop, a new prompt, or a session switch already end it correctly.
    });
  });
}
