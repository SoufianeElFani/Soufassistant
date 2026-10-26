/*
 * One turn: build the SDK options, run the query, and map its events onto the
 * wire protocol the browser speaks.
 *
 * The run is owned by its conversation, not by the socket that started it:
 * it lives in `runtime.runs` (runs.js) under the conversation's key, so
 * navigating away — or opening another conversation and starting a run there —
 * does not cancel it. Its transcript events go to the tabs showing that
 * conversation (emit()); that it is running, or has finished, goes to every tab.
 *
 * The prompt is a streamed AsyncIterable (`input-channel.js`), not a plain
 * string — confirmed live: a string prompt makes the SDK close the CLI's
 * stdin as soon as the turn's own `result` arrives, and once stdin is closed
 * the CLI can no longer send ANY control request back to this host (a
 * PreToolUse hook callback, a canUseTool ask). Every one is then denied
 * locally inside the CLI with its canned "The user doesn't want to take this
 * action right now" text — including a background subagent trying to deliver
 * its report through SubagentHandback, which is exactly the failure this
 * fixes. Keeping the channel open until every background task this run
 * spawned has actually finished defers that close until it is genuinely safe.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  WORK_DIR, PLUGINS, EFFORT_LEVELS, DEFAULT_PERMISSION_MODE, STALL_WARN_MS, STALL_CHECK_MS,
} from './config.js';
import { log, vlog } from './log.js';
import { runtime } from './state.js';
import { connections, send, broadcast } from './broadcast.js';
import { isAuthError, isSubscriptionAuth } from './auth.js';
import { saveActive, isQuestionAnswer, parseTaskNotification, truncateOutput, sessionTitle } from './sessions.js';
import { hooksFor, makeCanUseTool } from './permissions.js';
import { askQuestion } from './dialogs.js';
import { refreshHaLinks } from './ha-links.js';
import { listWorkspaceEntries } from './workspace.js';
import { MCP_FREE_SETTINGS } from './mcp.js';
import { usableSlashCommands } from './slash-commands.js';
import { makeInputChannel } from './input-channel.js';
import { notify } from './notify.js';
import * as autoContinue from './auto-continue.js';
import { refreshPlanUsage } from './plan-usage.js';
import { modeOptions, normalizeMode, coworkWriteGuard, rememberSessionMode, sessionModeMap } from './modes.js';
import { workspaceRoot, activeProject, projectDir } from './workspace.js';
import { imageMcpServer, IMAGE_TOOL } from './image-gen.js';
import { disabledOverrides } from './skills.js';
import { decoratedSessions, recordArtifacts, FILE_TOOLS } from './session-tools.js';
import { listPreviews } from './previews.js';
import {
  viewKey, newDraftKey, runFor, emit, isViewed, broadcastRuns, rekey,
} from './runs.js';
import path from 'path';

// STALL_WARN_MS / STALL_CHECK_MS (config.js): how long the SDK may go quiet
// before the log says so, and how often it checks — only while a turn is
// actively in flight. A run waiting on a background task is expected to be
// quiet for a long time, so the watchdog is exempt in that phase (see
// runPhase below) and instead logs an occasional heartbeat.
// After the last background task ends: how long to wait for the CLI's
// follow-up turn to start before treating the run as over.
const FOLLOW_UP_GRACE_MS = Number(process.env.FOLLOW_UP_GRACE_MS) || 20000;
const BACKGROUND_HEARTBEAT_TICKS = Math.max(1, Math.round(300000 / STALL_CHECK_MS)); // ~5 min

/** Stop one conversation's run (the conversation on screen by default). */
export function abortRun(key = viewKey()) {
  const run = runFor(key);
  if (!run) return false;
  run.abortController.abort();
  // Removed eagerly too (not just in the run's own `finally`), so a prompt
  // arriving in the gap between abort() and that cleanup cannot be pushed into
  // a channel whose run is already being torn down.
  run.channel.close();
  runtime.runs.delete(run.key);
  if (run.backgroundTasks.size) {
    run.backgroundTasks = new Map();
    emit(run, { type: 'background_tasks', tasks: [] });
  }
  broadcastRuns();
  return true;
}

