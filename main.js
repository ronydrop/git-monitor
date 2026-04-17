const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const https = require('https');
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
async function gitExec(cmd, opts) {
  const wsl = opts && opts.cwd ? parseWslPath(opts.cwd) : null;
  if (wsl) {
    // Extrai os args do git (tudo após "git ") e adiciona -C <unixPath>
    const gitArgs = cmd.replace(/^git\s+/, '');
    const wslCmd = `wsl.exe -d ${wsl.distro} -- git -C "${wsl.unixPath}" ${gitArgs}`;
    const wslOpts = { ...opts, cwd: undefined, windowsHide: true };
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
      return await execAsync(cmd, opts);
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

// ============================================================
// CONFIGURAÇÃO
// ============================================================
// Sempre AppData\Roaming\git-monitor\config.json — dev e prod compartilham
// (nome do app vem de package.json "name"; electron-builder usa o mesmo).
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

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
      { name: "Meu Projeto", path: "C:\\caminho\\do\\repositorio" },
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
    aiProvider: 'anthropic',
    anthropicAuthMode: 'oauth',
    openaiAuthMode: 'apiKey',
    githubToken: '',
    ghostZone: null,
    shortcutToggle: 'Control+Shift+G',
    shortcutMinimize: 'Control+Shift+M',
    widgetMode: 'floating',
    autoStart: true,
    theme: 'obsidian'
  };
}

function loadConfig() {
  let cfg;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { }
  if (!cfg) {
    const def = getDefaultConfig();
    saveConfig(def);
    return def;
  }
  // migração: novos campos de authMode
  if (!cfg.anthropicAuthMode) cfg.anthropicAuthMode = 'oauth';
  if (!cfg.openaiAuthMode)    cfg.openaiAuthMode    = 'apiKey';
  if (!cfg.theme)             cfg.theme             = 'obsidian';
  return cfg;
}

function maskSecret(raw) {
  if (!raw || raw.length < 8) return raw ? '••••••••' : '';
  return raw.slice(0, 7) + '•'.repeat(Math.max(4, raw.length - 11)) + raw.slice(-4);
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) { }
}

let mainWindow;
let configWindow;
let tray;
let config;

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

const PENDING_STATES = ['dirty', 'dirty-ahead', 'ahead', 'behind', 'diverged', 'error'];

let lastRepoResults = null;

function mapReposForNotch(results) {
  const mapped = results.map(r => ({
    name: r.name, path: r.path, status: r.status, detail: r.detail,
    branch: r.branch, ahead: r.ahead, behind: r.behind,
    changedFiles: r.changedFiles, remoteUrl: r.remoteUrl,
    pending: PENDING_STATES.includes(r.status)
  }));
  const order = { diverged: 0, behind: 1, ahead: 2, 'dirty-ahead': 3, dirty: 4, busy: 5, error: 6, clean: 7 };
  mapped.sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99));
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

function createFloatingWindow() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  const rawX = config.windowX !== null ? config.windowX : screenW - 310;
  const rawY = config.windowY !== null ? config.windowY : 10;
  const { x: winX, y: winY } = clampWindowPos(rawX, rawY, 300, config.windowHeight || 420);

  mainWindow = new BrowserWindow({
    width: 300,
    height: config.windowHeight || 420,
    x: winX,
    y: winY,
    frame: false,
    transparent: false,
    backgroundColor: themeBg(config.theme),
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

  const ghostTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();
    const wb = mainWindow.getBounds();
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
  }, 150);

  mainWindow.on('closed', () => {
    if (fadeAnim) { clearInterval(fadeAnim); fadeAnim = null; }
    clearInterval(ghostTimer);
  });
}

// Último rect reportado pelo renderer via IPC notch-rect.
// Fallback = baseline 310x38 top-right da janela.
let notchRect = { w: 310, h: 38, offsetY: 0, hotzone: null, right: 12 };

