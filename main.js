const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, dialog, globalShortcut, powerMonitor } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const https = require('https');
const {
  applyDeployWatchDeadline,
  deployPhaseDetail,
  findGithubApiProblem,
  githubApiFailureDetail,
  githubApiRetryDetail,
  isAdoptedProbePhase,
  isTransientGithubApiProblem,
  resolveDeployPhase,
  shouldRefreshRepoCi
} = require('./deploy-status');
const {
  applyDeployWatchUpdate,
  applyDeployState,
  clearDeployState,
  markDeployState,
  needsAttentionRepo,
  pruneDeployErrorsForRepos,
  pruneDeployStatesForRepos,
  repoDeployEnabled,
  repoKey,
  sanitizeDeployErrors,
  sanitizeDeployStates,
  sortReposByAttention
} = require('./repo-state');
const {
  formatGitError,
  isGitAuthError,
  isRebaseConflictError,
  pullRebaseCommand,
  pushCommand
} = require('./git-sync');
const {
  buildCommitArgs,
  ensureCommitMessage,
  parseCommitMessage,
  textFromContent
} = require('./commit-message');
const {
  loadConfigFile,
  saveConfigFile
} = require('./config-store');
const {
  mergeRepoGithubSecrets,
  parseGithubRemote,
  resolveGithubToken
} = require('./github-auth');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai');
const { autoUpdater } = require('electron-updater');

// Associa processo ao atalho no Windows — ícone correto na busca/Start Menu
app.setAppUserModelId('com.rony.git-monitor');

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'icon.ico');
}

// Garante que o PATH inclui locais comuns do Git no Windows
const GIT_PATHS = [
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\Git\\bin',
  'C:\\Program Files (x86)\\Git\\cmd',
  'C:\\Program Files (x86)\\Git\\bin',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd'),
  path.join(process.env.USERPROFILE  || '', 'AppData', 'Local', 'Programs', 'Git', 'cmd'),
];
const extraPaths = GIT_PATHS.filter(p => fs.existsSync(p)).join(path.delimiter);
if (extraPaths) {
  process.env.PATH = extraPaths + path.delimiter + (process.env.PATH || '');
}

function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// ============================================================
// Mutex por repositório — evita conflitos de .git/index.lock
// ============================================================
const repoLocks = new Map();

function getRepoLock(repoPath) {
  const key = path.resolve(repoPath);
  if (!repoLocks.has(key)) {
    repoLocks.set(key, { queue: Promise.resolve(), writing: false });
  }
  return repoLocks.get(key);
}

function acquireRepoLock(repoPath, timeoutMs = 60000) {
  const lock = getRepoLock(repoPath);
  let release;
  const prev = lock.queue;
  lock.queue = new Promise(resolve => { release = resolve; });
  const timeoutP = new Promise(resolve => setTimeout(() => {
    console.warn(`[GitMonitor] Lock timeout (${timeoutMs}ms) em ${repoPath} - forcando release`);
    resolve();
  }, timeoutMs));
  return Promise.race([prev, timeoutP]).then(() => release);
}

function markWriting(repoPath, value) {
  getRepoLock(repoPath).writing = value;
}

function isWriting(repoPath) {
  const key = path.resolve(repoPath);
  const lock = repoLocks.get(key);
  return lock ? lock.writing : false;
}

// Remove index.lock stale (mais de 5 minutos sem modificação)
function cleanStaleLock(repoPath) {
  const lockFile = path.join(repoPath, '.git', 'index.lock');
  try {
    if (!fs.existsSync(lockFile)) return false;
    const stat = fs.statSync(lockFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 5 * 60 * 1000) {
      fs.unlinkSync(lockFile);
      console.log(`[GitMonitor] Removido index.lock stale de ${repoPath} (idade: ${Math.round(ageMs / 1000)}s)`);
      return true;
    }
  } catch (e) { }
  return false;
}

// Detecta e converte path WSL (\\wsl.localhost\Distro\...) para Unix path
function parseWslPath(p) {
  if (!p) return null;
  const normalized = p.replace(/\//g, '\\');
  const m = normalized.match(/^\\\\wsl[.$][^\\]*\\([^\\]+)(\\.*)?$/i);
  if (!m) return null;
  const distro = m[1];
  const rest = (m[2] || '').replace(/\\/g, '/') || '/';
  return { distro, unixPath: rest };
}

// Wrapper para comandos git com retry em caso de index.lock
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
};