/** The conversation on screen — what Stop means. */
export function abortActive() {
  return abortRun(viewKey());
}

export function abortAll() {
  for (const key of [...runtime.runs.keys()]) abortRun(key);
}

/** Title a run carries for the other tabs' "running" list and notifications. */
function runTitle(key, text) {
  if (key && !key.startsWith('draft:')) {
    const custom = decoratedSessions([{ id: key, title: '' }])[0]?.title;
    const t = custom || sessionTitle(key);
    if (t) return t;
  }
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 80 ? `${t.slice(0, 80)}…` : t) : null;
}

/**
 * The workspace files one reply produced: anything written there since the
 * run started, plus what its own file tools wrote — minus files another run
 * running alongside wrote with ITS file tools (those are that conversation's).
 */
function runArtifacts(run, entries) {
  const root = workspaceRoot();
  const since = run.startedAt - 1500;
  const mine = new Set([...run.writtenPaths].map((p) => path.relative(root, p)).filter((r) => r && !r.startsWith('..')));
  const others = new Set();
  for (const r of runtime.runs.values()) {
    if (r === run) continue;
    for (const p of r.writtenPaths) others.add(path.relative(root, p));
  }
  return entries
    .filter((e) => mine.has(e.path) || (e.mtime >= since && !others.has(e.path)))
    .filter((e) => !/\.conflict\d*/i.test(e.name))
    .slice(0, 24);
}

/**
 * Run one prompt in a conversation: `sessionKey` names it (a session id), or —
 * the usual case, a prompt typed in the UI — it is the conversation on screen,
 * and a new conversation on screen gets a draft key until its id arrives.
 */