function createNotchWindow() {
  const display = screen.getPrimaryDisplay();
  const width = 440;
  // Folga pra overshoot do spring bouncy + expansão máxima (~360).
  const height = 420;
  const offsetX = config.notchOffsetX ?? 40;
  const x = display.bounds.x + display.bounds.width - width - offsetX;
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

  try { mainWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile('notch.html');

  // Reset do rect pra baseline — o renderer vai notificar via notch-rect.
  notchRect = { w: 310, h: 38, offsetY: 0, hotzone: null, right: 12 };

  // Passthrough com bbox dinâmico do pill real (não da window inteira).
  // O renderer envia `notch-rect` sempre que o state muda.
  let passthroughPoll = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(passthroughPoll);
      return;
    }
    try {
      const c = screen.getCursorScreenPoint();
      const b = mainWindow.getBounds();
      const r = notchRect;
      const pillRight = b.x + b.width - r.right;
      const pillLeft  = pillRight - r.w;
      const pillTop   = b.y + (r.offsetY || 0);
      const effectiveH = r.hotzone != null ? r.hotzone : r.h;
      // Quando minimized com hotzone, o pill real está fora da tela (-34) mas
      // queremos detectar mouse na faixa dos primeiros 8px pra peek.
      const detectTop = r.hotzone != null ? b.y : pillTop;
      const detectBot = r.hotzone != null ? b.y + r.hotzone : pillTop + r.h;
      const inside = c.x >= pillLeft && c.x < pillRight
                  && c.y >= detectTop && c.y < detectBot;
      if (!_notchDragging) mainWindow.setIgnoreMouseEvents(!inside, { forward: true });
    } catch (_) {}
  }, 100);

  // Reposiciona se resolução mudar
  const repositionNotch = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const d = screen.getPrimaryDisplay();
    const nx = d.bounds.x + d.bounds.width - width - (config.notchOffsetX ?? 40);
    const ny = d.bounds.y;
    try { mainWindow.setBounds({ x: nx, y: ny, width, height }); } catch (_) {}
  };
  screen.on('display-metrics-changed', repositionNotch);
  screen.on('display-added', repositionNotch);
  screen.on('display-removed', repositionNotch);

  mainWindow.on('closed', () => {
    clearInterval(passthroughPoll);
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

    const [statusOutput, branch] = await Promise.all([
      gitExec('git --no-optional-locks status --porcelain', gitOpts).then(o => o.trim()),
      gitExec('git rev-parse --abbrev-ref HEAD', gitOpts).then(o => o.trim()),
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

    return { status, detail, branch, ahead, behind, changedFiles, remoteUrl };
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
      ...await checkRepo(repo.path)
    })));
    results.push(...batchResults);
  }

  lastRepoResults = results;
  return results;
}

// ============================================================
// IPC
// ============================================================
ipcMain.handle('check-repos', () => checkAllRepos());
ipcMain.handle('get-config', () => config);

ipcMain.handle('get-cached-repos', () => {
  if (!lastRepoResults) return { repos: null, notch: null };
  const activePaths = new Set(
    config.repos.filter(r => r.enabled !== false).map(r => path.resolve(r.path))
  );
  const filtered = lastRepoResults.filter(r => activePaths.has(path.resolve(r.path)));
  return {
    repos: filtered,
    notch: { repos: mapReposForNotch(filtered), total: filtered.length }
  };
});

