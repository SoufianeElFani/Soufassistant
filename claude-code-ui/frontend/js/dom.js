/*
 * Every element the app touches, looked up once.
 * 
 * The app is served from the Home Assistant ingress path, so the WebSocket URL is
 * derived from the page location rather than hardcoded.
 */

// Derive WebSocket URL from current page location so it works through HA ingress
export const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
export const wsBase  = location.pathname.replace(/\/+$/, '');
export const wsUrl   = `${wsProto}//${location.host}${wsBase}/ws`;

export const loginScreen    = document.getElementById('login-screen');
export const loginBtn       = document.getElementById('login-btn');
export const loginUrlSect   = document.getElementById('login-url-section');
export const loginUrlEl     = document.getElementById('login-url');
export const loginCodeForm  = document.getElementById('login-code-form');
export const loginCodeInput = document.getElementById('login-code-input');
export const loginWaiting   = document.getElementById('login-waiting');
export const messagesEl     = document.getElementById('messages');
export const inputForm      = document.getElementById('input-form');
export const promptInput    = document.getElementById('prompt-input');
export const sendBtn        = document.getElementById('send-btn');
export const statusDot      = document.getElementById('status-dot');
export const permModeSelect = document.getElementById('perm-mode');
export const newSessionBtn  = document.getElementById('new-session-btn');
export const settingsBtn    = document.getElementById('settings-btn');
export const settingsPanel  = document.getElementById('settings-panel');
export const modelSelect    = document.getElementById('model-select');
export const effortSelect   = document.getElementById('effort-select');
export const autoContinueToggle = document.getElementById('auto-continue-toggle');
export const autoContinueRow    = document.getElementById('auto-continue-row');
export const autoContinueHint   = document.getElementById('auto-continue-hint');
export const notifyService   = document.getElementById('notify-service');
export const notifyReply     = document.getElementById('notify-reply');
export const notifyAttention = document.getElementById('notify-attention');
export const notifyTest      = document.getElementById('notify-test');
export const notifyHint      = document.getElementById('notify-hint');
export const acBanner       = document.getElementById('auto-continue-banner');
export const acBannerText   = document.getElementById('ac-banner-text');
export const acBannerCancel = document.getElementById('ac-banner-cancel');
export const acBannerEnable = document.getElementById('ac-banner-enable');
export const sessionsBtn    = document.getElementById('sessions-btn');
export const sessionsPanel  = document.getElementById('sessions-panel');
export const sessionsListEl = document.getElementById('sessions-list');
export const sessionsFilterEl = document.getElementById('sessions-filter');
export const findBtn        = document.getElementById('find-btn');
export const findBar        = document.getElementById('find-bar');
export const findInput      = document.getElementById('find-input');
export const findCount      = document.getElementById('find-count');
export const findPrev       = document.getElementById('find-prev');
export const findNext       = document.getElementById('find-next');
export const findClose      = document.getElementById('find-close');
export const permOverlay    = document.getElementById('permission-overlay');
export const permTitle      = document.getElementById('perm-title');
export const permToolChip   = document.getElementById('perm-tool-chip');
export const permInputEl    = document.getElementById('perm-input');
export const permAllow      = document.getElementById('perm-allow');
export const permAlways     = document.getElementById('perm-always');
export const permAlwaysHint = document.getElementById('perm-always-hint');
export const permDeny       = document.getElementById('perm-deny');
export const permLater      = document.getElementById('perm-later');
export const dialogOverlay  = document.getElementById('dialog-overlay');
export const dialogTitle    = document.getElementById('dialog-title');
export const dialogBody     = document.getElementById('dialog-body');
export const dialogSubmit   = document.getElementById('dialog-submit');
export const dialogSkip     = document.getElementById('dialog-skip');
export const dialogBack     = document.getElementById('dialog-back');
export const dialogLater    = document.getElementById('dialog-later');
export const dialogProgress = document.getElementById('dialog-progress');
export const confirmOverlay = document.getElementById('confirm-overlay');
export const confirmTitle   = document.getElementById('confirm-title');
export const confirmBody    = document.getElementById('confirm-body');
export const confirmYes     = document.getElementById('confirm-yes');
export const confirmNo      = document.getElementById('confirm-no');
export const chatScroll     = document.getElementById('chat-scroll');
export const promptPrevBtn  = document.getElementById('prompt-prev');
export const promptNextBtn  = document.getElementById('prompt-next');
export const questionStrip     = document.getElementById('question-strip');
export const questionStripText = document.getElementById('question-strip-text');
export const questionStripOpen = document.getElementById('question-strip-open');
export const bgTasksStrip      = document.getElementById('bg-tasks-strip');
export const bgTasksText       = document.getElementById('bg-tasks-text');

export const tasksBtn       = document.getElementById('tasks-btn');
export const tasksPanel     = document.getElementById('tasks-panel');
export const tasksListEl    = document.getElementById('tasks-list');

export const workspaceBtn    = document.getElementById('workspace-btn');
export const workspacePanel  = document.getElementById('workspace-panel');
export const workspaceListEl = document.getElementById('workspace-list');

export const scheduledBtn       = document.getElementById('scheduled-btn');
export const scheduledPanel     = document.getElementById('scheduled-panel');
export const scheduledListEl    = document.getElementById('scheduled-list');
export const scheduledNewBtn    = document.getElementById('scheduled-new-btn');
export const scheduledForm      = document.getElementById('scheduled-form');
export const scheduledNameInput = document.getElementById('scheduled-name-input');
export const scheduledCronInput = document.getElementById('scheduled-cron-input');
export const scheduledPromptInput = document.getElementById('scheduled-prompt-input');
export const scheduledFormError = document.getElementById('scheduled-form-error');
export const scheduledFormCancel = document.getElementById('scheduled-form-cancel');
export const scheduledFormSave   = document.getElementById('scheduled-form-save');

