/*
 * The WebSocket: connecting, reconnecting, authentication, and the dispatch of
 * every message the server sends.
 */
import { S } from './state.js';
import { appendLimitNotice, hideAcBanner, refreshBgTasksStrip, showAcBanner } from './banners.js';
import { clearScreen } from './commands.js';
import { setStatus, updateSendBtn } from './composer.js';
import { closePermission, dropDialog, showPermissionPrompt, showUserDialog } from './dialogs.js';
import { autoContinueToggle, loginBtn, loginCodeForm, loginCodeInput, loginDesc, loginScreen, loginTitle, loginUrlEl, loginUrlSect, loginWaiting, modelSelect, permModeSelect, sessionsPanel, wsUrl } from './dom.js';
import { relinkRenderedBubbles } from './links.js';
import { announcePresence, applyNotifyState, attentionCue, showNotifyTestResult } from './notify.js';
import { applyModelCatalog, ensureModelOption, updateCtxHint } from './model.js';
import { renderSessions, applyRuns, switchTo } from './sessions.js';
import { showToast } from './toast.js';
import { setAutoContinueSupported } from './settings.js';
import { hideThinking, showThinking } from './thinking.js';
import { appendAgentReport, appendAssistantText, appendTextDelta, finishStream, appendCompactedDivider, appendErrorBubble, appendInfoLine, appendResultLine, appendTaskNotice, appendToolResult, appendToolUse, appendUserBubble, endToolGroup, renderHistory } from './transcript.js';
import { renderTasks, updateTasksVisibility } from './tasks.js';
import { applyWorkspaceEntries, applyWorkspaceState, applyWorkspaceResult, applyPreviews } from './workspace.js';
import { applyWorkspaceStat, applyWriteResult, applyDeleteResult, applyTurnArtifacts, setConversationArtifacts } from './artifacts.js';
import { applySearchResults, applySessionActionResult } from './sessions.js';
import { applyTurns, applyRewindResult } from './changes.js';
import { applySessionMode, applySessionModes } from './modes.js';
import { applySkills, applySkillDetail, applySkillResult } from './skills.js';
import { voiceOnText, voiceOnTurnEnd } from './voice.js';
import { applyRoles, applyRoleResult, applySessionRoles, resetRolesForNewConversation } from './roles.js';
import { renderScheduled, showScheduledError } from './scheduled.js';
import { renderTeam } from './team.js';
import { renderUsage } from './usage-panel.js';

// ── WebSocket ─────────────────────────────────────────────────────────────

let modesLoaded = false;   // see 'session_modes'

export function connect() {
  S.ws = new WebSocket(wsUrl);

  S.ws.onopen    = () => { S.isConnected = true;  setStatus('connected'); announcePresence(); };
  S.ws.onclose   = () => { S.isConnected = false; S.isRunning = false; setStatus('disconnected'); updateSendBtn(); setTimeout(connect, 3000); };
  S.ws.onerror   = () => S.ws.close();
  S.ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
}

export function setAuthenticated(authenticated) {
  if (authenticated) {
    loginScreen.classList.add('hidden');
  } else {
    loginScreen.classList.remove('hidden');
    // Default (first-time / signed-out) copy; showReauth() overrides for expiry.
    loginTitle.textContent = 'Connect to Anthropic';
    loginDesc.textContent = 'Sign in to your Anthropic account to use Claude.';
    loginBtn.classList.remove('hidden');
    loginUrlSect.classList.add('hidden');
    loginCodeForm.classList.add('hidden');
    loginWaiting.classList.add('hidden');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in with Anthropic';
  }
}

// Credentials expired (or were rejected) mid-use — surface the login screen with
// a re-auth message so there's a clear button to sign in again.
export function showReauth(subscription) {
  setAuthenticated(false);
  if (subscription === false) {
    // API-key auth: a device-flow login won't help, so point at the option.
    loginTitle.textContent = 'Authentication failed';
    loginDesc.textContent = 'Your Anthropic API key was rejected — check it in the app options.';
    loginBtn.classList.add('hidden');
  } else {
    loginTitle.textContent = 'Session expired';
    loginDesc.textContent = 'Your Claude sign-in has expired. Sign in again to continue.';
  }
}

loginBtn.onclick = () => {
  loginBtn.disabled = true;
  loginBtn.textContent = 'Opening…';
  S.ws.send(JSON.stringify({ type: 'auth_login' }));
};