ipcMain.handle('save-repos', (_, repos) => {
  config.repos = repos;
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
  if (app.isPackaged) {
    autoUpdater.checkForUpdates();
  } else {
    // Em dev mode, simula resposta
    if (configWindow && !configWindow.isDestroyed()) {
      configWindow.webContents.send('update-check-result', { type: 'dev' });
    }
  }
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
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
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
  configWindow.on('closed', () => { configWindow = null; });
}

ipcMain.handle('open-config-window', () => openConfigWindow());

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
  mainWindow.setBounds({ x, y, width: 300, height: newH }, false);
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
    mainWindow.setBounds({ x: fixedX, y: fixedY, width: 300, height: newH });
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

ipcMain.handle('save-ai-provider', (_, provider) => {
  config.aiProvider = provider;
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
    anthropicAuthMode:  config.anthropicAuthMode,
    openaiAuthMode:     config.openaiAuthMode,
    hasAnthropicKey:    !!config.anthropicKey,
    anthropicKeyHint:   maskSecret(config.anthropicKey),
    hasOpenaiKey:       !!config.openaiKey,
    openaiKeyHint:      maskSecret(config.openaiKey),
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

function cleanCommitMessage(msg) {
  // Remove blocos de código markdown (```...```)
  msg = msg.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '');
  // Remove aspas no início/fim
  msg = msg.replace(/^["'`]|["'`]$/g, '');
  // Remove prefixos como "Mensagem de commit:" ou "Commit:"
  msg = msg.replace(/^(mensagem de commit|commit message|commit):\s*/i, '');
  return msg.trim();
}

function friendlyAiError(provider, err) {
  const msg = err.message || String(err);
  // Extrai mensagem legível de erros JSON da API
  try {
    const json = JSON.parse(msg.match(/\{.*\}/s)?.[0] || '{}');
    const detail = json?.error?.message || json?.message || '';
    if (detail) {
      if (/credit|balance|billing|quota|insufficient/i.test(detail)) return `${provider}: saldo insuficiente — verifique seu plano`;
      if (/invalid.*key|api.key|authentication|unauthorized/i.test(detail)) return `${provider}: API key inválida`;
      if (/rate.limit|too many/i.test(detail)) return `${provider}: limite de requisições atingido`;
      return `${provider}: ${detail.substring(0, 80)}`;
    }
  } catch (_) {}
  if (/key não configurada|sem credencial/i.test(msg)) return `${provider}: key não configurada`;
  if (/credit|balance|billing/i.test(msg)) return `${provider}: saldo insuficiente`;
  if (/oauth|token.*expirado|expirado.*token/i.test(msg)) return `${provider}: token OAuth expirado — faça login no CLI`;
  if (/invalid.*key|authentication|401/i.test(msg)) return `${provider}: API key inválida`;
  if (/rate.limit|429/i.test(msg)) return `${provider}: limite atingido`;
  return `${provider}: erro ao gerar commit`;
}

async function generateCommitMessage(diff) {
  const primary   = config.aiProvider || 'anthropic';
  const secondary = primary === 'anthropic' ? 'openai' : 'anthropic';

  const callAnthropic = async (client) => {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: COMMIT_PROMPT(diff) }]
    });
    return cleanCommitMessage(msg.content[0].text);
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
      const msg = await client.chat.completions.create({ model: 'gpt-4o-mini', max_tokens: 300, messages: [{ role: 'user', content: COMMIT_PROMPT(diff) }] });
      return cleanCommitMessage(msg.choices[0].message.content);
    } else {
      if (!config.openaiKey) throw new Error('OpenAI: API key não configurada nas configurações');
      const client = new OpenAI({ apiKey: config.openaiKey });
      const msg = await client.chat.completions.create({ model: 'gpt-4o-mini', max_tokens: 300, messages: [{ role: 'user', content: COMMIT_PROMPT(diff) }] });
      return cleanCommitMessage(msg.choices[0].message.content);
    }
  };

  const providers = { anthropic: tryAnthropic, openai: tryOpenAI };

  try {
    return await providers[primary]();
  } catch (primaryErr) {
    try {
      return await providers[secondary]();
    } catch (secondaryErr) {
      const e1 = friendlyAiError(primary, primaryErr);
      const e2 = friendlyAiError(secondary, secondaryErr);
      throw new Error(`${e1} · ${e2}`);
    }
  }
}