export async function runQuery(ws, { text, permissionMode, model, effort, mode, project, autoAttempts = 0, sessionKey, steer = false }) {
  let key = sessionKey || viewKey();
  const existing = runFor(key);

  // The previous turn already reported its `result`, but a background task it
  // spawned (a subagent, a backgrounded shell command) is still running. Push
  // the new message into that SAME still-open run instead of aborting it below
  // — aborting would kill the background work, which is the bug this exists to
  // avoid. (autoAttempts !== 0 is a headless auto-continue resume, which always
  // starts its own run.)
  //
  // The same goes for a message sent *while a turn is working* when the user
  // means to add to it rather than start over (`steer`, the composer's send
  // button during a run): the CLI takes it in at its next step, without the
  // turn being stopped. The run then stays open until the CLI is idle again —
  // see `queuedInputs` in the run loop.
  const steering = autoAttempts === 0 && existing?.channel && (existing.phase === 'background' || (steer && existing.phase === 'turn'));
  if (steering) {
    if (isViewed(existing)) for (const c of connections) if (c !== ws) send(c, { type: 'user', text, sid: existing.key, steer: existing.phase === 'turn' });
    existing.queuedInputs = (existing.queuedInputs || 0) + 1;
    existing.channel.push(text);
    log('INFO', existing.phase === 'background'
      ? `prompt queued into backgrounded run (waiting on ${existing.backgroundTasks.size} task(s)): promptLen=${text.length}`
      : `message added to the working turn: promptLen=${text.length}`);
    if (model && model !== existing.model) {
      existing.model = model;
      existing.q.setModel(model).catch((e) => log('WARN', `setModel on backgrounded run failed: ${e?.message || e}`));
    }
    // Mode changes for ask/acceptEdits/bypass/plan are already picked up live by
    // makeCanUseTool reading run.permissionMode at call time; a run that
    // started in 'auto' can't be live-switched regardless of this path.
    if (permissionMode) { existing.permissionMode = permissionMode; runtime.activePermMode = permissionMode; }
    return;
  }

  // Chat / Code / Cowork (modes.js). Resolved before anything is torn down, so
  // a Cowork prompt with no project is refused without killing a running turn.
  const runMode = normalizeMode(mode);
  const runProject = runMode === 'cowork' ? (project || activeProject()) : null;
  const mo = modeOptions(runMode, {
    root: workspaceRoot(), project: runProject, projectDir: runProject ? projectDir(runProject) : null,
  });
  if (mo.error) {
    send(ws, { type: 'error', message: mo.error });
    return;
  }

  // Only this conversation's own run is replaced; the others carry on.
  if (existing) abortRun(key);
  if (!key) {
    key = newDraftKey();
    runtime.draftKey = key;
  }

  // A run that is not itself the auto-continue firing supersedes any scheduled
  // resume — the user has taken over. (fire() clears `pending` before calling in
  // here, so this is a no-op for that path.)
  if (autoAttempts === 0) {
    if (autoContinue.autoContinue.pending) autoContinue.cancel('superseded-by-prompt');
    autoContinue.clearLimitOffer('superseded-by-prompt');
  }

  const abortController = new AbortController();
  const startedAt = Date.now();
  const run = {
    key, sessionId: key.startsWith('draft:') ? null : key,
    abortController, channel: null, q: null, phase: 'turn', model, effort,
    permissionMode: permissionMode || DEFAULT_PERMISSION_MODE,
    backgroundTasks: new Map(), writtenPaths: new Set(),
    mode: runMode, project: runProject, title: runTitle(key, text), startedAt,
  };
  runtime.runs.set(key, run);
  runtime.activePermMode = run.permissionMode;
  const replyMessage = () => (run.title ? `Your reply is ready — ${run.title}` : 'Your reply is ready.');

  // Set if a 5-hour usage-limit rejection stops this run. Trusted over anything
  // that follows it — see the note by the 'result' handler.
  let limitHit = null;
  // tool_use id → tool name for this run: a tool_result carries only the id, and
  // an answered question has to be told apart from a real failure.
  const liveToolNames = new Map();

  // Show the user's message on other clients (the sender rendered it locally,
  // and the SDK persists it to the session store, so nothing is recorded here).
  if (isViewed(run)) for (const c of connections) if (c !== ws) send(c, { type: 'user', text, sid: run.key });

  // The CLI only sends `session_state_changed` (idle / running / requires_action)
  // when asked — it is the SDK's own "the turn is over" signal, which is what the
  // reply notification keys off rather than a guess from `result`.
  const opts = {
    cwd: WORK_DIR, abortController, plugins: PLUGINS, settings: MCP_FREE_SETTINGS,
    env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
  };
  if (model) opts.model = model;
  // Only override effort when the UI asked for a level; otherwise the SDK's own
  // model default applies.
  if (effort && EFFORT_LEVELS.has(effort)) opts.effort = effort;

  const hooks = hooksFor(run.permissionMode, run);
  if (hooks) opts.hooks = hooks;

  // Mode overrides (tools, plugins, setting sources, extra dirs) and the
  // system-prompt addendum telling Claude where the workspace is.
  Object.assign(opts, mo.opts);
  // File checkpoints, so a turn's file changes can be restored later from the
  // Changes panel (session-tools.js rewindTo). A chat turn writes no files.
  if (runMode !== 'chat') opts.enableFileCheckpointing = true;
  opts.systemPrompt = mo.systemPrompt ?? { type: 'preset', preset: 'claude_code', append: mo.append };
  // Image generation (image-gen.js), in every mode: into the Cowork project's
  // Images/ folder, else the workspace's, and counted as this run's artifact.
  opts.mcpServers = {
    ...(opts.mcpServers || {}),
    soufassistant: imageMcpServer({
      targetDir: () => path.join(mo.coworkDir || workspaceRoot(), 'Images'),
      onSaved: (abs) => run.writtenPaths.add(path.normalize(abs)),
      workspaceRoot,
    }),
  };
  opts.allowedTools = [...(opts.allowedTools || []), IMAGE_TOOL];
  if (mo.coworkDir) {
    const pre = [...(opts.hooks?.PreToolUse || []), { hooks: [coworkWriteGuard(mo.coworkDir, WORK_DIR)] }];
    opts.hooks = { ...(opts.hooks || {}), PreToolUse: pre };
  }
  // Skills switched off in the Skills panel (a listing filter; see skills.js).
  const skillOff = runMode === 'chat' ? null : disabledOverrides();
  if (skillOff) opts.settings = { ...opts.settings, skillOverrides: skillOff };

  if (run.permissionMode === 'auto') {
    // A model classifier approves or denies each tool — no prompts, no canUseTool.
    opts.permissionMode = 'auto';
  } else {
    // 'plan' is SDK-native (read-only, produces a plan) but still routes through
    // canUseTool so the ExitPlanMode approval surfaces as a normal prompt.
    if (run.permissionMode === 'plan') opts.permissionMode = 'plan';
    opts.canUseTool = makeCanUseTool(run);
  }

  // AskUserQuestion is intercepted before it runs (canUseTool, or the PreToolUse
  // hook in `auto` mode), so the tool never executes and the CLI's canned "the
  // user did not answer" cannot happen. `onUserDialog` is still registered — it
  // is the documented contract and costs nothing — in case a future SDK build
  // starts using it; it feeds the same pending-dialog map, so the browser side is
  // identical either way. (It does nothing on its own: the CLI fails closed on
  // any dialog_kind not also in supportedDialogKinds, and the tool needs its
  // toolConfig entry.)
  opts.supportedDialogKinds = ['askUserQuestion'];
  opts.toolConfig = { askUserQuestion: { previewFormat: 'html' } };
  opts.onUserDialog = (request, { signal }) => {
    log('INFO', `onUserDialog: ${request.dialogKind}`);
    return askQuestion(request.payload || {}, signal, run)
      .then((answer) => (answer ? { behavior: 'completed', result: answer } : { behavior: 'cancelled' }));
  };

  const resuming = !!run.sessionId;
  if (resuming) opts.resume = run.sessionId;

  /** Cache-inclusive context usage, pushed to every client after each result. */
  const reportContextUsage = async (q) => {
    try {
      const u = await q.getContextUsage();
      emit(run, {
        type: 'context_usage',
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        autoCompactThreshold: u.autoCompactThreshold,
        autoCompactEnabled: u.isAutoCompactEnabled,
      });
      const limit = (u.isAutoCompactEnabled && u.autoCompactThreshold) || u.maxTokens;
      const pct = limit ? Math.round((u.totalTokens / limit) * 100) : 0;
      const detail = `context ${u.totalTokens}/${limit} tokens (${pct}%)` +
        ` maxTokens=${u.maxTokens} autoCompact=${u.isAutoCompactEnabled ? 'on' : 'off'}` +
        ` threshold=${u.autoCompactThreshold || 'n/a'}`;
      if (pct >= 90) log('WARN', `${detail} — near auto-compact; a turn may pause while it compacts`);
      else vlog(detail);
    } catch (e) { vlog(`getContextUsage failed: ${e?.message || e}`); }
  };

  // The SDK's own model catalog — account-filtered, the same list Claude Code's
  // /model picker is built from. Fire-and-forget: never awaited in the event
  // loop, so a slow or unimplemented control request cannot delay the stream,
  // and the catch means an older CLI simply leaves the static list in place.
  const reportModelCatalog = async (q) => {
    try {
      const rows = await q.supportedModels();
      const models = (rows || []).map(({ value, resolvedModel, displayName, description }) =>
        ({ value, resolvedModel, displayName, description }));
      if (!models.length) return;
      runtime.cachedModels = models;
      broadcast({ type: 'models', models });
      vlog(`models: ${models.length} offered`);
    } catch (e) { vlog(`supportedModels failed: ${e?.message || e}`); }
  };

  log('INFO', `query start: ${runMode}${runProject ? `(${runProject})` : ''} perm=${run.permissionMode} effort=${opts.effort || 'default'} ` +
    `model=${model || 'default'} resume=${resuming} promptLen=${text.length} running=${runtime.runs.size}`);

  // Streamed input — see the file header. Kept open until every background
  // task this run spawns has finished (maybeEndRun below), not just until the
  // foreground turn's own `result`.
  const channel = makeInputChannel(text);
  run.channel = channel;
  broadcastRuns();

  // Background tasks spawned by this run (subagents, backgrounded shell
  // commands). `background_tasks_changed` is the authoritative membership
  // signal (REPLACE semantics); `task_progress` only enriches the entries
  // already there. Ambient tasks (housekeeping, not activity) are excluded.
  let resultSeen = false;
  // If this CLI never sends session_state_changed, the run's genuine end (the
  // `finally` below) stands in for it, so a reply is still announced.
  let sawStateEvents = false;
  let failed = false;
  let droppedView = false;   // a stale id on screen was dropped: still "the one on screen" for the toast
  let runPhase = 'turn';
  let backgroundHeartbeatTicks = 0;

  const syncBackgroundTasks = (tasks) => {
    const next = new Map();
    for (const t of (tasks || [])) {
      if (t.ambient) continue;
      const prev = run.backgroundTasks.get(t.task_id);
      next.set(t.task_id, {
        id: t.task_id, description: t.description, type: t.task_type,
        lastTool: prev?.lastTool, summary: prev?.summary,
      });
    }
    run.backgroundTasks = next;
    emit(run, { type: 'background_tasks', tasks: [...next.values()] });
    maybeEndRun();
  };

  const updateBackgroundTaskProgress = (event) => {
    const t = run.backgroundTasks.get(event.task_id);
    if (!t) return;
    if (event.last_tool_name !== undefined) t.lastTool = event.last_tool_name;
    if (event.summary !== undefined) t.summary = event.summary;
    emit(run, { type: 'background_tasks', tasks: [...run.backgroundTasks.values()] });
  };

  /** Once the foreground turn has reported `result` AND no background task is
   *  left running, the input channel can close — only then is this run
   *  genuinely over. */
  function maybeEndRun() {
    if (!resultSeen) return;
    if (run.backgroundTasks.size > 0) {
      if (runPhase !== 'background') {
        runPhase = 'background';
        run.phase = 'background';
        broadcastRuns();
        log('INFO', `turn finished; waiting on ${run.backgroundTasks.size} background task(s): ` +
          [...run.backgroundTasks.values()].map((t) => t.description).join(', '));
      }
      return;
    }
    if (run.queuedInputs > 0 && runPhase !== 'background') {
      // A message was added while this run was working: the CLI answers it
      // (in the same turn or one of its own) and reports idle when nothing is
      // left. Wait for that, not for the first `result` after it was sent.
      armFollowUpTimer('message(s) added during the run');
      return;
    }
    if (runPhase === 'background') {
      // The last background task just ended, after the turn's `result`. The CLI
      // now hands its notification back to the model for a follow-up turn (a
      // queued prompt runs then too). Closing the channel here, as this used
      // to, cut that turn off mid-flight: its first tool call came back as
      // "The user doesn't want to take this action right now". So wait for the
      // follow-up's own `result` — unless no turn starts at all, which the
      // grace timer covers.
      runPhase = 'turn';
      run.phase = 'turn';
      resultSeen = false;
      broadcastRuns();
      log('INFO', 'background task(s) finished; waiting for the follow-up turn');
      armFollowUpTimer('the background task(s)');
      return;
    }
    channel.close();
  }
  let followUpTimer = null;
  // Ends the run if the turn being waited for never starts (no `assistant`
  // event within the grace period) — a safety net, never the normal path.
  function armFollowUpTimer(what) {
    if (followUpTimer) clearTimeout(followUpTimer);
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      if (abortController.signal.aborted) return;
      if (run.queuedInputs > 0) run.queuedInputs = 0;
      else if (resultSeen) return;
      log('INFO', `no follow-up turn after ${what}; ending run`);
      resultSeen = true;
      maybeEndRun();
    }, FOLLOW_UP_GRACE_MS);
  }

  // Stall watchdog — the reported "chat hangs" symptom. If no SDK event arrives
  // for a while during an active TURN (long thinking, a slow tool, a retry, or
  // auto-compaction), log how long it has been quiet so the app log shows
  // whether it is truly stuck or just working. Exempt while waiting on a
  // background task: that silence is expected, not a stall.
  let lastEventAt = Date.now();
  let lastEventKind = 'start';
  const watchdog = setInterval(() => {
    if (abortController.signal.aborted) return;
    if (runPhase === 'background') {
      backgroundHeartbeatTicks += 1;
      if (backgroundHeartbeatTicks % BACKGROUND_HEARTBEAT_TICKS === 0) {
        vlog(`still waiting on ${run.backgroundTasks.size} background task(s)`);
      }
      return;
    }
    const idleS = Math.round((Date.now() - lastEventAt) / 1000);
    if (idleS * 1000 >= STALL_WARN_MS) {
      log('WARN', `query quiet for ${idleS}s (last event: ${lastEventKind}) — still awaiting the SDK`);
    }
  }, STALL_CHECK_MS);

  let q;
  try {
    q = query({ prompt: channel.iterable, options: opts });
    run.q = q;
    for await (const event of q) {
      lastEventAt = Date.now();
      lastEventKind = event.type === 'system' ? `system/${event.subtype}` : event.type;

      if (event.type === 'system' && event.subtype === 'init') {
        const wasDraft = !run.sessionId;
        // A new conversation is filed under its real id from here on — and if it
        // is the one on screen, the view moves with it.
        if (rekey(run, event.session_id)) saveActive();
        if (rememberSessionMode(event.session_id, runMode, runProject)) {
          broadcast({ type: 'session_modes', modes: sessionModeMap() });
        }
        emit(run, { type: 'session', id: event.session_id });
        if (wasDraft) {
          broadcastRuns();
          if (isViewed(run)) broadcast({ type: 'sessions', sessions: decoratedSessions(), activeId: runtime.activeSessionId });
        }
        if (event.model) emit(run, { type: 'model', model: event.model });
        // Terminal-only commands (/exit, /statusline …) are dropped here rather
        // than in the browser, so there is one place that knows this is a
        // remote UI — see slash-commands.js.
        // A chat turn loads no plugins, so its list is not the app's real one.
        const commands = runMode === 'chat' ? null : usableSlashCommands(event);
        if (commands) {
          runtime.cachedSlashCommands = commands;
          broadcast({ type: 'slash_commands', commands });
          const hidden = event.slash_commands.length - commands.length;
          vlog(`slash commands: ${commands.length} offered${hidden ? `, ${hidden} terminal-only hidden` : ''}`);
        }
        vlog(`init: session=${event.session_id} model=${event.model}`);
        void reportModelCatalog(q);

      } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
        const m = event.compact_metadata || {};
        log('INFO', `compaction (${m.trigger || 'manual'}): ${m.pre_tokens || '?'} → ${m.post_tokens || '?'} tokens`);
        emit(run, { type: 'compacted', trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens });
        await reportContextUsage(q);

      } else if (event.type === 'system' && event.subtype === 'session_state_changed') {
        sawStateEvents = true;
        vlog(`session state: ${event.state}`);
        if (event.state === 'idle') {
          notify('reply', { title: 'Claude finished', message: replyMessage() });
          // Nothing left queued: an added message has been answered.
          if (run.queuedInputs > 0) {
            run.queuedInputs = 0;
            if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
            maybeEndRun();
          }
        }

      } else if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
        syncBackgroundTasks(event.tasks);

      } else if (event.type === 'system' && event.subtype === 'task_progress') {
        updateBackgroundTaskProgress(event);

      } else if (event.type === 'system' && event.subtype === 'task_notification') {
        // A background task ending — the chat-visible "background agent
        // finished" chip (see sessions.js lineToItems for the stored-transcript
        // equivalent). Ambient/non-transcript tasks say nothing here either.
        if (!event.ambient && !event.skip_transcript) {
          emit(run, { type: 'task_notice', taskId: event.task_id, status: event.status, summary: event.summary });
        }

      } else if (event.type === 'assistant') {
        // The follow-up turn after a background task (or for an added message)
        // has started: from here it ends with its own `result`, however long
        // its tools take.
        if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
        if (run.queuedInputs > 0 && resultSeen && !event.parent_tool_use_id) resultSeen = false;
        for (const block of (event.message?.content || [])) {
          if (block.type === 'text' && block.text) {
            vlog(`text: ${block.text.length} chars`);
            emit(run, { type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            vlog(`tool_use: ${block.name}`);
            liveToolNames.set(block.id, block.name);
            // What this conversation wrote with its own file tools — its
            // artifacts, even with another conversation writing alongside.
            if (FILE_TOOLS.has(block.name)) {
              const f = block.input?.file_path || block.input?.notebook_path;
              if (typeof f === 'string' && f.startsWith('/')) run.writtenPaths.add(path.normalize(f));
            }
            emit(run, { type: 'tool_use', id: block.id, name: block.name, input: block.input });
          }
        }

      } else if (event.type === 'user') {
        const content = event.message?.content;
        const originKind = event.origin?.kind;
        // A background task's own notification, or a delivered SubagentHandback
        // report, arriving live — never raw harness XML, never a user bubble.
        // Mirrors sessions.js's lineToItems for the exact same record read back
        // from the stored transcript after a reload.
        if (originKind === 'task-notification') {
          const notificationText = typeof content === 'string' ? content : '';
          const n = parseTaskNotification(notificationText) || {};
          emit(run, { type: 'task_notice', taskId: n.taskId || null,
            status: n.status || 'completed', summary: n.summary || 'Background task finished' });
        } else if (originKind === 'peer' && typeof event.origin.body === 'string') {
          emit(run, { type: 'agent_report', from: event.origin.name || event.origin.from || 'background agent',
            text: event.origin.body });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const raw = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b) => b.text || '').join('')
                : JSON.stringify(block.content);
            vlog(`tool_result: ${raw.length} chars${block.is_error ? ' (error)' : ''}`);
            // An answered question comes back as an error and must not be
            // rendered as one — see isQuestionAnswer().
            const answered = isQuestionAnswer(liveToolNames.get(block.tool_use_id), !!block.is_error, raw);
            liveToolNames.delete(block.tool_use_id);
            emit(run, { type: 'tool_result', id: block.tool_use_id, output: truncateOutput(raw),
              isError: !!block.is_error && !answered, answered });
          }
        }

      } else if (event.type === 'rate_limit_event') {
        // Subscription usage-limit telemetry. A 'rejected' five_hour is the
        // auto-continue trigger; warnings are surfaced but ignored.
        const info = event.rate_limit_info || {};
        vlog(`rate_limit: status=${info.status} type=${info.rateLimitType} ` +
          `resetsAt=${info.resetsAt || 'n/a'} util=${info.utilization ?? 'n/a'}`);
        broadcast({ type: 'rate_limit', status: info.status, rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt, utilization: info.utilization });
        refreshPlanUsage({ q, force: info.status !== 'allowed' });
        if (info.status === 'rejected' && info.rateLimitType === 'five_hour' && info.resetsAt) {
          limitHit = { resetsAt: info.resetsAt, rateLimitType: info.rateLimitType };
          log('WARN', `usage limit reached (five_hour); resets at ${new Date(info.resetsAt * 1000).toISOString()}`);
        }

      } else if (event.type === 'result') {
        // Not trusted to mean the turn finished: a usage-limit rejection can be
        // followed by a 'result' claiming subtype:'success' (cost $0, 1 turn)
        // before the generator throws for real — confirmed live. `limitHit`, set
        // from the actual rate_limit_event, is what the `finally` block acts on.
        if (runtime.credentialsExpired) {
          runtime.credentialsExpired = false;
          broadcast({ type: 'auth_status', authenticated: true });
        }
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        log('INFO', `result: ${event.subtype} in ${secs}s, ${event.num_turns} turns, ` +
          `$${(event.total_cost_usd || 0).toFixed(4)}`);
        emit(run, {
          type: 'result',
          success: event.subtype === 'success',
          cost: event.total_cost_usd,
          turns: event.num_turns,
          inputTokens: event.usage?.input_tokens ?? 0,
          outputTokens: event.usage?.output_tokens ?? 0,
          cacheReadTokens: event.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: event.usage?.cache_creation_input_tokens ?? 0,
          background: run.backgroundTasks.size > 0,
        });
        await reportContextUsage(q);
        // Plan limits moved with this turn — fire-and-forget, never delays the stream.
        refreshPlanUsage({ q });
        // A single streamed query can legitimately emit more than one `result`
        // — confirmed live: once for the foreground turn, then another each
        // time a background task's completion hands control back for a short
        // follow-up turn. Only close the channel once nothing is left running.
        resultSeen = true;
        maybeEndRun();
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const message = String(err?.message || err);
      log('ERROR', `query failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
      // A usage-limit rejection throws from HERE rather than ending quietly —
      // confirmed live, with wrapped text like "Claude Code returned an error
      // result: You've hit your session limit · resets …". None of that is a
      // fresh failure, so this branch does nothing when `limitHit` is set: the
      // `finally` block covers it, with no stale-session drop and no raw error
      // bubble on top of the notice.
      if (!limitHit) {
        if (isAuthError(message)) {
          // The SESSION is fine — keep it so the conversation resumes after
          // re-login. Dropping it here made a later "continue" start a new,
          // empty session.
          runtime.credentialsExpired = true;
          log('WARN', 'query failed on authentication — prompting re-login');
          broadcast({ type: 'auth_expired', subscription: isSubscriptionAuth() });
        }
        // Told before the pointer below moves — the tabs showing it are the ones to tell.
        emit(run, { type: 'error', message });
        if (!isAuthError(message) && resuming && runtime.activeSessionId === run.sessionId) {
          // A genuinely stale resume id — drop it so the next prompt starts
          // fresh. (A limit-hit session is not stale, and must keep its id: it is
          // exactly what auto-continue resumes from.)
          runtime.activeSessionId = null;
          saveActive();
          droppedView = true;
        }
        failed = true;
        notify('stopped', { title: 'Claude stopped', message: `${run.title ? `${run.title} — ` : ''}${message}`.slice(0, 200) });
      }
    }
  } finally {
    clearInterval(watchdog);
    if (followUpTimer) clearTimeout(followUpTimer);
    channel.close();   // idempotent — tidy up on an error/abort path too
    const stillMine = runtime.runs.get(run.key) === run;
    if (stillMine) runtime.runs.delete(run.key);
    if (run.backgroundTasks.size) {
      run.backgroundTasks = new Map();
      emit(run, { type: 'background_tasks', tasks: [] });
    }
    const aborted = abortController.signal.aborted;
    // A run replaced by a new prompt in the same conversation must not tell the
    // tabs "stopped" — that is the new run's screen now.
    const replaced = !!runFor(run.key);
    if (aborted) {
      log('INFO', `query aborted by user after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      if (!replaced) emit(run, { type: 'aborted' });
    }

    if (!sawStateEvents && !failed && !limitHit && !aborted && resultSeen) {
      notify('reply', { title: 'Claude finished', message: replyMessage() });
    }

    // What this reply wrote to the workspace — remembered with the
    // conversation, so the card (and the Artifacts menu) survive a reload.
    const entries = listWorkspaceEntries();
    if (run.sessionId) {
      const files = recordArtifacts(run.sessionId, runArtifacts(run, entries));
      if (files.length) emit(run, { type: 'turn_artifacts', sessionId: run.sessionId, files });
    }

    broadcastRuns();
    // Finished out of sight: every tab is told, so it can say so.
    if (!replaced && !droppedView && !isViewed(run)) {
      broadcast({ type: 'run_finished', key: run.key, sessionId: run.sessionId, title: run.title,
        ok: !failed && !aborted && !limitHit, aborted });
    }

    // The new or updated session (and its title) should appear in the list.
    broadcast({ type: 'sessions', sessions: decoratedSessions(), activeId: runtime.activeSessionId });

    // Anything the run just created — a new automation, a new entity — should be
    // linkable in the reply that announces it.
    refreshHaLinks().then(() =>
      broadcast({ type: 'ha_links', entities: runtime.haLinks.entities, automations: runtime.haLinks.automations }));

    // Likewise any file the run just wrote to the workspace — cheap (a bounded
    // directory walk) and only worth doing once the turn is actually over.
    broadcast({ type: 'workspace', entries });
    // A Cowork turn may have started (or stopped) a preview server.
    broadcast({ type: 'previews', previews: listPreviews() });

    if (limitHit && !aborted) {
      notify('stopped', { title: 'Claude hit the usage limit', message: 'The 5-hour limit was reached.' });
      autoContinue.handleLimitHit(limitHit, {
        model, effort,
        permissionMode: run.permissionMode,
        autoAttempts,
        sessionId: run.sessionId,
      });
    }
  }
}