async function gitExec(cmd, opts) {
  const noPromptOpts = opts
    ? { ...opts, env: { ...process.env, ...GIT_NO_PROMPT_ENV, ...(opts.env || {}) } }
    : { env: { ...process.env, ...GIT_NO_PROMPT_ENV } };

  const wsl = opts && opts.cwd ? parseWslPath(opts.cwd) : null;
  if (wsl) {
    // Extrai os args do git (tudo após "git ") e adiciona -C <unixPath>
    const gitArgs = cmd.replace(/^git\s+/, '');
    const wslCmd = `wsl.exe -d ${wsl.distro} -- git -C "${wsl.unixPath}" ${gitArgs}`;
    const wslOpts = { ...noPromptOpts, cwd: undefined, windowsHide: true };
    for (let i = 0; i < 2; i++) {
      try {
        return await execAsync(wslCmd, wslOpts);
      } catch (err) {
        const isLockError = err.message && err.message.includes('index.lock');
        if (isLockError && i === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw err;
      }
    }
    return;
  }

  for (let i = 0; i < 2; i++) {
    try {
      return await execAsync(cmd, noPromptOpts);
    } catch (err) {
      const isLockError = err.message && err.message.includes('index.lock');
      if (isLockError && i === 0) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

async function gitExecFile(args, opts) {
  const noPromptOpts = opts
    ? { ...opts, env: { ...process.env, ...GIT_NO_PROMPT_ENV, ...(opts.env || {}) } }
    : { env: { ...process.env, ...GIT_NO_PROMPT_ENV } };

  const wsl = opts && opts.cwd ? parseWslPath(opts.cwd) : null;
  const file = wsl ? 'wsl.exe' : 'git';
  const execArgs = wsl
    ? ['-d', wsl.distro, '--', 'git', '-C', wsl.unixPath, ...args]
    : args;
  const execOpts = wsl ? { ...noPromptOpts, cwd: undefined, windowsHide: true } : noPromptOpts;

  for (let i = 0; i < 2; i++) {
    try {
      return await execFileAsync(file, execArgs, execOpts);
    } catch (err) {
      const isLockError = err.message && err.message.includes('index.lock');
      if (isLockError && i === 0) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

const GIT_AUTH_ERROR_MESSAGE = 'Credencial GitHub invalida/expirada para Git HTTPS. Rode gh auth refresh -h github.com -s repo -s workflow e gh auth setup-git, ou configure SSH.';

async function verifyGitRemoteAccess(repoPath, branch) {
  try {
    await gitExecFile(['ls-remote', '--heads', 'origin', branch], {
      cwd: repoPath,
      timeout: 15000
    });
  } catch (e) {
    if (isGitAuthError(e)) {
      throw new Error(GIT_AUTH_ERROR_MESSAGE);
    }
    throw new Error(`Nao foi possivel validar o Git remoto antes de criar commit: ${formatGitError(e)}`);
  }
}

// ============================================================
// CONFIGURAÇÃO
// ============================================================
// Sempre AppData\Roaming\git-monitor\config.json — dev e prod compartilham
// (nome do app vem de package.json "name"; electron-builder usa o mesmo).
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const CONFIG_BACKUP_FILE = path.join(app.getPath('userData'), 'config.backup.json');
const AI_PROVIDERS = ['anthropic', 'openai', 'openrouter'];
const AI_MODEL_OPTIONS = {
  anthropic: [
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', detail: 'padrao atual' }
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', detail: 'fallback rapido' }
  ],
  openrouter: [
    { id: 'tencent/hy3-preview', name: 'Hy3 preview', detail: 'Tencent' },
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', detail: 'DeepSeek' },
    { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', detail: 'Anthropic' },
    { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', detail: 'Anthropic' },
    { id: 'openrouter/owl-alpha', name: 'Owl Alpha', detail: 'OpenRouter' }
  ]
};
const DEFAULT_AI_MODELS = {
  anthropic: AI_MODEL_OPTIONS.anthropic[0].id,
  openai: AI_MODEL_OPTIONS.openai[0].id,
  openrouter: AI_MODEL_OPTIONS.openrouter[0].id
};

function normalizeAiProvider(provider) {
  return AI_PROVIDERS.includes(provider) ? provider : 'anthropic';
}

function normalizeAiModel(provider, model) {
  const options = AI_MODEL_OPTIONS[provider] || [];
  return options.some(opt => opt.id === model)
    ? model
    : DEFAULT_AI_MODELS[provider];
}

function isDeployModeDisabled(mode) {
  return ['none', 'monitor', 'monitoring', 'disabled', 'off', 'no-deploy'].includes(String(mode || '').toLowerCase());
}

function isDeployModeEnabled(mode) {
  return ['enabled', 'deploy', 'ci', 'cicd', 'actions'].includes(String(mode || '').toLowerCase());
}

function hasValue(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return !!(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function hasDeployFieldEvidence(repo = {}) {
  if (repo.hasDeploy === true) return true;
  return [
    'deploy',
    'deployment',
    'deployCommand',
    'deployProvider',
    'deployUrl',
    'deployWorkflow',
    'deployWorkflowName',
    'deployWorkflowFile'
  ].some(field => hasValue(repo[field]));
}

function hasLocalWorkflow(repoPath) {
  if (!repoPath) return false;
  try {
    const workflowsDir = path.join(repoPath, '.github', 'workflows');
    if (!fs.existsSync(workflowsDir)) return false;
    return fs.readdirSync(workflowsDir).some(name => /\.ya?ml$/i.test(name));
  } catch (_) {
    return false;
  }
}

function normalizeRepoDeployConfig(repo = {}) {
  const next = { ...repo };
  if (next.deployEnabled === false || next.hasDeploy === false || isDeployModeDisabled(next.deployMode)) {
    next.deployEnabled = false;
    return next;
  }
  if (
    next.deployEnabled === true ||
    isDeployModeEnabled(next.deployMode) ||
    hasDeployFieldEvidence(next) ||
    hasLocalWorkflow(next.path)
  ) {
    next.deployEnabled = true;
    return next;
  }
  next.deployEnabled = false;
  return next;
}

function normalizeReposDeployConfig(repos) {
  return (repos || []).map(repo => normalizeRepoDeployConfig(repo));
}

function migrateConfigIfNeeded() {
  if (!app.isPackaged) return;
  const oldPath = path.join(path.dirname(process.execPath), 'config.json');
  if (fs.existsSync(oldPath) && !fs.existsSync(CONFIG_FILE)) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.copyFileSync(oldPath, CONFIG_FILE);
    } catch (e) { }
  }
}

function getDefaultConfig() {
  return {
    repos: [
      { name: "Meu Projeto", path: "C:\\caminho\\do\\repositorio", deployEnabled: false },
    ],
    intervalSeconds: 30,
    collapsed: false,
    opacity: 1.0,
    locked: false,
    windowX: null,
    windowY: null,
    windowHeight: 420,
    anthropicKey: '',
    openaiKey: '',
    openrouterKey: '',
    aiProvider: 'anthropic',
    anthropicModel: DEFAULT_AI_MODELS.anthropic,
    openaiModel: DEFAULT_AI_MODELS.openai,
    openrouterModel: DEFAULT_AI_MODELS.openrouter,
    anthropicAuthMode: 'oauth',
    openaiAuthMode: 'apiKey',
    githubToken: '',
    ghostZone: null,
    shortcutToggle: 'Control+Shift+G',
    shortcutMinimize: 'Control+Shift+M',
    widgetMode: 'floating',
    autoStart: true,
    theme: 'obsidian',
    deployErrors: {},
    deployStates: {}
  };
}

function loadConfig() {
  const loaded = loadConfigFile(CONFIG_FILE, getDefaultConfig, {
    backupFile: CONFIG_BACKUP_FILE,
    logger: console
  });
  const cfg = loaded.config;
  const originalDeployConfig = JSON.stringify({
    repos: cfg.repos || [],
    deployErrors: cfg.deployErrors || {},
    deployStates: cfg.deployStates || {}
  });

  cfg.repos = normalizeReposDeployConfig(cfg.repos);

  // migração: novos campos de authMode
  if (!cfg.anthropicAuthMode) cfg.anthropicAuthMode = 'oauth';
  if (!cfg.openaiAuthMode)    cfg.openaiAuthMode    = 'apiKey';
  if (!cfg.openrouterKey)     cfg.openrouterKey     = '';
  cfg.aiProvider       = normalizeAiProvider(cfg.aiProvider);
  cfg.anthropicModel   = normalizeAiModel('anthropic', cfg.anthropicModel);
  cfg.openaiModel      = normalizeAiModel('openai', cfg.openaiModel);
  cfg.openrouterModel  = normalizeAiModel('openrouter', cfg.openrouterModel);
  if (!cfg.theme)             cfg.theme             = 'obsidian';
  cfg.deployErrors = sanitizeDeployErrors(
    cfg.deployErrors && typeof cfg.deployErrors === 'object' ? cfg.deployErrors : {}
  );
  cfg.deployStates = sanitizeDeployStates(
    cfg.deployStates && typeof cfg.deployStates === 'object' ? cfg.deployStates : cfg.deployErrors
  );
  cfg.deployStates = pruneDeployStatesForRepos(cfg.deployStates, cfg.repos);
  cfg.deployErrors = pruneDeployErrorsForRepos(cfg.deployErrors, cfg.repos);

  const normalizedDeployConfig = JSON.stringify({
    repos: cfg.repos || [],
    deployErrors: cfg.deployErrors || {},
    deployStates: cfg.deployStates || {}
  });
  if (normalizedDeployConfig !== originalDeployConfig) {
    saveConfig(cfg);
  }
  return cfg;
}

function maskSecret(raw) {
  if (!raw || raw.length < 8) return raw ? '••••••••' : '';
  return raw.slice(0, 7) + '•'.repeat(Math.max(4, raw.length - 11)) + raw.slice(-4);
}

function saveConfig(cfg) {
  try {
    saveConfigFile(CONFIG_FILE, cfg, { backupFile: CONFIG_BACKUP_FILE });
  } catch (e) {
    console.error('[config] falha ao salvar config:', e.message);
  }
}

let mainWindow;
let configWindow;
let tray;
let config;
const WIDGET_TOPMOST_WATCHDOG_MS = 3000;
let widgetTopmostWatchdog = null;
// Pollers de cursor pausam com a sessão bloqueada e desaceleram com o cursor longe.
let inputPollersPaused = false;
const CURSOR_POLL_FAR_PX = 300;
function rectDistanceExceeds(cursor, rect, limit) {
  if (!rect) return true;
  const dx = Math.max(rect.x - cursor.x, cursor.x - (rect.x + rect.width), 0);
  const dy = Math.max(rect.y - cursor.y, cursor.y - (rect.y + rect.height), 0);
  return dx > limit || dy > limit;
}

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', payload);
  if (configWindow && !configWindow.isDestroyed()) configWindow.webContents.send('update-check-result', payload);
}

function hasAutoUpdateMetadata() {
  if (!app.isPackaged) return false;
  try {
    return fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  } catch (_) {
    return false;
  }
}

function localBuildUpdateStatus() {
  return {
    type: 'local-build',
    msg: 'Build local sem auto-update; use instalador/portable publicado'
  };
}

function checkForUpdatesSafely() {
  if (!app.isPackaged) {
    const status = { type: 'dev' };
    sendUpdateStatus(status);
    return status;
  }
  if (!hasAutoUpdateMetadata()) {
    const status = localBuildUpdateStatus();
    sendUpdateStatus(status);
    return status;
  }
  return autoUpdater.checkForUpdates();
}

function ensureWidgetOnTop(reason, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const shouldShow = !!options.show;
  const shouldFocus = !!options.focus && config && config.widgetMode !== 'notch';
  const showInactive = options.inactive || (config && config.widgetMode === 'notch');

  if (shouldShow) {
    try {
      if (showInactive && typeof mainWindow.showInactive === 'function') mainWindow.showInactive();
      else mainWindow.show();
    } catch (_) {}
  }

  try { mainWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  try { mainWindow.moveTop(); } catch (_) {}

  if (shouldFocus) {
    try { mainWindow.focus(); } catch (_) {}
  }

  return true;
}

function shouldRunWidgetTopmostWatchdog() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  try {
    if (!mainWindow.isVisible()) return false;
  } catch (_) {
    return false;
  }

  if (configWindow && !configWindow.isDestroyed()) return false;
  if (zoneWindow && !zoneWindow.isDestroyed()) return false;

  try {
    for (const win of diffWindows.values()) {
      if (win && !win.isDestroyed()) return false;
    }
  } catch (_) {}

  return true;
}

function startWidgetTopmostWatchdog() {
  if (widgetTopmostWatchdog) return;

  widgetTopmostWatchdog = setInterval(() => {
    if (!shouldRunWidgetTopmostWatchdog()) return;
    ensureWidgetOnTop('topmost-watchdog');
  }, WIDGET_TOPMOST_WATCHDOG_MS);

  if (typeof widgetTopmostWatchdog.unref === 'function') {
    widgetTopmostWatchdog.unref();
  }
}

function clampWindowPos(x, y, w = 300, h = 420) {
  // Garante que (x,y) fica dentro de algum display — evita janela fora da tela
  const displays = screen.getAllDisplays();
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const visible = displays.some(d => {
    const b = d.workArea;
    return centerX >= b.x && centerX <= b.x + b.width
        && centerY >= b.y && centerY <= b.y + b.height;
  });
  if (visible) return { x, y };
  const primary = screen.getPrimaryDisplay().workAreaSize;
  return { x: primary.width - w - 10, y: 10 };
}

let lastRepoResults = null;

function findConfiguredRepo(repoPath) {
  const key = repoKey(repoPath);
  return (config.repos || []).find(repo => repoKey(repo.path) === key) || null;
}

function mapReposForNotch(results) {
  const mapped = results.map(r => applyDeployState({
    name: r.name, path: r.path, status: r.status, detail: r.detail,
    branch: r.branch, ahead: r.ahead, behind: r.behind,
    changedFiles: r.changedFiles, remoteUrl: r.remoteUrl, headSha: r.headSha,
    deployEnabled: r.deployEnabled,
  }, config.deployStates));
  return mapped;
}

const THEME_BG = {
  obsidian: '#000000',
  slate:    '#1c2128',
  daylight: '#f6f8fa',
  nord:     '#2e3440',
  dracula:  '#282a36',
  matrix:   '#000000',
};
function themeBg(name) { return THEME_BG[name] || '#000000'; }

const FLOATING_WIDGET_WIDTH = 316;
const FLOATING_SHADOW_PAD = 16;
const FLOATING_WINDOW_WIDTH = FLOATING_WIDGET_WIDTH + FLOATING_SHADOW_PAD;

function createFloatingWindow() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  const rawX = config.windowX !== null ? config.windowX : screenW - FLOATING_WINDOW_WIDTH - 10;
  const rawY = config.windowY !== null ? config.windowY : 10;
  const { x: winX, y: winY } = clampWindowPos(rawX, rawY, FLOATING_WINDOW_WIDTH, config.windowHeight || 420);

  mainWindow = new BrowserWindow({
    width: FLOATING_WINDOW_WIDTH,
    height: config.windowHeight || 420,
    x: winX,
    y: winY,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    opacity: config.opacity || 1.0,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  ensureWidgetOnTop('floating-created');

  mainWindow.loadFile('index.html');

  if (config.locked) mainWindow.setMovable(false);

  // Salva posição ao mover manualmente
  mainWindow.on('moved', () => {
    if (resizeInterval) return; // ignora durante resize
    const [x, y] = mainWindow.getPosition();
    config.windowX = x;
    config.windowY = y;
    saveConfig(config);
  });

  // ---- Ghost mode: polling de cursor vs zona definida ----
  let isGhost = false;
  let isHovered = false;
  let fadeAnim = null;

  // Ao mostrar a janela (tray, atalho, zone-select close), reseta opacidade
  // e cancela fade em andamento — evita janela voltar quase-invisível.
  mainWindow.on('show', () => {
    if (fadeAnim) { clearInterval(fadeAnim); fadeAnim = null; }
    isGhost = false;
    try { mainWindow.setOpacity(config.opacity || 1.0); } catch (_) {}
    ensureWidgetOnTop('floating-show');
  });

  function fadeOpacity(from, to, durationMs) {
    if (fadeAnim) { clearInterval(fadeAnim); fadeAnim = null; }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const steps = 10;
    const stepMs = durationMs / steps;
    let step = 0;
    fadeAnim = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        clearInterval(fadeAnim);
        fadeAnim = null;
        return;
      }
      step++;
      const t = step / steps;
      const ease = 1 - Math.pow(1 - t, 2);
      const val = from + (to - from) * ease;
      try {
        mainWindow.setOpacity(Math.max(0.05, Math.min(1, val)));
      } catch (e) { clearInterval(fadeAnim); fadeAnim = null; }
      if (step >= steps) { clearInterval(fadeAnim); fadeAnim = null; }
    }, stepMs);
  }

  let ghostDelay = 150;
  let ghostTimer = null;
  const ghostTick = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();
    const wb = mainWindow.getBounds();

    // Cursor longe do widget e da ghost zone, sem estado ativo → cadência lenta.
    if (!isHovered && !isGhost
        && rectDistanceExceeds(cursor, { x: wb.x, y: wb.y, width: wb.width, height: wb.height }, CURSOR_POLL_FAR_PX)
        && (!config.ghostZone || rectDistanceExceeds(cursor, config.ghostZone, CURSOR_POLL_FAR_PX))) {
      ghostDelay = 450;
      return;
    }
    ghostDelay = 150;

    const onWidget = cursor.x >= wb.x && cursor.x < wb.x + wb.width
                  && cursor.y >= wb.y && cursor.y < wb.y + wb.height;

    // Mouse entrou no widget → sempre 100% com fade suave
    if (onWidget && !isHovered) {
      isHovered = true;
      isGhost = false;
      const current = mainWindow.getOpacity();
      if (current < 0.99) fadeOpacity(current, 1.0, 180);
      return;
    }

    // Mouse saiu do widget → volta à opacidade configurada
    if (!onWidget && isHovered) {
      isHovered = false;
      const target = config.opacity || 1.0;
      fadeOpacity(1.0, target, 200);
    }

    if (configWindow && !configWindow.isDestroyed()) {
      if (isGhost) { isGhost = false; fadeOpacity(mainWindow.getOpacity(), config.opacity || 1.0, 180); }
      return;
    }
    if (!config.ghostZone || onWidget) {
      if (isGhost) { isGhost = false; fadeOpacity(mainWindow.getOpacity(), config.opacity || 1.0, 180); }
      return;
    }

    const z = config.ghostZone;
    const inZone = cursor.x >= z.x && cursor.x < z.x + z.width
                && cursor.y >= z.y && cursor.y < z.y + z.height;

    const shouldGhost = inZone && !onWidget;

    if (shouldGhost && !isGhost) {
      isGhost = true;
      fadeOpacity(config.opacity || 1.0, 0.08, 220);
    } else if (!shouldGhost && isGhost) {
      isGhost = false;
      fadeOpacity(0.08, config.opacity || 1.0, 180);
    }
  };
  const ghostLoop = () => {
    if (!mainWindow || mainWindow.isDestroyed()) { ghostTimer = null; return; }
    if (!inputPollersPaused) ghostTick();
    ghostTimer = setTimeout(ghostLoop, inputPollersPaused ? 1000 : ghostDelay);
  };
  ghostLoop();

  mainWindow.on('closed', () => {
    if (fadeAnim) { clearInterval(fadeAnim); fadeAnim = null; }
    if (ghostTimer) { clearTimeout(ghostTimer); ghostTimer = null; }
  });
}

// Último rect reportado pelo renderer via IPC notch-rect.
// Fallback = baseline 310x38 top-right da janela.
const NOTCH_COMPACT_LEFT = 102;
const NOTCH_GHOST_ZONE_PAD_X = 28;
const NOTCH_GHOST_ZONE_PAD_Y = 18;
let notchRect = { w: 310, h: 38, offsetY: 0, hotzone: null, left: NOTCH_COMPACT_LEFT };
let _notchGhost = false;

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.width
      && point.y >= rect.y && point.y < rect.y + rect.height;
}

function inflateRect(rect, padX, padY) {
  return {
    x: rect.x - padX,
    y: rect.y - padY,
    width: rect.width + (padX * 2),
    height: rect.height + (padY * 2)
  };
}

function getNotchInteractionGeometry(bounds, rect) {
  const pillLeft = bounds.x + rect.left;
  const pillTop = bounds.y + (rect.offsetY || 0);
  const hitTop = rect.hotzone != null ? bounds.y : pillTop;
  const hitHeight = Math.max(1, rect.hotzone != null ? rect.hotzone : rect.h);
  const hitRect = {
    x: pillLeft,
    y: hitTop,
    width: Math.max(1, rect.w),
    height: hitHeight
  };

  return {
    hitRect,
    ghostZone: inflateRect(hitRect, NOTCH_GHOST_ZONE_PAD_X, NOTCH_GHOST_ZONE_PAD_Y)
  };
}

function setNotchGhostState(on, notifyRenderer = true) {
  const next = !!on;
  if (_notchGhost === next) return;
  _notchGhost = next;
  if (!notifyRenderer || !mainWindow || mainWindow.isDestroyed()) return;

  try {
    const wc = mainWindow.webContents;
    const send = () => {
      if (mainWindow && !mainWindow.isDestroyed() && wc && !wc.isDestroyed()) {
        wc.send('notch-ghost', next);
      }
    };
    if (wc.isLoading()) wc.once('did-finish-load', send);
    else send();
  } catch (_) {}
}

function sendNotchGhostState(on) {
  setNotchGhostState(on, true);
}

function createNotchWindow() {
  const display = screen.getPrimaryDisplay();
  const width = 440;
  // Folga pra overshoot do spring bouncy + expansão máxima (~360).
  const height = 420;
  const offsetX = config.notchOffsetX ?? 40;
  const SHADOW_R = 28; // espaço p/ sombra direita do pill
  const x = display.bounds.x + display.bounds.width - width - offsetX + SHADOW_R;
  const y = display.bounds.y;

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    minimizable: false,
    maximizable: false,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  ensureWidgetOnTop('notch-created');
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile('notch.html');

  // Reset do rect pra baseline — o renderer vai notificar via notch-rect.
  notchRect = { w: 310, h: 38, offsetY: 0, hotzone: null, left: NOTCH_COMPACT_LEFT };
  setNotchGhostState(false, false);

  // Passthrough com bbox dinâmico do pill real (não da window inteira).
  // O renderer envia `notch-rect` sempre que o state muda.
  let passthroughDelay = 100;
  let passthroughPoll = null;
  let lastIgnoreMouse = null;
  const passthroughTick = () => {
    if (_notchDragging) return;
    try {
      const c = screen.getCursorScreenPoint();
      const b = mainWindow.getBounds();
      const { hitRect, ghostZone } = getNotchInteractionGeometry(b, notchRect);
      const inside = pointInRect(c, hitRect);
      const shouldGhost = pointInRect(c, ghostZone) && !inside;
      sendNotchGhostState(shouldGhost);
      const ignore = !inside;
      if (ignore !== lastIgnoreMouse) {
        lastIgnoreMouse = ignore;
        mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
      }
      passthroughDelay = (!inside && !shouldGhost && rectDistanceExceeds(c, ghostZone, CURSOR_POLL_FAR_PX)) ? 300 : 100;
    } catch (_) {}
  };
  const passthroughLoop = () => {
    if (!mainWindow || mainWindow.isDestroyed()) { passthroughPoll = null; return; }
    if (!inputPollersPaused) passthroughTick();
    passthroughPoll = setTimeout(passthroughLoop, inputPollersPaused ? 1000 : passthroughDelay);
  };
  passthroughLoop();

  // Reposiciona se resolução mudar
  const repositionNotch = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const d = screen.getPrimaryDisplay();
    const nx = d.bounds.x + d.bounds.width - width - (config.notchOffsetX ?? 40) + 28;
    const ny = d.bounds.y;
    try { mainWindow.setBounds({ x: nx, y: ny, width, height }); } catch (_) {}
    ensureWidgetOnTop('notch-display-change');
  };
  screen.on('display-metrics-changed', repositionNotch);
  screen.on('display-added', repositionNotch);
  screen.on('display-removed', repositionNotch);

  mainWindow.on('closed', () => {
    if (passthroughPoll) { clearTimeout(passthroughPoll); passthroughPoll = null; }
    screen.removeListener('display-metrics-changed', repositionNotch);
    screen.removeListener('display-added', repositionNotch);
    screen.removeListener('display-removed', repositionNotch);
  });
}

function createWindowForMode() {
  const mode = config.widgetMode === 'notch' ? 'notch' : 'floating';
  if (mode === 'notch') createNotchWindow();
  else createFloatingWindow();
}

let switchingWidgetMode = false;
let pendingWidgetMode = null;
function switchWidgetMode(mode) {
  const next = mode === 'notch' ? 'notch' : 'floating';
  if (config.widgetMode === next && mainWindow && !mainWindow.isDestroyed()) return;

  if (next === 'notch' && config.ghostZone) {
    config._savedGhostZone = config.ghostZone;
    config.ghostZone = null;
  } else if (next === 'floating' && config._savedGhostZone) {
    config.ghostZone = config._savedGhostZone;
    delete config._savedGhostZone;
  }

  config.widgetMode = next;
  saveConfig(config);
  switchingWidgetMode = true;
  // Desvincula configWindow pra ela não morrer junto com o mainWindow antigo
  if (configWindow && !configWindow.isDestroyed()) {
    try { configWindow.setParentWindow(null); } catch (_) {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.destroy(); } catch (_) {}
  }
  createWindowForMode();
  ensureWidgetOnTop('mode-switch');
  if (configWindow && !configWindow.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
    try { configWindow.setParentWindow(mainWindow); } catch (_) {}
  }
  setImmediate(() => { switchingWidgetMode = false; });
}

function applyAutoStart(enabled) {
  if (!app.isPackaged) return; // só funciona em build empacotado
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: ['--hidden']
    });
  } catch (e) {
    console.warn('[GitMonitor] setLoginItemSettings falhou:', e.message);
  }
}