ipcMain.handle('commit-and-push', async (_, repoPath) => {
  const release = await acquireRepoLock(repoPath);
  markWriting(repoPath, true);
  try {
    cleanStaleLock(repoPath);

    // Checa se há mudanças não commitadas
    const statusOutput = (await gitExec('git status --porcelain', { cwd: repoPath, timeout: 5000 })).trim();
    const hasUncommitted = statusOutput.length > 0;

    const hasAnthropicAuth = config.anthropicKey || config.anthropicAuthMode === 'oauth';
    const hasOpenAIAuth = config.openaiKey || config.openaiAuthMode === 'oauth';
    if (hasUncommitted && !hasAnthropicAuth && !hasOpenAIAuth) {
      return { ok: false, error: 'Nenhuma API key de IA configurada (Anthropic ou OpenAI).' };
    }

    let title = 'Push de commits pendentes';
    let body = '';

    if (hasUncommitted) {
      let diff = '';
      try {
        const staged   = await gitExec('git diff --cached', { cwd: repoPath, timeout: 8000 });
        const unstaged = await gitExec('git diff', { cwd: repoPath, timeout: 8000 });
        diff = (staged + unstaged).trim();
      } catch (e) { diff = ''; }

      if (!diff) diff = statusOutput || 'Mudanças sem diff disponível';

      const diffTruncated = diff.length > 6000 ? diff.substring(0, 6000) + '\n\n[diff truncado]' : diff;
      const commitMsg = await generateCommitMessage(diffTruncated);
      const lines = commitMsg.split('\n');
      title = lines[0].trim();
      body = lines.slice(1).join('\n').trim();

      await gitExec('git add .', { cwd: repoPath, timeout: 10000 });
      const commitCmd = body
        ? `git commit -m "${title.replace(/"/g, '\\"')}" -m "${body.replace(/"/g, '\\"')}"`
        : `git commit -m "${title.replace(/"/g, '\\"')}"`;
      await gitExec(commitCmd, { cwd: repoPath, timeout: 15000 });
    }

    // Pull rebase para sincronizar com o remote, depois push
    try {
      await gitExec('git pull --rebase', { cwd: repoPath, timeout: 30000 });
    } catch (e) {
      const msg = e.message || '';
      if (/CONFLICT|conflict|rebase/i.test(msg)) {
        await gitExec('git rebase --abort', { cwd: repoPath, timeout: 10000 }).catch(() => {});
        throw new Error('Conflito no pull --rebase. Resolva manualmente antes de fazer push.');
      }
    }
    await gitExec('git push', { cwd: repoPath, timeout: 30000 });

    return { ok: true, title, body };
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

// Deploy watchers ativos por repoPath
const deployWatchers = {};

ipcMain.on('watch-deploy-start', (event, { repoPath, repoName }) => {
  if (deployWatchers[repoPath]) clearTimeout(deployWatchers[repoPath].timer);

  let attempts = 0;
  const maxAttempts = 60;

  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('deploy-update', { repoPath, repoName, ...payload });
    }
  };

  const check = async () => {
    if (!config.githubToken) {
      send({ phase: 'no-token' });
      return;
    }

    attempts++;
    const res = await (async () => {
      try {
        const sha = (await execAsync('git rev-parse HEAD', { cwd: repoPath, timeout: 5000 })).trim();
        let remoteUrl = '';
        try { remoteUrl = (await execAsync('git config --get remote.origin.url', { cwd: repoPath, timeout: 3000 })).trim(); } catch (e) { }
        const gh = parseGithubOwnerRepo(remoteUrl);
        if (!gh) return { phase: 'no-github' };

        // Busca check-runs (GitHub Actions) e commit statuses (Vercel, Render, etc.) em paralelo
        const [checkRes, statusRes] = await Promise.all([
          githubApiGet(`/repos/${gh.owner}/${gh.repo}/commits/${sha}/check-runs`),
          githubApiGet(`/repos/${gh.owner}/${gh.repo}/commits/${sha}/status`)
        ]);

        const hasCheckAccess  = checkRes.statusCode === 200;
        const hasStatusAccess = statusRes.statusCode === 200;

        if (!hasCheckAccess && !hasStatusAccess) {
          const code = checkRes.statusCode;
          if (code === 401) return { phase: 'error', detail: 'Token GitHub inválido ou expirado — atualize nas configurações' };
          if (code === 403) return { phase: 'error', detail: 'Token sem permissão — gere um novo com escopo repo' };
          if (code === 404) return { phase: 'error', detail: 'Token sem acesso ao repo — verifique permissões' };
          return { phase: 'error', detail: `Erro ao acessar GitHub (HTTP ${code})` };
        }

        // --- GitHub Actions (check-runs) ---
        const runs = (hasCheckAccess && checkRes.data.check_runs) ? checkRes.data.check_runs : [];
        const pendingRuns = runs.filter(r => r.status !== 'completed');
        const failedRuns  = runs.filter(r => ['failure','cancelled','timed_out'].includes(r.conclusion));
        const runningJob  = runs.find(r => r.status === 'in_progress');

        // --- Commit statuses (Vercel, Render, Netlify etc.) ---
        const statuses      = (hasStatusAccess && statusRes.data.statuses) ? statusRes.data.statuses : [];
        const combinedState = hasStatusAccess ? statusRes.data.state : null;
        const statusTotal   = hasStatusAccess ? (statusRes.data.total_count || 0) : 0;
        const pendingStatuses = statuses.filter(s => s.state === 'pending');
        const failedStatuses  = statuses.filter(s => s.state === 'failure' || s.state === 'error');
        const runningStatus   = pendingStatuses[0];

        const hasData = runs.length > 0 || statusTotal > 0;
        if (!hasData) return { phase: 'waiting' };

        // Pending: check-runs em andamento OU combined state pendente
        const anyPending = pendingRuns.length > 0 || combinedState === 'pending';

        // Failed: check-runs falharam OU combined state é failure/error
        const anyFailed = failedRuns.length > 0 ||
                          combinedState === 'failure' ||
                          combinedState === 'error';

        if (anyPending) {
          const job = runningJob
            ? runningJob.name
            : runningStatus
              ? (runningStatus.context || 'Deploy em andamento')
              : `${pendingRuns.length} em andamento`;
          return {
            phase: 'running',
            job,
            total: runs.length + statusTotal,
            done: (runs.length - pendingRuns.length) + (statusTotal - pendingStatuses.length)
          };
        }

        if (anyFailed) {
          const failedNames = [
            ...failedRuns.map(r => r.name),
            ...failedStatuses.map(s => s.context || s.description || 'deploy')
          ];
          const detail = failedNames.length > 0 ? failedNames.join(', ') : 'deploy falhou';
          return { phase: 'failure', detail };
        }

        return { phase: 'success' };
      } catch (e) {
        return { phase: 'error', detail: e.message };
      }
    })();

    send(res);

    if (res.phase === 'waiting' || res.phase === 'running') {
      if (attempts < maxAttempts) {
        deployWatchers[repoPath] = { timer: setTimeout(check, 4000) };
      } else {
        send({ phase: 'timeout' });
        delete deployWatchers[repoPath];
      }
    } else {
      delete deployWatchers[repoPath];
    }
  };

  // Aguarda CI iniciar (3s) e começa polling
  send({ phase: 'waiting' });
  deployWatchers[repoPath] = { timer: setTimeout(check, 3000) };
});

ipcMain.on('watch-deploy-stop', (_, repoPath) => {
  if (deployWatchers[repoPath]) {
    clearTimeout(deployWatchers[repoPath].timer);
    delete deployWatchers[repoPath];
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
  let url = remoteUrl;
  if (url.startsWith('git@')) {
    url = url.replace(':', '/').replace('git@', 'https://');
  }
  url = url.replace(/\.git$/, '');
  shell.openExternal(url);
});

ipcMain.handle('save-github-token', (_, token) => {
  config.githubToken = token;
  saveConfig(config);
});

function parseGithubOwnerRepo(remoteUrl) {
  if (!remoteUrl) return null;
  let url = remoteUrl;
  if (url.startsWith('git@')) {
    url = url.replace(':', '/').replace('git@', 'https://');
  }
  url = url.replace(/\.git$/, '');
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function githubApiGet(apiPath) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        'User-Agent': 'GitMonitor',
        'Authorization': `Bearer ${config.githubToken}`,
        'Accept': 'application/vnd.github+json'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ statusCode: res.statusCode, data: {} });
        }
      });
    });
    req.on('error', () => resolve({ statusCode: 0, data: {} }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ statusCode: 0, data: {} }); });
  });
}