export const teamBtn         = document.getElementById('team-btn');
export const teamPanel       = document.getElementById('team-panel');
export const teamListEl      = document.getElementById('team-list');
export const teamNewBtn      = document.getElementById('team-new-btn');
export const teamForm        = document.getElementById('team-form');
export const teamNameInput   = document.getElementById('team-name-input');
export const teamRoleInput   = document.getElementById('team-role-input');
export const teamNotesInput  = document.getElementById('team-notes-input');
export const teamFormError   = document.getElementById('team-form-error');
export const teamFormCancel  = document.getElementById('team-form-cancel');
export const teamFormSave    = document.getElementById('team-form-save');

export const usageBtn    = document.getElementById('usage-btn');
export const usagePanel  = document.getElementById('usage-panel');
export const usageBodyEl = document.getElementById('usage-body');

export const cmdMenu = document.getElementById('cmd-menu');
export const attachInput   = document.getElementById('attach-input');
export const attachBtn     = document.getElementById('attach-btn');
export const attachPreview = document.getElementById('attach-preview');

export const loginTitle = document.getElementById('login-title');
export const loginDesc  = document.getElementById('login-desc');

// ── Modes (Chat / Code / Cowork) ──
export const modeSwitch        = document.getElementById('mode-switch');
export const coworkProjectSel  = document.getElementById('cowork-project');

// ── Workspace panel (beyond the list above) ──
export const workspaceInfoEl      = document.getElementById('workspace-info');
export const workspaceFolderBtn   = document.getElementById('workspace-folder-btn');
export const workspaceRootForm    = document.getElementById('workspace-root-form');
export const workspaceRootInput   = document.getElementById('workspace-root-input');
export const workspaceRootError   = document.getElementById('workspace-root-error');
export const workspaceRootDefault = document.getElementById('workspace-root-default');
export const workspaceRootCancel  = document.getElementById('workspace-root-cancel');
export const workspaceProjectsEl  = document.getElementById('workspace-projects');
export const workspaceNewProject  = document.getElementById('workspace-new-project');

// ── Skills panel ──
export const skillsBtn        = document.getElementById('skills-btn');
export const skillsPanel      = document.getElementById('skills-panel');
export const skillsInfoEl     = document.getElementById('skills-info');
export const skillsListEl     = document.getElementById('skills-list');
export const skillsNewBtn     = document.getElementById('skills-new-btn');
export const skillForm        = document.getElementById('skill-form');
export const skillNameInput   = document.getElementById('skill-name-input');
export const skillDescInput   = document.getElementById('skill-desc-input');
export const skillBodyInput   = document.getElementById('skill-body-input');
export const skillFormError   = document.getElementById('skill-form-error');
export const skillFormCancel  = document.getElementById('skill-form-cancel');
export const skillView        = document.getElementById('skill-view');
export const skillViewTitle   = document.getElementById('skill-view-title');
export const skillViewBody    = document.getElementById('skill-view-body');
export const skillViewClose   = document.getElementById('skill-view-close');

// ── Artifact viewer ──
export const artifactPane     = document.getElementById('artifact-pane');
export const artifactTitle    = document.getElementById('artifact-title');
export const artifactBody     = document.getElementById('artifact-body');
export const artifactOpen     = document.getElementById('artifact-open');
export const artifactDownload = document.getElementById('artifact-download');
export const artifactReload   = document.getElementById('artifact-reload');
export const artifactClose    = document.getElementById('artifact-close');
export const artifactSwitch   = document.getElementById('artifact-switch');
export const artifactsBtn     = document.getElementById('artifacts-btn');
export const artifactsMenu    = document.getElementById('artifacts-menu');
export const artifactsMenuList = document.getElementById('artifacts-menu-list');
export const composerModeSel    = document.getElementById('composer-mode');
export const composerProjectSel = document.getElementById('composer-project');
export const settingsSkillsBtn  = document.getElementById('settings-skills-btn');

// ── Conversations: search, changes ──
export const sessionsSearch   = document.getElementById('sessions-search');
export const changesOpenBtn   = document.getElementById('changes-open-btn');
export const changesPanel     = document.getElementById('changes-panel');
export const changesTitle     = document.getElementById('changes-title');
export const changesList      = document.getElementById('changes-list');
export const changesClose     = document.getElementById('changes-close');

// ── Workspace: new file, live previews; artifact editor ──
export const workspaceNewFile   = document.getElementById('workspace-new-file');
export const workspacePreviews  = document.getElementById('workspace-previews');
export const artifactEdit       = document.getElementById('artifact-edit');
export const artifactSave       = document.getElementById('artifact-save');
export const artifactCancel     = document.getElementById('artifact-cancel');
export const artifactDelete     = document.getElementById('artifact-delete');

// Roles: the picker under the message box and the panel that manages them.
export const rolesBtn          = document.getElementById('roles-btn');
export const rolesCount        = document.getElementById('roles-count');
export const rolesMenu         = document.getElementById('roles-menu');
export const rolesChips        = document.getElementById('roles-chips');
export const rolesPanel        = document.getElementById('roles-panel');
export const rolesListEl       = document.getElementById('roles-list');
export const rolesNewBtn       = document.getElementById('roles-new-btn');
export const roleForm          = document.getElementById('role-form');
export const roleNameInput     = document.getElementById('role-name-input');
export const roleShortInput    = document.getElementById('role-short-input');
export const roleContextInput  = document.getElementById('role-context-input');
export const roleFormError     = document.getElementById('role-form-error');
export const roleFormCancel    = document.getElementById('role-form-cancel');
export const settingsRolesBtn  = document.getElementById('settings-roles-btn');