function isStartupHidden() {
  return process.argv.includes('--hidden');
}

// ============================================================
// Git Status Check (async — não bloqueia a thread principal)
// ============================================================
async function checkRepoOnce(repoPath) {
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
    return { status: 'error', detail: 'Repo não encontrado' };
  }

  // Pula polling se o repo está em operação de escrita
  if (isWriting(repoPath)) {
    return { status: 'busy', detail: 'Operação em andamento...' };
  }

  cleanStaleLock(repoPath);

  const release = await acquireRepoLock(repoPath);
  try {
    const gitOpts = { cwd: repoPath, timeout: 15000 };

    const [statusOutput, branch, headSha] = await Promise.all([
      gitExec('git --no-optional-locks status --porcelain', gitOpts).then(o => o.trim()),
      gitExec('git rev-parse --abbrev-ref HEAD', gitOpts).then(o => o.trim()),
      gitExec('git rev-parse HEAD', gitOpts).then(o => o.trim()),
    ]);

    // fetch separado — não compete com status
    await gitExec('git fetch --quiet', { cwd: repoPath, timeout: 20000 }).catch(() => {});

    let ahead = 0, behind = 0;
    try {
      const abOutput = (await gitExec(
        `git rev-list --left-right --count ${branch}...origin/${branch}`,
        gitOpts
      )).trim();
      const parts = abOutput.split(/\s+/);
      ahead = parseInt(parts[0]) || 0;
      behind = parseInt(parts[1]) || 0;
    } catch (e) { }

    const hasChanges = statusOutput.length > 0;
    const changedFiles = hasChanges ? statusOutput.split('\n').length : 0;

    let status, detail;
    if (hasChanges && ahead > 0 && behind > 0) {
      status = 'diverged';
      detail = `Divergido — faça pull antes de push`;
    } else if (hasChanges && ahead > 0) {
      status = 'dirty-ahead';
      detail = `${changedFiles} modificado(s), ${ahead} não pushed`;
    } else if (hasChanges && behind > 0) {
      status = 'dirty';
      detail = `${changedFiles} modificado(s) — pull pendente`;
    } else if (hasChanges) {
      status = 'dirty';
      detail = `${changedFiles} arquivo(s) modificado(s)`;
    } else if (ahead > 0 && behind > 0) {
      status = 'diverged';
      detail = `Divergido — ${ahead} push, ${behind} pull pendentes`;
    } else if (ahead > 0) {
      status = 'ahead';
      detail = `${ahead} commit(s) para push`;
    } else if (behind > 0) {
      status = 'behind';
      detail = `${behind} commit(s) para pull`;
    } else {
      status = 'clean';
      detail = 'Sincronizado';
    }

    let remoteUrl = '';
    try {
      remoteUrl = (await gitExec('git config --get remote.origin.url', { cwd: repoPath, timeout: 5000 })).trim();
    } catch (e) { }

    return { status, detail, branch, headSha, ahead, behind, changedFiles, remoteUrl };
  } finally {
    release();
  }
}

async function checkRepo(repoPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await checkRepoOnce(repoPath);
    } catch (e) {
      if (attempt === 1) return { status: 'error', detail: e.message.substring(0, 80) };
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function checkAllRepos() {
  const CONCURRENCY = 2;
  const repos = config.repos.filter(r => r.enabled !== false);
  const results = [];

  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const batch = repos.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async repo => ({
      name: repo.name,
      path: repo.path,
      deployEnabled: repoDeployEnabled(repo),
      ...await checkRepo(repo.path)
    })));
    results.push(...batchResults);
  }

  await reconcileDeployStatesForRepos(results);
  lastRepoResults = results;
  return results;
}