loginCodeForm.onsubmit = (e) => {
  e.preventDefault();
  const code = loginCodeInput.value.trim();
  if (!code) return;
  S.ws.send(JSON.stringify({ type: 'auth_code', code }));
  loginCodeForm.classList.add('hidden');
  loginWaiting.classList.remove('hidden');
};

export function handleServerMessage(msg) {
  switch (msg.type) {
    case 'connected': break;
    case 'session':   break;

    case 'config':
      // Server-provided default permission mode for new chats. The user's own
      // saved choice (localStorage) always wins.
      if (!localStorage.getItem('permMode') && msg.defaultPermMode) {
        permModeSelect.value = msg.defaultPermMode;
      }
      // Auto-continue state is server-owned (persisted in /data), so the server
      // is the source of truth — just reflect it.
      if (msg.autoContinue != null) autoContinueToggle.checked = !!msg.autoContinue;
      setAutoContinueSupported(msg.autoContinueSupported !== false);
      break;

    case 'notify_state':
      applyNotifyState(msg);
      break;

    case 'notify_test':
      showNotifyTestResult(msg);
      break;

    case 'auth_status':
      setAuthenticated(msg.authenticated);
      break;

    case 'auth_expired':
      showReauth(msg.subscription);
      break;

    case 'slash_commands':
      S.pluginCommands = Array.isArray(msg.commands) ? msg.commands : [];
      break;

    case 'models':
      // The SDK's own model catalog — account-filtered, same list the CLI's
      // /model picker uses. Rebuilds the dropdown; the static options in
      // index.html are only the fallback shown before the first turn.
      applyModelCatalog(msg.models);
      break;

    case 'ha_links': {
      // Entity/automation link targets. These usually land just after the
      // history replay, so re-render already-rendered bubbles to pick up links.
      const had = S.haEntities.size;
      S.haEntities = new Set(Array.isArray(msg.entities) ? msg.entities : []);
      S.haAutomationIds = msg.automations || {};
      if (!had && S.haEntities.size) relinkRenderedBubbles();
      break;
    }

    case 'model':
      // The model actually in use, reported by the SDK init event
      if (msg.model) {
        ensureModelOption(msg.model);
        if (!localStorage.getItem('model')) modelSelect.value = msg.model;
      }
      break;

    case 'sessions': {
      const prevActive = S.activeSessionId;
      S.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      S.activeSessionId = msg.activeId || null;
      if (msg.view !== undefined) S.viewKey = msg.view || null;
      // Opening another conversation restores the mode it was last used in.
      if (S.activeSessionId && S.activeSessionId !== prevActive) {
        applySessionMode(S.activeSessionId);
        applySessionRoles(S.activeSessionId);
      }
      applyRuns(S.runs);   // the "running elsewhere" badge depends on which one is on screen
      if (!sessionsPanel.classList.contains('hidden')) renderSessions();
      break;
    }

    case 'runs':
      applyRuns(msg.runs);
      break;

    case 'run_finished': {
      // Another conversation finished out of sight — say so, with a way there.
      const title = msg.title || 'A conversation';
      const target = msg.sessionId || msg.key;
      const text = msg.aborted ? `■ Stopped: ${title}` : msg.ok ? `✓ Done: ${title}` : `⚠ Stopped with an error: ${title}`;
      showToast(text, { kind: msg.ok ? 'ok' : 'warn', action: target ? { label: 'Open', fn: () => switchTo(target) } : undefined });
      if (msg.ok) attentionCue('Claude finished', title);
      break;
    }

    case 'turn_artifacts':
      applyTurnArtifacts(msg.files);
      break;

    case 'session_modes': {
      // On load the map lands after the conversation itself, so restore its mode
      // now — once; later broadcasts must not undo a switch the user just made.
      const first = !modesLoaded;
      modesLoaded = true;
      applySessionModes(msg.modes);
      if (first && S.activeSessionId) applySessionMode(S.activeSessionId);
      break;
    }

    case 'workspace_state':
      applyWorkspaceState(msg.state);
      break;

    case 'workspace_result':
      applyWorkspaceResult(msg);
      break;

    case 'skills':
      applySkills(msg);
      break;

    case 'roles':
      applyRoles(msg);
      if (!sessionsPanel.classList.contains('hidden')) renderSessions();
      break;

    case 'role_result':
      applyRoleResult(msg);
      break;

    case 'previews':
      applyPreviews(msg.previews);
      break;
    case 'workspace_stat':
      applyWorkspaceStat(msg);
      break;
    case 'workspace_write_result':
      applyWriteResult(msg);
      break;
    case 'workspace_delete_result':
      applyDeleteResult(msg);
      break;
    case 'session_search_results':
      applySearchResults(msg);
      break;
    case 'session_export_result':
    case 'session_duplicate_result':
      applySessionActionResult(msg);
      break;
    case 'turns':
      applyTurns(msg);
      break;
    case 'rewind_result':
      applyRewindResult(msg);
      break;

    case 'skill_detail':
      applySkillDetail(msg);
      break;

    case 'skill_result':
      applySkillResult(msg);
      break;

    case 'history':
      if (msg.view !== undefined) S.viewKey = msg.view || null;
      S.artifacts = Array.isArray(msg.artifacts) ? msg.artifacts : [];
      renderHistory(msg.items || [], S.artifacts);
      setConversationArtifacts(S.artifacts);
      applyRuns(S.runs);
      S.isRunning = !!msg.running;
      if (S.isRunning) showThinking();
      // The task list itself follows right behind, in the same greeting burst
      // (see ws-protocol.js's greet()) — this just avoids a flash of "nothing
      // running" in between for a run that is backgrounded.
      if (!msg.background) { S.backgroundTasks = []; refreshBgTasksStrip(); }
      updateSendBtn();
      break;

    case 'background_tasks':
      S.backgroundTasks = msg.tasks || [];
      refreshBgTasksStrip();
      break;

    case 'task_notice':
      appendTaskNotice(msg);
      break;

    case 'tasks':
      // The task-LIST widget (claude-tasks CLI) — distinct from 'task_notice'
      // above, which is a background-subagent chip in the transcript.
      S.tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
      updateTasksVisibility();
      renderTasks();
      break;

    case 'workspace':
      applyWorkspaceEntries(msg.entries);
      break;

    case 'scheduled_tasks':
      S.scheduled = Array.isArray(msg.tasks) ? msg.tasks : [];
      renderScheduled();
      break;

    case 'scheduled_error':
      showScheduledError(msg.message);
      break;

    case 'scheduled_run_busy':
      appendInfoLine('A scheduled task tried to run now, but the chat is busy — try again once it is free.');
      break;

    case 'team_members':
      S.team = Array.isArray(msg.members) ? msg.members : [];
      renderTeam();
      break;

    case 'team_error':
      appendInfoLine(`Team panel: ${msg.message}`);
      break;

    case 'agent_report':
      appendAgentReport(msg);
      break;

    case 'cleared':
      clearScreen();
      resetRolesForNewConversation();
      S.viewKey = null;
      setConversationArtifacts([]);
      applyRuns(S.runs);
      S.isRunning = false;
      S.backgroundTasks = [];
      refreshBgTasksStrip();
      updateSendBtn();
      break;

    case 'user':
      // A prompt sent from another connected client/tab
      appendUserBubble(msg.text, undefined, undefined, { steer: !!msg.steer });
      break;

    case 'auth_url':
      // A login is in progress — make sure the login screen is up (it may be a
      // replay after a mid-login reconnect) and show the URL + code box.
      loginScreen.classList.remove('hidden');
      loginBtn.disabled = true;
      loginBtn.textContent = 'Waiting for sign-in…';
      loginUrlSect.classList.remove('hidden');
      loginUrlEl.href = msg.url;
      loginUrlEl.textContent = msg.url;
      loginCodeForm.classList.remove('hidden');
      loginCodeInput.focus();
      break;

    case 'text_delta':
      hideThinking();
      appendTextDelta(msg.text);
      break;

    case 'text':
      hideThinking();
      appendAssistantText(msg.text);
      voiceOnText(msg.text);
      break;

    case 'tool_use':
      hideThinking();
      finishStream();
      S.lastAssistantBubble = null;
      appendToolUse(msg.id, msg.name, msg.input);
      break;

    case 'tool_result':
      appendToolResult(msg.id, msg.output, msg.isError, msg.answered);
      // Still running → Claude is deciding its next step
      if (S.isRunning) showThinking();
      break;

    case 'permission_request':
      hideThinking();
      attentionCue('Claude needs permission', msg.title || `Allow ${msg.toolName}?`);
      showPermissionPrompt(msg);
      break;

    case 'permission_resolved':
      // The server resolved this prompt without this tab's input: the mode was
      // switched to Bypass/Accept edits mid-run, it was answered on another
      // tab, or the run itself ended. closePermission() drops it from the
      // queue whether or not it was the one currently on screen — a prompt
      // queued behind another, resolved before its turn ever came, must not
      // pop up stale once it would have been shown.
      closePermission(msg.id);
      break;

    case 'result':
      hideThinking();
      finishStream();
      S.lastAssistantBubble = null;
      appendResultLine(msg);
      S.usage.turns       += msg.turns       || 0;
      S.usage.cost        += msg.cost        || 0;
      S.usage.inputTokens  += msg.inputTokens  || 0;
      S.usage.outputTokens += msg.outputTokens || 0;
      S.usage.cacheReadTokens  += msg.cacheReadTokens  || 0;
      S.usage.cacheWriteTokens += msg.cacheWriteTokens || 0;
      renderUsage();
      S.isRunning = false;
      updateSendBtn();
      if (!msg.background) attentionCue('Claude finished', 'Your reply is ready.');
      voiceOnTurnEnd();
      break;

    case 'context_usage':
      S.ctxUsage = {
        totalTokens: msg.totalTokens || 0,
        maxTokens: msg.maxTokens || 0,
        autoCompactThreshold: msg.autoCompactThreshold || 0,
        autoCompactEnabled: !!msg.autoCompactEnabled,
      };
      updateCtxHint();
      break;

    case 'compacted':
      appendCompactedDivider(msg);
      break;

    case 'user_dialog':
      hideThinking();
      attentionCue('Claude has a question', msg.payload?.questions?.[0]?.question || 'Waiting for your answer');
      showUserDialog(msg);
      break;

    case 'user_dialog_cancelled':
      // Answered on another tab, or the turn was stopped — either way there's
      // nothing left to answer here.
      dropDialog(msg.id);
      break;

    case 'error':
      hideThinking();
      finishStream();
      voiceOnTurnEnd();
      S.lastAssistantBubble = null;
      appendErrorBubble(msg.message);
      S.isRunning = false;
      updateSendBtn();
      break;

    case 'aborted':
      hideThinking();
      finishStream();
      voiceOnTurnEnd();
      S.lastAssistantBubble = null;
      endToolGroup();
      S.isRunning = false;
      S.backgroundTasks = [];
      refreshBgTasksStrip();
      updateSendBtn();
      break;

    case 'auto_continue_state':
      autoContinueToggle.checked = !!msg.enabled;
      if (msg.supported != null) setAutoContinueSupported(!!msg.supported);
      if (!msg.enabled) hideAcBanner();
      break;

    case 'auto_continue_pending':
      S.limitOffer = null;
      showAcBanner(msg.resetsAt, msg.rateLimitType, msg.attempts);
      break;

    case 'auto_continue_cancelled':
      hideAcBanner();
      break;

    case 'limit_notice':
      appendLimitNotice(msg);
      break;

    case 'limit_offer':
      // A S.usage limit stopped the run and nothing is scheduled. Say when it
      // lifts, and offer to have the chat pick itself up then.
      S.limitOffer = { resetsAt: msg.resetsAt, supported: msg.supported !== false };
      showAcBanner(msg.resetsAt, msg.rateLimitType, 0, true);
      break;

    case 'limit_offer_cleared':
      S.limitOffer = null;
      hideAcBanner();
      break;

    case 'auto_continue_resuming':
      hideAcBanner();
      // Resuming a conversation that is not the one on screen: it runs out of sight.
      if (msg.sid && msg.sid !== S.viewKey) {
        showToast('⏳ Usage limit reset — a conversation is continuing in the background.', {
          action: { label: 'Open', fn: () => switchTo(msg.sid) },
        });
        break;
      }
      appendInfoLine('⏳ Usage limit reset — continuing automatically…');
      S.isRunning = true;
      updateSendBtn();
      showThinking();
      break;

    case 'auto_continue_gaveup':
      hideAcBanner();
      appendErrorBubble('Auto-continue stopped — still rate-limited after several attempts. Try again later.');
      S.isRunning = false;
      updateSendBtn();
      break;

    case 'plan_usage':
      S.planUsage = msg.usage || null;
      renderUsage();
      break;

    case 'rate_limit':
      // Live utilization telemetry; the banner is driven by the pending/cancel
      // messages, so nothing to render here for now.
      break;
  }
}