// ============================================================
// App
// ============================================================
app.whenReady().then(() => {
  migrateConfigIfNeeded();
  config = loadConfig();

  if (process.platform === 'win32' && app.isPackaged && config._iconCacheVersion !== app.getVersion()) {
    execFile('ie4uinit.exe', ['-show'], { windowsHide: true, timeout: 5000 }, () => {});
    config._iconCacheVersion = app.getVersion();
    saveConfig(config);
  }

  createWindowForMode();

  if (config.widgetMode !== 'notch' && config.collapsed) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setBounds({ x, y, width: 300, height: 38 }, false);
  }

  if (config.widgetMode !== 'notch' && isStartupHidden()) {
    try { mainWindow.hide(); } catch (_) {}
  }

  applyAutoStart(config.autoStart !== false);

  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon);
  tray.setToolTip('Git Monitor');
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (config.widgetMode === 'notch') {
      openConfigWindow();
      return;
    }
    if (mainWindow.isVisible()) mainWindow.focus();
    else { mainWindow.show(); mainWindow.focus(); }
  });

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Mostrar widget',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (config.widgetMode === 'notch') {
          switchWidgetMode('floating');
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
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
    { label: 'Verificar atualizações', click: () => autoUpdater.checkForUpdates() },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() }
  ]));

  // ---- Auto-updater ----
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    const sendUpdate = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', payload);
      if (configWindow && !configWindow.isDestroyed()) configWindow.webContents.send('update-check-result', payload);
    };

    autoUpdater.on('update-available', (info) => {
      sendUpdate({ type: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
      sendUpdate({ type: 'latest' });
    });

    autoUpdater.on('download-progress', (info) => {
      const pct = Math.round(info.percent);
      sendUpdate({ type: 'downloading', version: info.version, percent: pct });
    });

    autoUpdater.on('update-downloaded', (info) => {
      sendUpdate({ type: 'ready', version: info.version });
    });

    autoUpdater.on('error', (err) => {
      sendUpdate({ type: 'error', msg: err.message });
    });

    // Checa ao iniciar e a cada 4 horas
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
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
      else { mainWindow.show(); mainWindow.focus(); }
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
  const pending = results
    .filter(r => PENDING_STATES.includes(r.status))
    .map(r => ({
      name: r.name,
      path: r.path,
      status: r.status,
      detail: r.detail,
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
  const mapped = mapReposForNotch(results);
  return { repos: mapped, total: mapped.length };
});

ipcMain.on('notch-rect', (_, rect) => {
  if (!rect) return;
  notchRect = {
    w: Math.max(40, Number(rect.w) || 260),
    h: Math.max(8, Number(rect.h) || 38),
    offsetY: Number(rect.offsetY) || 0,
    hotzone: rect.hotzone != null ? Number(rect.hotzone) : null,
    right: Number(rect.right) || 12
  };
});

let _notchSaveTimer = null;
let _notchDragging = false;
let _notchDragPoll = null;
let _notchDragTimeout = null;

function endNotchDrag() {
  _notchDragging = false;
  if (_notchDragPoll) { clearInterval(_notchDragPoll); _notchDragPoll = null; }
  if (_notchDragTimeout) { clearTimeout(_notchDragTimeout); _notchDragTimeout = null; }
}

ipcMain.on('notch-drag-start', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  _notchDragging = true;
  mainWindow.setIgnoreMouseEvents(false);

  const startCursor = screen.getCursorScreenPoint();
  const baseOffset  = config.notchOffsetX ?? 40;

  if (_notchDragPoll) clearInterval(_notchDragPoll);
  if (_notchDragTimeout) clearTimeout(_notchDragTimeout);

  // Safety: auto-reset se drag-end nunca chegar (mouse solto fora da janela)
  _notchDragTimeout = setTimeout(() => {
    endNotchDrag();
    saveConfig(config);
  }, 8000);

  _notchDragPoll = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !_notchDragging) {
      clearInterval(_notchDragPoll); _notchDragPoll = null; return;
    }
    const d  = screen.getPrimaryDisplay();
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