function deployStatesEqual(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

// Ultima consulta de CI por repo — evita consultar o GitHub a cada ciclo de polling
const ciProbeCache = new Map();

async function resolveDeployPhaseForRepoSnapshot(repo, deployState = null) {
  const sha = (deployState && deployState.sha) || (repo && repo.headSha) || '';
  const branch = (deployState && deployState.branch) || (repo && repo.branch) || '';
  const remoteUrl = (deployState && deployState.remoteUrl) || (repo && repo.remoteUrl) || '';
  if (!repo || !sha || !remoteUrl) return null;

  const gh = parseGithubRemote(remoteUrl);
  if (!gh) {
    return {
      phase: 'no-github',
      detail: 'Remote origin nao e GitHub; deploy nao monitorado',
      sha,
      branch,
      remoteUrl
    };
  }
  const tokenInfo = resolveGithubToken(findConfiguredRepo(repo.path), remoteUrl, config);
  if (!tokenInfo) {
    return {
      phase: 'no-token',
      detail: 'Configure um token GitHub global ou especifico deste repo',
      sha,
      branch,
      remoteUrl,
      owner: gh.owner,
      repo: gh.repo
    };
  }

  const workflowQuery = new URLSearchParams({ head_sha: sha, per_page: '50' });
  if (branch && branch !== 'HEAD') workflowQuery.set('branch', branch);

  const [workflowRes, checkRes, statusRes] = await Promise.all([
    githubApiGet(`/repos/${gh.owner}/${gh.repo}/actions/runs?${workflowQuery.toString()}`, tokenInfo.token),
    githubApiGet(`/repos/${gh.owner}/${gh.repo}/commits/${sha}/check-runs`, tokenInfo.token),
    githubApiGet(`/repos/${gh.owner}/${gh.repo}/commits/${sha}/status`, tokenInfo.token)
  ]);

  const hasWorkflowAccess = workflowRes.statusCode === 200;
  const hasCheckAccess  = checkRes.statusCode === 200;
  const hasStatusAccess = statusRes.statusCode === 200;
  const apiResponses = [workflowRes, checkRes, statusRes];
  if (!hasWorkflowAccess && !hasCheckAccess && !hasStatusAccess) {
    if (isTransientGithubApiProblem(apiResponses)) {
      return {
        phase: 'waiting',
        detail: githubApiRetryDetail(apiResponses),
        sha,
        branch,
        remoteUrl,
        owner: gh.owner,
        repo: gh.repo
      };
    }
    return {
      phase: 'error',
      detail: githubApiFailureDetail(workflowRes, checkRes, statusRes, gh),
      sha,
      branch,
      remoteUrl,
      owner: gh.owner,
      repo: gh.repo
    };
  }

  const workflowRuns = (hasWorkflowAccess && workflowRes.data.workflow_runs) ? workflowRes.data.workflow_runs : [];
  const checkRuns    = (hasCheckAccess && checkRes.data.check_runs) ? checkRes.data.check_runs : [];
  const statuses     = (hasStatusAccess && statusRes.data.statuses) ? statusRes.data.statuses : [];
  const statusTotal  = hasStatusAccess ? (statusRes.data.total_count || 0) : 0;

  const hasData = workflowRuns.length > 0 || checkRuns.length > 0 || statusTotal > 0;
  if (!hasData) {
    const startedAt = deployState && deployState.startedAt ? Number(deployState.startedAt) : 0;
    const noCiGraceMs = DEPLOY_INITIAL_DELAY_MS + (DEPLOY_NO_CI_ATTEMPTS * DEPLOY_POLL_INTERVAL_MS);
    if (deployState && isDeployStatePending(deployState) && startedAt && Date.now() - startedAt < noCiGraceMs) {
      return {
        phase: 'waiting',
        detail: 'Aguardando CI iniciar',
        sha,
        branch,
        remoteUrl,
        owner: gh.owner,
        repo: gh.repo
      };
    }
    const apiProblem = findGithubApiProblem([workflowRes, checkRes, statusRes]);
    if (apiProblem) {
      if (isTransientGithubApiProblem(apiResponses)) {
        return {
          phase: 'waiting',
          detail: githubApiRetryDetail(apiResponses),
          sha,
          branch,
          remoteUrl,
          owner: gh.owner,
          repo: gh.repo
        };
      }
      return {
        phase: 'error',
        detail: githubApiFailureDetail(workflowRes, checkRes, statusRes, gh),
        sha,
        branch,
        remoteUrl,
        owner: gh.owner,
        repo: gh.repo
      };
    }
    return {
      phase: 'no-ci',
      detail: 'Nenhum workflow, check-run ou commit status encontrado para este commit',
      sha,
      branch,
      remoteUrl,
      owner: gh.owner,
      repo: gh.repo
    };
  }

  const resolvedPhase = resolveDeployPhase({
    checkRuns,
    workflowRuns,
    statuses,
    combinedState: hasStatusAccess ? statusRes.data.state : null,
    statusTotal
  });
  return {
    ...applyDeployWatchDeadline(resolvedPhase, deployState),
    sha,
    branch,
    remoteUrl,
    owner: gh.owner,
    repo: gh.repo
  };
}

async function probeRepoCiState(repo, deployStates, now) {
  const deployPhase = await resolveDeployPhaseForRepoSnapshot(repo, null);
  if (!deployPhase || !isAdoptedProbePhase(deployPhase.phase)) return deployStates;

  return markDeployState(
    deployStates,
    repo.path,
    deployPhase.phase,
    deployPhaseDetail(deployPhase),
    now,
    {
      sha: deployPhase.sha,
      branch: deployPhase.branch,
      remoteUrl: deployPhase.remoteUrl,
      owner: deployPhase.owner,
      repo: deployPhase.repo,
      watchId: createDeployWatchId(repo.path, deployPhase.sha),
      startedAt: Number(deployPhase.activeRunStartedAt) || now
    }
  );
}

async function reconcileDeployStatesForRepos(results) {
  let next = pruneDeployStatesForRepos(config.deployStates, results);
  const now = Date.now();

  for (const repo of results) {
    const current = next[repoKey(repo.path)];
    if (current && current.phase === 'success') continue;

    const probeKey = repoKey(repo.path);
    if (!shouldRefreshRepoCi(repo, current, ciProbeCache.get(probeKey), now)) continue;
    ciProbeCache.set(probeKey, {
      sha: repo.headSha || '',
      branch: repo.branch || '',
      checkedAt: now
    });

    if (!current) {
      next = await probeRepoCiState(repo, next, now);
      continue;
    }

    const deployPhase = await resolveDeployPhaseForRepoSnapshot(repo, current);
    if (!deployPhase) continue;

    if (deployPhase.phase === 'success') {
      next = clearDeployState(next, repo.path);
    } else {
      const update = applyDeployWatchUpdate(next, repo.path, {
        ...deployPhase,
        detail: deployPhaseDetail(deployPhase),
        watchId: current.watchId || '',
        sha: deployPhase.sha,
        branch: deployPhase.branch,
        remoteUrl: deployPhase.remoteUrl,
        owner: deployPhase.owner,
        repo: deployPhase.repo
      }, Date.now());
      next = update.deployStates;
    }
  }

  if (!deployStatesEqual(config.deployStates, next)) {
    config.deployStates = next;
    saveConfig(config);
  }
}

// ============================================================
// IPC
// ============================================================
ipcMain.handle('check-repos', async () => {
  const results = await checkAllRepos();
  return sortReposByAttention(results.map(r => applyDeployState(r, config.deployStates)));
});
ipcMain.handle('get-config', () => config);

ipcMain.handle('get-cached-repos', () => {
  if (!lastRepoResults) return { repos: null, notch: null };
  const activePaths = new Set(
    config.repos.filter(r => r.enabled !== false).map(r => path.resolve(r.path))
  );
  const filtered = lastRepoResults
    .filter(r => activePaths.has(path.resolve(r.path)))
    .map(r => applyDeployState(r, config.deployStates));
  return {
    repos: sortReposByAttention(filtered),
    notch: { repos: sortReposByAttention(mapReposForNotch(filtered)), total: filtered.length }
  };
});

ipcMain.handle('save-repos', (_, repos) => {
  config.repos = normalizeReposDeployConfig(mergeRepoGithubSecrets(config.repos, repos));
  config.deployStates = pruneDeployStatesForRepos(config.deployStates, config.repos);
  config.deployErrors = pruneDeployErrorsForRepos(config.deployErrors, config.repos);
  saveConfig(config);
  lastRepoResults = null;
  return true;
});

ipcMain.handle('set-interval', (_, seconds) => {
  config.intervalSeconds = seconds;
  saveConfig(config);
  return true;
});

ipcMain.handle('close-app', () => app.quit());
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
ipcMain.handle('check-for-updates', () => {
  return checkForUpdatesSafely();
});

// ---- Zone select ----
let zoneWindow = null;

ipcMain.handle('start-zone-select', () => {
  if (config.widgetMode === 'notch') return;
  if (zoneWindow && !zoneWindow.isDestroyed()) {
    zoneWindow.focus();
    return;
  }

  // Esconde o Git Monitor durante a seleção
  mainWindow.hide();

  const display = screen.getPrimaryDisplay();
  zoneWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreen: true,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  zoneWindow.loadFile('zone-select.html');

  // Recovery: se renderer crashar ou travar, força restore do mainWindow
  const restoreMain = () => {
    ensureWidgetOnTop('zone-select-restore', { show: true });
  };
  zoneWindow.webContents.on('render-process-gone', restoreMain);
  zoneWindow.webContents.on('unresponsive', restoreMain);

  // Safety net: 2 minutos sem fechar → restaura mesmo assim
  const safetyTimer = setTimeout(() => {
    if (zoneWindow && !zoneWindow.isDestroyed()) {
      try { zoneWindow.close(); } catch (_) {}
    }
    restoreMain();
  }, 120000);

  zoneWindow.on('closed', () => {
    clearTimeout(safetyTimer);
    zoneWindow = null;
    restoreMain();
  });
});

ipcMain.on('zone-selected', (_, zone) => {
  config.ghostZone = zone;
  saveConfig(config);
  if (zoneWindow && !zoneWindow.isDestroyed()) zoneWindow.close();
  mainWindow.webContents.send('ghost-zone-updated', zone);
});

ipcMain.on('zone-cancelled', () => {
  if (zoneWindow && !zoneWindow.isDestroyed()) zoneWindow.close();
});

ipcMain.handle('clear-ghost-zone', () => {
  config.ghostZone = null;
  saveConfig(config);
  mainWindow.webContents.send('ghost-zone-updated', null);
});

// ---- Toast window ----
let toastWindow = null;
let toastTimer  = null;

function showToastWindow(text, type, duration) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  duration = duration || 3500;

  const TOAST_H = 50;
  const GAP     = 6;
  let tx, ty, tw;

  if (config.widgetMode === 'notch') {
    const d      = screen.getPrimaryDisplay();
    const offset = config.notchOffsetX ?? 40;
    tw = notchRect.w;
    tx = Math.round(d.bounds.x + d.bounds.width - offset - tw);
    ty = Math.round(d.bounds.y + notchRect.h + GAP);
  } else {
    const [wx, wy] = mainWindow.getPosition();
    const [ww, wh] = mainWindow.getSize();
    tw = ww;
    tx = wx;
    ty = wy + wh + GAP;
  }

  clearTimeout(toastTimer);

  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.setBounds({ x: tx, y: ty, width: tw, height: TOAST_H });
    toastWindow.webContents.send('toast-data', { text, type });
  } else {
    toastWindow = new BrowserWindow({
      width: tw, height: TOAST_H, x: tx, y: ty,
      frame: false, transparent: true, backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true, focusable: false,
      resizable: false, movable: false, hasShadow: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    try { toastWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
    try { toastWindow.setVisibleOnAllWorkspaces(true); } catch (_) {}
    toastWindow.setIgnoreMouseEvents(true);
    toastWindow.loadFile('toast.html');
    toastWindow.webContents.on('did-finish-load', () => {
      if (toastWindow && !toastWindow.isDestroyed())
        toastWindow.webContents.send('toast-data', { text, type });
    });
    toastWindow.on('closed', () => { toastWindow = null; });
  }

  toastTimer = setTimeout(() => {
    if (toastWindow && !toastWindow.isDestroyed()) toastWindow.destroy();
    toastWindow = null;
  }, duration);
}

ipcMain.on('show-toast', (_, { text, type, duration }) => {
  showToastWindow(text, type || 'err', duration);
});

function openConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus();
    return;
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  configWindow = new BrowserWindow({
    width: 640,
    height: 720,
    x: Math.round((sw - 640) / 2),
    y: Math.round((sh - 720) / 2),
    frame: false,
    backgroundColor: themeBg(config.theme),
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  configWindow.loadFile('config.html');
  configWindow.on('closed', () => {
    configWindow = null;
    ensureWidgetOnTop('config-closed');
  });
}

ipcMain.handle('open-config-window', () => openConfigWindow());

function sendNotchReveal() {
  if (!mainWindow || mainWindow.isDestroyed() || config.widgetMode !== 'notch') return;
  const wc = mainWindow.webContents;
  const reveal = () => {
    if (mainWindow && !mainWindow.isDestroyed() && wc && !wc.isDestroyed()) {
      wc.send('notch-reveal');
    }
  };
  if (wc.isLoading()) wc.once('did-finish-load', reveal);
  else reveal();
}

function showOrFocusWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindowForMode();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  ensureWidgetOnTop('show-or-focus', { show: true, focus: config.widgetMode !== 'notch' });

  if (config.widgetMode === 'notch') {
    sendNotchReveal();
    return;
  }
}

function notifyConfigSaved() {
  const targets = [mainWindow, configWindow].filter(w => w && !w.isDestroyed());
  for (const win of targets) {
    const wc = win.webContents;
    if (wc.isLoading()) {
      wc.once('did-finish-load', () => { if (!win.isDestroyed()) wc.send('config-saved'); });
    } else {
      wc.send('config-saved');
    }
  }
}

ipcMain.handle('close-config-window', () => {
  const pending = pendingWidgetMode;
  pendingWidgetMode = null;
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.once('closed', () => {
      if (pending !== null) switchWidgetMode(pending);
      notifyConfigSaved();
      ensureWidgetOnTop('config-save-closed');
    });
    configWindow.close();
  } else {
    if (pending !== null) switchWidgetMode(pending);
    notifyConfigSaved();
  }
});

ipcMain.handle('open-dialog', async () => {
  const win = configWindow && !configWindow.isDestroyed() ? configWindow : mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: 'Selecionar pasta do repositório',
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('test-repo', (_, repoPath) => {
  try {
    return fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));
  } catch {
    return false;
  }
});

ipcMain.handle('read-project-name', (_, repoPath) => {
  // Variáveis comuns de nome de projeto em .env
  const nameKeys = [
    'APP_NAME', 'NEXT_PUBLIC_APP_NAME', 'VITE_APP_NAME',
    'PROJECT_NAME', 'APPLICATION_NAME', 'REACT_APP_NAME',
    'APP_TITLE', 'SITE_NAME', 'NAME'
  ];

  // Arquivos .env a tentar (em ordem de prioridade)
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production'];

  for (const envFile of envFiles) {
    const envPath = path.join(repoPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const key of nameKeys) {
        const match = content.match(new RegExp(`^${key}\\s*=\\s*["']?([^"'\\r\\n]+)["']?`, 'm'));
        if (match && match[1].trim()) {
          return match[1].trim().replace(/^["']|["']$/g, '');
        }
      }
    } catch (e) { }
  }

  // Fallback: nome da pasta formatado (use-matias → Use Matias)
  const base = path.basename(repoPath);
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
});

function toggleCollapseApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (config.widgetMode === 'notch') return false; // no-op em modo notch
  config.collapsed = !config.collapsed;
  saveConfig(config);
  const [x, y] = mainWindow.getPosition();
  const newH = config.collapsed ? 38 : (config.windowHeight || 420);
  mainWindow.setBounds({ x, y, width: FLOATING_WINDOW_WIDTH, height: newH }, false);
  if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('collapse-changed', config.collapsed);
  }
  return config.collapsed;
}

ipcMain.handle('minimize-app', () => toggleCollapseApp());

ipcMain.handle('set-opacity', (_, value) => {
  config.opacity = value;
  saveConfig(config);
  if (config.widgetMode !== 'notch') mainWindow.setOpacity(value);
});


ipcMain.handle('snap-corner', (_, corner) => {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [ww, wh] = mainWindow.getSize();
  const m = 10;
  const positions = {
    tl: { x: m,          y: m },
    tr: { x: sw - ww - m, y: m },
    bl: { x: m,          y: sh - wh - m },
    br: { x: sw - ww - m, y: sh - wh - m },
  };
  const pos = positions[corner];
  if (pos) {
    mainWindow.setPosition(pos.x, pos.y);
    config.windowX = pos.x;
    config.windowY = pos.y;
    saveConfig(config);
  }
});

ipcMain.handle('set-locked', (_, locked) => {
  config.locked = locked;
  saveConfig(config);
  mainWindow.setMovable(!locked);
});

let resizeInterval = null;

ipcMain.on('resize-start', () => {
  if (resizeInterval) clearInterval(resizeInterval);

  const startCursorY = screen.getCursorScreenPoint().y;
  const startHeight  = mainWindow.getSize()[1];
  const [fixedX, fixedY] = mainWindow.getPosition();
  // scaleFactor converte pixels físicos (cursor) → pixels lógicos (janela)
  const scaleFactor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor;

  resizeInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(resizeInterval);
      return;
    }
    const cursorY = screen.getCursorScreenPoint().y;
    const delta = (cursorY - startCursorY) / scaleFactor;
    const newH = Math.max(150, Math.min(900, Math.round(startHeight + delta)));
    mainWindow.setBounds({ x: fixedX, y: fixedY, width: FLOATING_WINDOW_WIDTH, height: newH });
  }, 16);
});

ipcMain.on('resize-stop', () => {
  if (resizeInterval) {
    clearInterval(resizeInterval);
    resizeInterval = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    config.windowHeight = mainWindow.getSize()[1];
    saveConfig(config);
  }
});

ipcMain.handle('save-anthropic-key', (_, key) => {
  config.anthropicKey = key;
  saveConfig(config);
});

ipcMain.handle('save-openai-key', (_, key) => {
  config.openaiKey = key;
  saveConfig(config);
});

ipcMain.handle('save-openrouter-key', (_, key) => {
  config.openrouterKey = key;
  saveConfig(config);
});

ipcMain.handle('save-ai-provider', (_, provider) => {
  config.aiProvider = normalizeAiProvider(provider);
  saveConfig(config);
});

ipcMain.handle('save-anthropic-model', (_, model) => {
  config.anthropicModel = normalizeAiModel('anthropic', model);
  saveConfig(config);
});

ipcMain.handle('save-openai-model', (_, model) => {
  config.openaiModel = normalizeAiModel('openai', model);
  saveConfig(config);
});

ipcMain.handle('save-openrouter-model', (_, model) => {
  config.openrouterModel = normalizeAiModel('openrouter', model);
  saveConfig(config);
});

ipcMain.handle('save-anthropic-auth-mode', (_, mode) => {
  config.anthropicAuthMode = mode;
  saveConfig(config);
});

ipcMain.handle('save-openai-auth-mode', (_, mode) => {
  config.openaiAuthMode = mode;
  saveConfig(config);
});

ipcMain.handle('get-config-safe', () => {
  return {
    repos:              config.repos,
    intervalSeconds:    config.intervalSeconds,
    aiProvider:         config.aiProvider,
    anthropicModel:     config.anthropicModel,
    openaiModel:        config.openaiModel,
    openrouterModel:    config.openrouterModel,
    aiModelOptions:     AI_MODEL_OPTIONS,
    anthropicAuthMode:  config.anthropicAuthMode,
    openaiAuthMode:     config.openaiAuthMode,
    hasAnthropicKey:    !!config.anthropicKey,
    anthropicKeyHint:   maskSecret(config.anthropicKey),
    hasOpenaiKey:       !!config.openaiKey,
    openaiKeyHint:      maskSecret(config.openaiKey),
    hasOpenrouterKey:   !!config.openrouterKey,
    openrouterKeyHint:  maskSecret(config.openrouterKey),
    hasGithubToken:     !!config.githubToken,
    githubTokenHint:    maskSecret(config.githubToken),
    widgetMode:         config.widgetMode,
    autoStart:          config.autoStart,
    shortcutToggle:     config.shortcutToggle,
    shortcutMinimize:   config.shortcutMinimize,
  };
});

// ============================================================
// Credentials dos CLIs (Claude Code + Codex/OpenAI)
// Lê tokens locais pra evitar exigir API key manual.
// ============================================================
function candidateHomes() {
  const homes = new Set();
  homes.add(os.homedir());
  if (process.env.USERPROFILE) homes.add(process.env.USERPROFILE);
  return [...homes].filter(Boolean);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) { return null; }
}

function readClaudeCredentials() {
  for (const home of candidateHomes()) {
    const p = path.join(home, '.claude', '.credentials.json');
    const data = readJsonSafe(p);
    const oauth = data && data.claudeAiOauth;
    if (!oauth || !oauth.accessToken) continue;
    const expired = oauth.expiresAt && Date.now() >= Number(oauth.expiresAt);
    return {
      token: oauth.accessToken,
      expiresAt: oauth.expiresAt || null,
      expired: !!expired,
      source: 'claude-cli'
    };
  }
  return null;
}

function readCodexCredentials() {
  for (const home of candidateHomes()) {
    const p = path.join(home, '.codex', 'auth.json');
    const data = readJsonSafe(p);
    if (!data) continue;
    const mode = data.auth_mode || (data.OPENAI_API_KEY ? 'ApiKey' : 'ChatGPT');
    if (data.OPENAI_API_KEY) {
      return { apiKey: data.OPENAI_API_KEY, mode, source: 'codex-cli' };
    }
    return { apiKey: null, mode, source: 'codex-cli' };
  }
  return null;
}

ipcMain.handle('detect-cli-credentials', () => {
  const claude = readClaudeCredentials();
  const codex = readCodexCredentials();
  return {
    claude: claude ? { available: !claude.expired, expiresAt: claude.expiresAt, expired: claude.expired } : { available: false },
    openai: codex ? { available: !!codex.apiKey, mode: codex.mode } : { available: false }
  };
});

const COMMIT_PROMPT = (diff) => `Você é um especialista em Git. Analise as mudanças abaixo e gere uma mensagem de commit em PORTUGUÊS BRASILEIRO.

REGRAS OBRIGATÓRIAS:
- Responda APENAS com o texto da mensagem de commit, nada mais
- NÃO use markdown, NÃO use blocos de código, NÃO use aspas, NÃO use \`\`\`
- Linha 1: título curto (máximo 60 caracteres), no imperativo (ex: "Adiciona", "Corrige", "Atualiza")
- Linha 2: em branco
- Linhas seguintes: descrição concisa das principais mudanças (máximo 3 linhas)

Mudanças:
${diff}`;

function friendlyAiError(provider, err) {
  const msg = err.message || String(err);
  // Extrai mensagem legível de erros JSON da API
  try {
    const json = JSON.parse(msg.match(/\{.*\}/s)?.[0] || '{}');
    const detail = json?.error?.message || json?.message || '';
    if (detail) {
      if (/credit|balance|billing|quota|insufficient/i.test(detail)) return `${provider}: saldo insuficiente — verifique seu plano`;
      if (/invalid.*key|api.key|authentication|unauthorized|no auth|forbidden/i.test(detail)) return `${provider}: API key inválida`;
      if (/rate.limit|too many/i.test(detail)) return `${provider}: limite de requisições atingido`;
      return `${provider}: ${detail.substring(0, 80)}`;
    }
  } catch (_) {}
  if (/key não configurada|sem credencial/i.test(msg)) return `${provider}: key não configurada`;
  if (/resposta vazia ao gerar commit/i.test(msg)) return msg;
  if (/credit|balance|billing/i.test(msg)) return `${provider}: saldo insuficiente`;
  if (/oauth|token.*expirado|expirado.*token/i.test(msg)) return `${provider}: token OAuth expirado — faça login no CLI`;
  if (/invalid.*key|authentication|unauthorized|no auth|401|403/i.test(msg)) return `${provider}: API key inválida`;
  if (/rate.limit|429/i.test(msg)) return `${provider}: limite atingido`;
  return `${provider}: erro ao gerar commit`;
}

function providerHasConfiguredCredential(provider) {
  if (provider === 'anthropic') {
    if (config.anthropicAuthMode === 'oauth') {
      const cli = readClaudeCredentials();
      return !!cli && !cli.expired;
    }
    return !!config.anthropicKey;
  }
  if (provider === 'openai') {
    if (config.openaiAuthMode === 'oauth') {
      const cli = readCodexCredentials();
      return !!cli && !!cli.apiKey;
    }
    return !!config.openaiKey;
  }
  if (provider === 'openrouter') return !!config.openrouterKey;
  return false;
}

function buildProviderAttemptOrder(primary) {
  const normalizedPrimary = normalizeAiProvider(primary);
  const order = [normalizedPrimary];
  AI_PROVIDERS.forEach(provider => {
    if (provider !== normalizedPrimary && providerHasConfiguredCredential(provider)) {
      order.push(provider);
    }
  });
  return order;
}

async function generateCommitMessage(diff) {
  const primary = normalizeAiProvider(config.aiProvider);

  const callAnthropic = async (client) => {
    const msg = await client.messages.create({
      model: normalizeAiModel('anthropic', config.anthropicModel),
      max_tokens: 300,
      messages: [{ role: 'user', content: COMMIT_PROMPT(diff) }]
    });
    return ensureCommitMessage(textFromContent(msg.content), 'Anthropic');
  };

  const tryAnthropic = async () => {
    const mode = config.anthropicAuthMode || 'oauth';
    if (mode === 'oauth') {
      const cli = readClaudeCredentials();
      if (!cli || cli.expired) throw new Error('Claude CLI não autenticado — rode `claude login` ou troque para API key nas configurações');
      const client = new Anthropic({ authToken: cli.token, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } });
      return await callAnthropic(client);
    } else {
      if (!config.anthropicKey) throw new Error('Anthropic: API key não configurada nas configurações');
      const client = new Anthropic({ apiKey: config.anthropicKey });
      return await callAnthropic(client);
    }
  };

  const callOpenAiCompatible = async (client, model, providerLabel) => {
    const msg = await client.chat.completions.create({
      model,
      max_tokens: 300,
      messages: [{ role: 'user', content: COMMIT_PROMPT(diff) }]
    });
    return ensureCommitMessage(textFromContent(msg.choices?.[0]?.message?.content), providerLabel);
  };

  const tryOpenAI = async () => {
    const mode = config.openaiAuthMode || 'apiKey';
    if (mode === 'oauth') {
      const cli = readCodexCredentials();
      if (!cli || !cli.apiKey) {
        const hint = cli && cli.mode && cli.mode !== 'ApiKey'
          ? 'Codex CLI em modo ChatGPT — não serve pra API; troque para API key nas configurações'
          : 'Codex CLI não detectado — rode a configuração do Codex ou troque para API key';
        throw new Error(hint);
      }
      const client = new OpenAI({ apiKey: cli.apiKey });
      return await callOpenAiCompatible(client, normalizeAiModel('openai', config.openaiModel), 'OpenAI');
    } else {
      if (!config.openaiKey) throw new Error('OpenAI: API key não configurada nas configurações');
      const client = new OpenAI({ apiKey: config.openaiKey });
      return await callOpenAiCompatible(client, normalizeAiModel('openai', config.openaiModel), 'OpenAI');
    }
  };

  const tryOpenRouter = async () => {
    if (!config.openrouterKey) throw new Error('OpenRouter: API key não configurada nas configurações');
    const client = new OpenAI({
      apiKey: config.openrouterKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/ronydrop/git-monitor',
        'X-OpenRouter-Title': 'Git Monitor'
      }
    });
    return await callOpenAiCompatible(client, normalizeAiModel('openrouter', config.openrouterModel), 'OpenRouter');
  };

  const providers = { anthropic: tryAnthropic, openai: tryOpenAI, openrouter: tryOpenRouter };
  const errors = [];
  for (const provider of buildProviderAttemptOrder(primary)) {
    try {
      return await providers[provider]();
    } catch (err) {
      const label = provider === 'openrouter' ? 'OpenRouter' : provider === 'openai' ? 'OpenAI' : 'Anthropic';
      errors.push(friendlyAiError(label, err));
    }
  }
  throw new Error(errors.join(' · '));
}

function createDeployWatchId(repoPath, sha) {
  const seed = `${repoPath || ''}:${sha || ''}:${Date.now()}:${Math.random()}`;
  return Buffer.from(seed).toString('base64url').slice(0, 24);
}

function getDeployStateForRepo(repoPath) {
  return (config.deployStates || {})[repoKey(repoPath)] || null;
}

function isDeployStatePending(state) {
  return !!state && (state.phase === 'waiting' || state.phase === 'running');
}

ipcMain.handle('commit-and-push', async (_, repoPath) => {
  const release = await acquireRepoLock(repoPath);
  markWriting(repoPath, true);
  try {
    cleanStaleLock(repoPath);

    // Checa se há mudanças não commitadas
    const statusOutput = (await gitExec('git status --porcelain', { cwd: repoPath, timeout: 5000 })).trim();
    const hasUncommitted = statusOutput.length > 0;
    const [initialBranch, initialHeadSha] = await Promise.all([
      gitExec('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, timeout: 5000 }).then(o => o.trim()),
      gitExec('git rev-parse HEAD', { cwd: repoPath, timeout: 5000 }).then(o => o.trim())
    ]);
    const repoConfig = findConfiguredRepo(repoPath);
    const deployConfigured = repoDeployEnabled(repoConfig);
    const pendingDeploy = getDeployStateForRepo(repoPath);
    if (deployConfigured && !hasUncommitted && isDeployStatePending(pendingDeploy) &&
        pendingDeploy.sha === initialHeadSha &&
        (!pendingDeploy.branch || pendingDeploy.branch === initialBranch)) {
      return {
        ok: false,
        error: `Deploy ainda em andamento para ${initialBranch}@${initialHeadSha.slice(0, 7)}. Aguarde o resultado do GitHub Actions.`
      };
    }

    const hasAnthropicAuth = config.anthropicKey || config.anthropicAuthMode === 'oauth';
    const hasOpenAIAuth = config.openaiKey || config.openaiAuthMode === 'oauth';
    const hasOpenRouterAuth = !!config.openrouterKey;
    if (hasUncommitted && !hasAnthropicAuth && !hasOpenAIAuth && !hasOpenRouterAuth) {
      return { ok: false, error: 'Nenhuma credencial de IA configurada (Anthropic, OpenAI ou OpenRouter).' };
    }

    config.deployStates = clearDeployState(config.deployStates, repoPath);
    config.deployErrors = clearDeployState(config.deployErrors, repoPath);
    saveConfig(config);

    let title = 'Push de commits pendentes';
    let body = '';

    if (hasUncommitted) {
      await verifyGitRemoteAccess(repoPath, initialBranch);

      let diff = '';
      try {
        const staged   = await gitExec('git diff --cached', { cwd: repoPath, timeout: 8000 });
        const unstaged = await gitExec('git diff', { cwd: repoPath, timeout: 8000 });
        diff = (staged + unstaged).trim();
      } catch (e) { diff = ''; }

      if (!diff) diff = statusOutput || 'Mudanças sem diff disponível';

      const diffTruncated = diff.length > 6000 ? diff.substring(0, 6000) + '\n\n[diff truncado]' : diff;
      const commitMsg = await generateCommitMessage(diffTruncated);
      const parsedCommit = parseCommitMessage(commitMsg);
      title = parsedCommit.title;
      body = parsedCommit.body;

      await gitExec('git add .', { cwd: repoPath, timeout: 10000 });
      await gitExecFile(buildCommitArgs(title, body), { cwd: repoPath, timeout: 15000 });
    }

    const branch = (await gitExec('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, timeout: 5000 })).trim();

    // Pull rebase para sincronizar com o remote, depois push
    try {
      await gitExec(pullRebaseCommand(branch), { cwd: repoPath, timeout: 30000 });
    } catch (e) {
      if (isGitAuthError(e)) {
        throw new Error(GIT_AUTH_ERROR_MESSAGE);
      }
      if (isRebaseConflictError(e)) {
        await gitExec('git rebase --abort', { cwd: repoPath, timeout: 10000 }).catch(() => {});
        throw new Error('Conflito no pull --rebase. Resolva manualmente antes de fazer push.');
      }
      throw new Error(`Falha no pull --rebase: ${formatGitError(e)}`);
    }
    const [sha, remoteUrl] = await Promise.all([
      gitExec('git rev-parse HEAD', { cwd: repoPath, timeout: 5000 }).then(o => o.trim()),
      gitExec('git config --get remote.origin.url', { cwd: repoPath, timeout: 5000 }).then(o => o.trim()).catch(() => '')
    ]);
    await gitExec(pushCommand(branch), { cwd: repoPath, timeout: 30000 });

    if (!deployConfigured) {
      return { ok: true, title, body, deploy: null, deploySkipped: true, deployDetail: 'Sem deploy' };
    }

    const gh = parseGithubRemote(remoteUrl);
    const deploy = {
      phase: 'waiting',
      detail: 'Aguardando CI iniciar',
      repoPath,
      repoName: (repoConfig || {}).name || '',
      sha,
      branch,
      remoteUrl,
      owner: gh ? gh.owner : '',
      repo: gh ? gh.repo : '',
      watchId: createDeployWatchId(repoPath, sha),
      startedAt: Date.now()
    };
    config.deployStates = markDeployState(
      config.deployStates,
      repoPath,
      'waiting',
      deploy.detail,
      deploy.startedAt,
      deploy
    );
    saveConfig(config);
    startDeployWatcher({ ...deploy });

    return { ok: true, title, body, deploy };
  } catch (e) {
    return { ok: false, error: e.message ? e.message.substring(0, 200) : String(e) };
  } finally {
    markWriting(repoPath, false);
    release();
  }
});

ipcMain.handle('open-folder', (_, folderPath) => {
  shell.openPath(folderPath);
});

const diffWindows = new Map();

ipcMain.handle('open-diff-window', (_, repoPath, repoName) => {
  if (diffWindows.has(repoPath)) {
    const existing = diffWindows.get(repoPath);
    if (!existing.isDestroyed()) { existing.focus(); return; }
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({
    width: 800,
    height: 620,
    x: Math.round((sw - 800) / 2),
    y: Math.round((sh - 620) / 2),
    frame: false,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    icon: getIconPath(),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  w.loadFile('diff.html', { query: { path: repoPath, name: repoName || repoPath } });
  diffWindows.set(repoPath, w);
  w.on('closed', () => {
    diffWindows.delete(repoPath);
    ensureWidgetOnTop('diff-closed');
  });
});

ipcMain.handle('get-diff', async (_, repoPath) => {
  try {
    const staged   = await gitExec('git diff --cached', { cwd: repoPath, timeout: 8000 });
    const unstaged = await gitExec('git diff', { cwd: repoPath, timeout: 8000 });
    return { ok: true, diff: (staged + unstaged).trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Deploy watchers ativos por repoPath
const deployWatchers = {};
const DEPLOY_NO_CI_ATTEMPTS = 5;
const DEPLOY_INITIAL_DELAY_MS = 3000;
const DEPLOY_POLL_INTERVAL_MS = 4000;

function deployWatcherKey(repoPath) {
  return repoKey(repoPath);
}

function sendDeployUpdate(repoPath, repoName, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deploy-update', { repoPath, repoName, ...payload });
  }
}

async function resolveDeployWatchPhase(context, attempts) {
  const repoPath = context.repoPath;
  const sha = context.sha || (await execAsync('git rev-parse HEAD', { cwd: repoPath, timeout: 5000 })).trim();
  const branch = context.branch ||
    (await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, timeout: 3000 }).then(o => o.trim()).catch(() => ''));
  const remoteUrl = context.remoteUrl ||
    (await execAsync('git config --get remote.origin.url', { cwd: repoPath, timeout: 3000 }).then(o => o.trim()).catch(() => ''));
  const parsed = context.owner && context.repo
    ? { owner: context.owner, repo: context.repo }
    : parseGithubRemote(remoteUrl);

  if (!parsed) {
    return { phase: 'no-github', detail: 'Remote origin nao e GitHub; deploy nao monitorado', sha, branch, remoteUrl };
  }

  const tokenInfo = resolveGithubToken(findConfiguredRepo(repoPath), remoteUrl, config);
  if (!tokenInfo) {
    return {
      phase: 'no-token',
      detail: 'Configure um token GitHub global ou especifico deste repo',
      sha,
      branch,
      remoteUrl,
      owner: parsed.owner,
      repo: parsed.repo
    };
  }

  const workflowQuery = new URLSearchParams({ head_sha: sha, per_page: '50' });
  if (branch && branch !== 'HEAD') workflowQuery.set('branch', branch);

  const [workflowRes, checkRes, statusRes] = await Promise.all([
    githubApiGet(`/repos/${parsed.owner}/${parsed.repo}/actions/runs?${workflowQuery.toString()}`, tokenInfo.token),
    githubApiGet(`/repos/${parsed.owner}/${parsed.repo}/commits/${sha}/check-runs`, tokenInfo.token),
    githubApiGet(`/repos/${parsed.owner}/${parsed.repo}/commits/${sha}/status`, tokenInfo.token)
  ]);

  const hasWorkflowAccess = workflowRes.statusCode === 200;
  const hasCheckAccess  = checkRes.statusCode === 200;
  const hasStatusAccess = statusRes.statusCode === 200;
  const apiResponses = [workflowRes, checkRes, statusRes];

  if (!hasWorkflowAccess && !hasCheckAccess && !hasStatusAccess) {
    if (isTransientGithubApiProblem(apiResponses)) {
      return {
        phase: 'waiting',
        detail: githubApiRetryDetail(apiResponses),
        sha,
        branch,
        remoteUrl,
        owner: parsed.owner,
        repo: parsed.repo
      };
    }
    return {
      phase: 'error',
      detail: githubApiFailureDetail(workflowRes, checkRes, statusRes, parsed),
      sha,
      branch,
      remoteUrl,
      owner: parsed.owner,
      repo: parsed.repo
    };
  }

  const workflowRuns = (hasWorkflowAccess && workflowRes.data.workflow_runs) ? workflowRes.data.workflow_runs : [];
  const checkRuns = (hasCheckAccess && checkRes.data.check_runs) ? checkRes.data.check_runs : [];
  const statuses = (hasStatusAccess && statusRes.data.statuses) ? statusRes.data.statuses : [];
  const combinedState = hasStatusAccess ? statusRes.data.state : null;
  const statusTotal = hasStatusAccess ? (statusRes.data.total_count || 0) : 0;
  const hasData = workflowRuns.length > 0 || checkRuns.length > 0 || statusTotal > 0;

  const diag = {
    repoPath,
    sha,
    branch,
    tokenSource: tokenInfo.source,
    attempts,
    workflowStatus: workflowRes.statusCode,
    workflowError: workflowRes.error || '',
    checkStatus: checkRes.statusCode,
    checkError: checkRes.error || '',
    statusStatus: statusRes.statusCode,
    statusError: statusRes.error || '',
    workflowsTotal: workflowRuns.length,
    workflowsConclusions: workflowRuns.map(r => [r.name, r.status, r.conclusion]),
    runsTotal: checkRuns.length,
    runsConclusions: checkRuns.map(r => [r.name, r.status, r.conclusion]),
    statusTotal,
    combinedState,
    statusesDetail: statuses.map(s => [s.context, s.state])
  };

  if (!hasData) {
    if (attempts >= DEPLOY_NO_CI_ATTEMPTS) {
      const apiProblem = findGithubApiProblem([workflowRes, checkRes, statusRes]);
      if (apiProblem) {
        if (isTransientGithubApiProblem(apiResponses)) {
          return {
            phase: 'waiting',
            detail: githubApiRetryDetail(apiResponses),
            sha,
            branch,
            remoteUrl,
            owner: parsed.owner,
            repo: parsed.repo,
            _diag: diag
          };
        }
        return {
          phase: 'error',
          detail: githubApiFailureDetail(workflowRes, checkRes, statusRes, parsed),
          sha,
          branch,
          remoteUrl,
          owner: parsed.owner,
          repo: parsed.repo,
          _diag: diag
        };
      }
      return {
        phase: 'no-ci',
        detail: 'Nenhum workflow, check-run ou commit status encontrado para este commit',
        sha,
        branch,
        remoteUrl,
        owner: parsed.owner,
        repo: parsed.repo,
        _diag: diag
      };
    }
    return { phase: 'waiting', detail: 'Aguardando CI iniciar', sha, branch, remoteUrl, owner: parsed.owner, repo: parsed.repo, _diag: diag };
  }

  const resolvedPhase = resolveDeployPhase({
    checkRuns,
    workflowRuns,
    statuses,
    combinedState,
    statusTotal
  });
  return {
    ...applyDeployWatchDeadline(resolvedPhase, context),
    sha,
    branch,
    remoteUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    _diag: diag
  };
}

function updateDeployStateFromWatch(repoPath, res, watchId) {
  const update = applyDeployWatchUpdate(config.deployStates, repoPath, {
    ...res,
    detail: deployPhaseDetail(res),
    watchId
  }, Date.now());
  config.deployStates = update.deployStates;
  if (update.applied) saveConfig(config);
  return update;
}

function startDeployWatcher(context = {}) {
  const repoPath = context.repoPath;
  if (!repoPath) return;

  const repoConfig = findConfiguredRepo(repoPath);
  if (!repoDeployEnabled(repoConfig)) {
    config.deployStates = clearDeployState(config.deployStates, repoPath);
    config.deployErrors = clearDeployState(config.deployErrors, repoPath);
    saveConfig(config);
    return;
  }

  const key = deployWatcherKey(repoPath);
  const current = getDeployStateForRepo(repoPath);
  const watchId = context.watchId || (current && current.watchId) || createDeployWatchId(repoPath, context.sha || '');
  if (context.watchId && current && current.watchId && current.watchId !== context.watchId) return;

  if (deployWatchers[key]) clearTimeout(deployWatchers[key].timer);

  const repoName = context.repoName || (repoConfig && repoConfig.name) || repoPath;
  const startedAt = context.startedAt || (current && current.startedAt) || Date.now();
  let attempts = Number(context.attempts || 0) || 0;

  if (!current) {
    config.deployStates = markDeployState(config.deployStates, repoPath, 'waiting', 'Aguardando CI iniciar', Date.now(), {
      ...context,
      watchId,
      startedAt
    });
    saveConfig(config);
  }

  const baseContext = {
    ...current,
    ...context,
    repoPath,
    repoName,
    watchId,
    startedAt
  };

  const stop = () => {
    if (deployWatchers[key]) {
      clearTimeout(deployWatchers[key].timer);
      delete deployWatchers[key];
    }
  };

  const check = async () => {
    attempts++;
    const activeBefore = getDeployStateForRepo(repoPath);
    if (!activeBefore || (activeBefore.watchId && activeBefore.watchId !== watchId)) {
      stop();
      return;
    }

    let res;
    try {
      res = await resolveDeployWatchPhase({ ...baseContext, ...activeBefore, watchId }, attempts);
    } catch (e) {
      res = {
        phase: 'error',
        detail: e.message || String(e),
        sha: activeBefore.sha || baseContext.sha || '',
        branch: activeBefore.branch || baseContext.branch || '',
        remoteUrl: activeBefore.remoteUrl || baseContext.remoteUrl || ''
      };
    }

    const activeAfter = getDeployStateForRepo(repoPath);
    if (!activeAfter || (activeAfter.watchId && activeAfter.watchId !== watchId)) {
      stop();
      return;
    }

    if (res._diag) console.log('[deploy-watch]', JSON.stringify({ ...res._diag, emittedPhase: res.phase }));

    const update = updateDeployStateFromWatch(repoPath, { ...res, watchId }, watchId);
    if (!update.applied) {
      stop();
      return;
    }

    sendDeployUpdate(repoPath, repoName, { ...res, watchId });

    if (res.phase === 'waiting' || res.phase === 'running') {
      deployWatchers[key] = { timer: setTimeout(check, DEPLOY_POLL_INTERVAL_MS), watchId };
    } else {
      stop();
    }
  };

  sendDeployUpdate(repoPath, repoName, {
    phase: 'waiting',
    detail: 'Aguardando CI iniciar',
    sha: baseContext.sha || '',
    branch: baseContext.branch || '',
    watchId
  });
  deployWatchers[key] = { timer: setTimeout(check, DEPLOY_INITIAL_DELAY_MS), watchId };
}

async function resumePendingDeployWatchers() {
  for (const repo of config.repos || []) {
    if (repo.enabled === false) continue;
    if (!repoDeployEnabled(repo)) {
      config.deployStates = clearDeployState(config.deployStates, repo.path);
      config.deployErrors = clearDeployState(config.deployErrors, repo.path);
      saveConfig(config);
      continue;
    }
    const state = getDeployStateForRepo(repo.path);
    if (!isDeployStatePending(state)) continue;

    const snapshot = {
      name: repo.name,
      path: repo.path,
      ...await checkRepo(repo.path)
    };
    const deployPhase = await resolveDeployPhaseForRepoSnapshot(snapshot, state);
    if (deployPhase) {
      if (deployPhase.phase === 'success') {
        config.deployStates = clearDeployState(config.deployStates, repo.path);
        saveConfig(config);
        continue;
      }

      const update = applyDeployWatchUpdate(config.deployStates, repo.path, {
        ...deployPhase,
        detail: deployPhaseDetail(deployPhase),
        watchId: state.watchId || '',
        sha: deployPhase.sha,
        branch: deployPhase.branch,
        remoteUrl: deployPhase.remoteUrl,
        owner: deployPhase.owner,
        repo: deployPhase.repo
      }, Date.now());
      config.deployStates = update.deployStates;
      if (update.applied) saveConfig(config);
      if (!isDeployStatePending(getDeployStateForRepo(repo.path))) continue;
    }

    startDeployWatcher({
      ...getDeployStateForRepo(repo.path),
      repoPath: repo.path,
      repoName: repo.name
    });
  }
}

ipcMain.on('watch-deploy-start', (event, payload = {}) => {
  const deploy = payload.deploy || {};
  const repoPath = payload.repoPath || deploy.repoPath;
  if (!repoPath) return;
  if (!repoDeployEnabled(findConfiguredRepo(repoPath))) return;

  const current = getDeployStateForRepo(repoPath);
  if (deploy.watchId && current && current.watchId && current.watchId !== deploy.watchId) return;
  startDeployWatcher({ ...deploy, repoPath, repoName: payload.repoName || deploy.repoName });
});

ipcMain.on('watch-deploy-stop', (_, repoPath) => {
  const key = deployWatcherKey(repoPath);
  if (deployWatchers[key]) {
    clearTimeout(deployWatchers[key].timer);
    delete deployWatchers[key];
  }
});

ipcMain.handle('git-pull', async (_, repoPath) => {
  const release = await acquireRepoLock(repoPath);
  markWriting(repoPath, true);
  try {
    cleanStaleLock(repoPath);
    await gitExec('git --no-optional-locks pull', { cwd: repoPath, timeout: 45000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message ? e.message.substring(0, 200) : String(e) };
  } finally {
    markWriting(repoPath, false);
    release();
  }
});

ipcMain.handle('open-terminal', (_, folderPath, projectName) => {
  const t = projectName || folderPath;
  const tab1 = `new-tab --title "${t}" -d "${folderPath}" cmd /k "title ${t} && claude"`;
  const tab2 = `new-tab --title "${t}" -d "${folderPath}" cmd /k "title ${t}"`;
  exec(`wt ${tab1} ; ${tab2}`, { windowsHide: false });
});

ipcMain.handle('open-git-url', (_, remoteUrl) => {
  const parsed = parseGithubRemote(remoteUrl);
  let url = parsed ? parsed.webUrl : remoteUrl;
  if (url && url.startsWith('git@')) {
    url = url.replace(':', '/').replace('git@', 'https://');
  }
  url = String(url || '').replace(/\.git$/, '');
  shell.openExternal(url);
});

ipcMain.handle('save-github-token', (_, token) => {
  config.githubToken = token;
  saveConfig(config);
});

function githubApiGet(apiPath, token) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const headers = {
      'User-Agent': 'GitMonitor',
      'Accept': 'application/vnd.github+json'
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = https.get({
      hostname: 'api.github.com',
      path: apiPath,
      headers
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (!body.trim()) {
          finish({ statusCode: res.statusCode, data: {}, error: '' });
          return;
        }
        try {
          finish({ statusCode: res.statusCode, data: JSON.parse(body), error: '' });
        } catch (e) {
          finish({ statusCode: res.statusCode, data: {}, error: `Resposta invalida da API GitHub: ${e.message}` });
        }
      });
    });
    req.on('error', (e) => finish({ statusCode: 0, data: {}, error: e.message || 'erro de rede' }));
    req.setTimeout(10000, () => {
      req.destroy(new Error('Timeout ao acessar GitHub API'));
    });
  });
}

// ============================================================
// App
// ============================================================
app.whenReady().then(async () => {
  migrateConfigIfNeeded();
  config = loadConfig();

  if (process.platform === 'win32' && app.isPackaged && config._iconCacheVersion !== app.getVersion()) {
    execFile('ie4uinit.exe', ['-show'], { windowsHide: true, timeout: 5000 }, () => {});
    config._iconCacheVersion = app.getVersion();
    saveConfig(config);
  }

  createWindowForMode();
  startWidgetTopmostWatchdog();

  if (config.widgetMode !== 'notch' && config.collapsed) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setBounds({ x, y, width: FLOATING_WINDOW_WIDTH, height: 38 }, false);
  }

  if (config.widgetMode !== 'notch' && isStartupHidden()) {
    try { mainWindow.hide(); } catch (_) {}
  }

  powerMonitor.on('resume', () => {
    inputPollersPaused = false;
    setTimeout(() => ensureWidgetOnTop('power-resume'), 250);
  });
  powerMonitor.on('unlock-screen', () => {
    inputPollersPaused = false;
    setTimeout(() => ensureWidgetOnTop('power-unlock'), 250);
  });
  powerMonitor.on('suspend', () => { inputPollersPaused = true; });
  powerMonitor.on('lock-screen', () => { inputPollersPaused = true; });

  applyAutoStart(config.autoStart !== false);
  await resumePendingDeployWatchers();

  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon);
  tray.setToolTip('Git Monitor');
  tray.on('click', showOrFocusWidget);

  let _pendingUpdateVersion = null;

  function rebuildTrayMenu() {
    const items = [
      {
        label: 'Mostrar widget',
        click: showOrFocusWidget
      },
      {
        label: 'Abrir configurações',
        click: () => openConfigWindow()
      },
      { type: 'separator' },
      {
        label: 'Alternar modo (flutuante/notch)',
        click: () => switchWidgetMode(config.widgetMode === 'notch' ? 'floating' : 'notch')
      },
      {
        label: 'Minimizar notch (Ctrl+Shift+H)',
        click: () => {
          if (config.widgetMode !== 'notch') return;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('notch-toggle-minimize');
          }
        }
      },
    ];

    if (_pendingUpdateVersion) {
      items.push({ type: 'separator' });
      items.push({
        label: '⬆ Reiniciar e instalar v' + _pendingUpdateVersion,
        click: () => autoUpdater.quitAndInstall()
      });
    }

    items.push({ label: 'Verificar atualizações', click: () => { if (app.isPackaged) autoUpdater.checkForUpdates(); } });
    items.push({ type: 'separator' });
    items.push({ label: 'Sair', click: () => app.quit() });

    tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  rebuildTrayMenu();

  // ---- Auto-updater ----
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    let _lastToastPct = -1;

    autoUpdater.on('update-available', (info) => {
      sendUpdateStatus({ type: 'available', version: info.version });
      _lastToastPct = 0;
      showToastWindow('Atualização ' + info.version + ' disponível — baixando...', 'info', 60000);
    });

    autoUpdater.on('update-not-available', () => {
      sendUpdateStatus({ type: 'latest' });
    });

    autoUpdater.on('download-progress', (info) => {
      const pct = Math.round(info.percent);
      sendUpdateStatus({ type: 'downloading', version: info.version, percent: pct });
      if (pct !== _lastToastPct && (pct % 10 === 0 || pct >= 99)) {
        _lastToastPct = pct;
        showToastWindow('Baixando v' + info.version + ' — ' + pct + '%', 'info', 60000);
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      sendUpdateStatus({ type: 'ready', version: info.version });
      _lastToastPct = -1;
      _pendingUpdateVersion = info.version;
      rebuildTrayMenu();
      showToastWindow('v' + info.version + ' instalada — reiniciando em 3s...', 'info', 4000);
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 3000);
    });

    autoUpdater.on('error', (err) => {
      sendUpdateStatus({ type: 'error', msg: err.message });
      _lastToastPct = -1;
      showToastWindow('Erro ao atualizar: ' + err.message.slice(0, 80), 'err', 6000);
    });

    // Checa ao iniciar e a cada 4 horas
    if (hasAutoUpdateMetadata()) {
      checkForUpdatesSafely();
      setInterval(() => checkForUpdatesSafely(), 4 * 60 * 60 * 1000);
    }
  }

  registerShortcuts();
});

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const toggleAccel = config.shortcutToggle || 'Control+Shift+G';
  const minAccel = config.shortcutMinimize || 'Control+Shift+M';
  const notchAccel = 'Control+Shift+H';

  const result = { toggle: null, minimize: null, notch: null };
  try {
    const ok = globalShortcut.register(toggleAccel, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else { ensureWidgetOnTop('shortcut-toggle', { show: true, focus: config.widgetMode !== 'notch' }); }
    });
    result.toggle = ok ? toggleAccel : null;
  } catch (e) { console.warn('[GitMonitor] shortcut toggle falhou:', e.message); }

  try {
    const ok = globalShortcut.register(minAccel, () => toggleCollapseApp());
    result.minimize = ok ? minAccel : null;
  } catch (e) { console.warn('[GitMonitor] shortcut minimize falhou:', e.message); }

  try {
    const ok = globalShortcut.register(notchAccel, () => {
      if (config.widgetMode !== 'notch') return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('notch-toggle-minimize');
    });
    result.notch = ok ? notchAccel : null;
  } catch (e) { console.warn('[GitMonitor] shortcut notch falhou:', e.message); }

  return result;
}

ipcMain.handle('save-shortcuts', (_, shortcuts) => {
  if (shortcuts && typeof shortcuts === 'object') {
    if (typeof shortcuts.toggle === 'string') config.shortcutToggle = shortcuts.toggle;
    if (typeof shortcuts.minimize === 'string') config.shortcutMinimize = shortcuts.minimize;
    saveConfig(config);
  }
  return registerShortcuts();
});

ipcMain.handle('get-shortcuts', () => ({
  toggle: config.shortcutToggle || 'Control+Shift+G',
  minimize: config.shortcutMinimize || 'Control+Shift+M'
}));

const VALID_THEMES = ['obsidian', 'slate', 'daylight', 'nord', 'dracula', 'matrix'];
ipcMain.handle('save-theme', (_, name) => {
  if (VALID_THEMES.includes(name)) {
    config.theme = name;
    saveConfig(config);
    notifyConfigSaved();
  }
  return config.theme;
});

ipcMain.handle('set-widget-mode', (_, mode) => {
  const next = mode === 'notch' ? 'notch' : 'floating';
  if (configWindow && !configWindow.isDestroyed()) {
    pendingWidgetMode = next;
  } else {
    setImmediate(() => switchWidgetMode(next));
  }
  return next;
});

ipcMain.handle('set-auto-start', (_, enabled) => {
  config.autoStart = !!enabled;
  saveConfig(config);
  applyAutoStart(config.autoStart);
  return { ok: true, packaged: app.isPackaged };
});

ipcMain.handle('notch-pending-repos', async () => {
  const results = await checkAllRepos();
  const pending = sortReposByAttention(results
    .map(r => applyDeployState(r, config.deployStates))
    .filter(r => needsAttentionRepo(r)))
    .map(r => ({
      name: r.name,
      path: r.path,
      status: r.status,
      detail: r.detail,
      pending: r.pending,
      needsAttention: r.needsAttention,
      deployPending: r.deployPending,
      deployError: r.deployError,
      deployPhase: r.deployPhase,
      deployDetail: r.deployDetail,
      branch: r.branch,
      ahead: r.ahead,
      behind: r.behind,
      changedFiles: r.changedFiles,
      remoteUrl: r.remoteUrl
    }));
  return { pending, total: results.length };
});

ipcMain.handle('notch-all-repos', async () => {
  const results = await checkAllRepos();
  const mapped = sortReposByAttention(mapReposForNotch(results));
  return { repos: mapped, total: mapped.length };
});

ipcMain.on('notch-rect', (_, rect) => {
  if (!rect) return;
  const N = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  let hotzone = null;
  if (rect.hotzone != null) {
    const hz = Number(rect.hotzone);
    if (Number.isFinite(hz)) hotzone = hz;
  }
  notchRect = {
    w: Math.max(40, N(rect.w, 260)),
    h: Math.max(8, N(rect.h, 38)),
    offsetY: N(rect.offsetY, 0),
    hotzone,
    left: N(rect.left, NOTCH_COMPACT_LEFT)
  };
});

let _notchSaveTimer = null;
let _notchDragging = false;
let _notchDragPoll = null;
let _notchDragTimeout = null;
let _notchDragDisplayListener = null;

function endNotchDrag() {
  _notchDragging = false;
  if (_notchDragPoll) { clearInterval(_notchDragPoll); _notchDragPoll = null; }
  if (_notchDragTimeout) { clearTimeout(_notchDragTimeout); _notchDragTimeout = null; }
  if (_notchDragDisplayListener) { screen.off('display-metrics-changed', _notchDragDisplayListener); _notchDragDisplayListener = null; }
}

ipcMain.on('notch-ghost', (_, on) => {
  setNotchGhostState(on, false);
  if (!on && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.on('notch-drag-start', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  _notchDragging = true;
  mainWindow.setIgnoreMouseEvents(false);

  const startCursor = screen.getCursorScreenPoint();
  const baseOffset  = config.notchOffsetX ?? 40;
  // Cache do display: não chama getPrimaryDisplay() a cada tick (caro)
  let d = screen.getPrimaryDisplay();
  if (_notchDragDisplayListener) screen.off('display-metrics-changed', _notchDragDisplayListener);
  _notchDragDisplayListener = () => { d = screen.getPrimaryDisplay(); };
  screen.on('display-metrics-changed', _notchDragDisplayListener);

  if (_notchDragPoll) clearInterval(_notchDragPoll);
  if (_notchDragTimeout) clearTimeout(_notchDragTimeout);

  // Safety: auto-reset se drag-end nunca chegar (mouse solto fora da janela)
  _notchDragTimeout = setTimeout(() => {
    endNotchDrag();
    saveConfig(config);
  }, 8000);

  _notchDragPoll = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !_notchDragging) {
      endNotchDrag(); return;
    }
    const cx = screen.getCursorScreenPoint().x;
    const delta = cx - startCursor.x;
    const newOffset = Math.max(0, Math.min(Math.max(0, d.bounds.width - 440), baseOffset - delta));
    if (config.notchOffsetX === newOffset) return;
    config.notchOffsetX = newOffset;
    try { mainWindow.setPosition(Math.round(d.bounds.x + d.bounds.width - 440 - newOffset), d.bounds.y); } catch (_) {}
  }, 16);
});

ipcMain.on('notch-drag-end', () => {
  endNotchDrag();
  clearTimeout(_notchSaveTimer);
  _notchSaveTimer = setTimeout(() => saveConfig(config), 500);
});

ipcMain.handle('notch-toggle-minimize', () => {
  if (config.widgetMode === 'notch' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notch-toggle-minimize');
    return true;
  }
  return false;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (switchingWidgetMode) return;
  app.quit();
});
