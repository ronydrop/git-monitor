const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { autoUpdater } = require('electron-updater');

function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ============================================================
// CONFIGURAÇÃO
// ============================================================
// Em produção: AppData\Roaming\Git Monitor\config.json (sobrevive a atualizações)
// Em dev: pasta do projeto
const CONFIG_FILE = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, 'config.json');

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
    githubToken: '',
    ghostZone: null
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { }
  const def = getDefaultConfig();
  saveConfig(def);
  return def;
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

function createWindow() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  const winX = config.windowX !== null ? config.windowX : screenW - 310;
  const winY = config.windowY !== null ? config.windowY : 10;

  mainWindow = new BrowserWindow({
    width: 300,
    height: config.windowHeight || 420,
    x: winX,
    y: winY,
    frame: false,
    transparent: false,
    backgroundColor: '#0d1117',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    opacity: config.opacity || 1.0,
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
  let fadeAnim = null;

  function fadeOpacity(from, to, durationMs) {
    if (fadeAnim) clearInterval(fadeAnim);
    const steps = 8;
    const stepMs = durationMs / steps;
    let step = 0;
    fadeAnim = setInterval(() => {
      step++;
      const t = step / steps;
      const val = from + (to - from) * t;
      mainWindow.setOpacity(Math.max(0.05, Math.min(1, val)));
      if (step >= steps) { clearInterval(fadeAnim); fadeAnim = null; }
    }, stepMs);
  }

  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (configWindow && !configWindow.isDestroyed()) {
      if (isGhost) { isGhost = false; fadeOpacity(0.08, config.opacity || 1.0, 180); }
      return;
    }
    if (!config.ghostZone) {
      if (isGhost) { isGhost = false; fadeOpacity(0.08, config.opacity || 1.0, 180); }
      return;
    }

    const cursor = screen.getCursorScreenPoint();

    const wb = mainWindow.getBounds();
    const onWidget = cursor.x >= wb.x && cursor.x < wb.x + wb.width
                  && cursor.y >= wb.y && cursor.y < wb.y + wb.height;

    const z = config.ghostZone;
    const inZone = cursor.x >= z.x && cursor.x < z.x + z.width
                && cursor.y >= z.y && cursor.y < z.y + z.height;

    const shouldGhost = inZone && !onWidget;

    if (shouldGhost && !isGhost) {
      isGhost = true;
      fadeOpacity(config.opacity || 1.0, 0.08, 200);
    } else if (!shouldGhost && isGhost) {
      isGhost = false;
      fadeOpacity(0.08, config.opacity || 1.0, 180);
    }
  }, 150);
}

// ============================================================
// Git Status Check (async — não bloqueia a thread principal)
// ============================================================
async function checkRepo(repoPath) {
  try {
    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
      return { status: 'error', detail: 'Repo não encontrado' };
    }

    // fetch roda em paralelo com status/branch — não bloqueamos esperando ele
    const fetchPromise = execAsync('git fetch --quiet', { cwd: repoPath, timeout: 10000 }).catch(() => {});

    const [statusOutput, branch] = await Promise.all([
      execAsync('git status --porcelain', { cwd: repoPath, timeout: 5000 }).then(o => o.trim()),
      execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, timeout: 5000 }).then(o => o.trim()),
    ]);

    // aguarda fetch antes de checar ahead/behind
    await fetchPromise;

    let ahead = 0, behind = 0;
    try {
      const abOutput = (await execAsync(
        `git rev-list --left-right --count ${branch}...origin/${branch}`,
        { cwd: repoPath, timeout: 5000 }
      )).trim();
      const parts = abOutput.split(/\s+/);
      ahead = parseInt(parts[0]) || 0;
      behind = parseInt(parts[1]) || 0;
    } catch (e) { }

    const hasChanges = statusOutput.length > 0;
    const changedFiles = hasChanges ? statusOutput.split('\n').length : 0;

    let status, detail;
    if (hasChanges && ahead > 0) {
      status = 'dirty-ahead';
      detail = `${changedFiles} modificado(s), ${ahead} não pushed`;
    } else if (hasChanges) {
      status = 'dirty';
      detail = `${changedFiles} arquivo(s) modificado(s)`;
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
      remoteUrl = (await execAsync('git config --get remote.origin.url', { cwd: repoPath, timeout: 3000 })).trim();
    } catch (e) { }

    return { status, detail, branch, ahead, behind, changedFiles, remoteUrl };
  } catch (e) {
    return { status: 'error', detail: e.message.substring(0, 80) };
  }
}

async function checkAllRepos() {
  // todos os repos em paralelo — nenhum bloqueia o próximo
  return Promise.all(config.repos.map(async repo => ({
    name: repo.name,
    path: repo.path,
    ...await checkRepo(repo.path)
  })));
}

// ============================================================
// IPC
// ============================================================
ipcMain.handle('check-repos', () => checkAllRepos());
ipcMain.handle('get-config', () => config);

ipcMain.handle('save-repos', (_, repos) => {
  config.repos = repos;
  saveConfig(config);
  return true;
});

ipcMain.handle('set-interval', (_, seconds) => {
  config.intervalSeconds = seconds;
  saveConfig(config);
  return true;
});

ipcMain.handle('close-app', () => app.quit());
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  zoneWindow.loadFile('zone-select.html');
  zoneWindow.on('closed', () => {
    zoneWindow = null;
    mainWindow.show();
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

ipcMain.handle('open-config-window', () => {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus();
    return;
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  configWindow = new BrowserWindow({
    width: 520,
    height: 620,
    x: Math.round((sw - 520) / 2),
    y: Math.round((sh - 620) / 2),
    frame: false,
    backgroundColor: '#0d1117',
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  configWindow.loadFile('config.html');
  configWindow.on('closed', () => { configWindow = null; });
});

ipcMain.handle('close-config-window', () => {
  if (configWindow && !configWindow.isDestroyed()) configWindow.close();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-saved');
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

  // Fallback: nome da pasta do projeto
  return path.basename(repoPath);
});

ipcMain.handle('minimize-app', () => {
  config.collapsed = !config.collapsed;
  saveConfig(config);
  const [x, y] = mainWindow.getPosition();
  const newH = config.collapsed ? 38 : (config.windowHeight || 420);
  mainWindow.setBounds({ x, y, width: 300, height: newH }, false);
  return config.collapsed;
});

ipcMain.handle('set-opacity', (_, value) => {
  config.opacity = value;
  saveConfig(config);
  mainWindow.setOpacity(value);
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

ipcMain.handle('commit-and-push', async (_, repoPath) => {
  try {
    // Checa se há mudanças não commitadas
    const statusOutput = (await execAsync('git status --porcelain', { cwd: repoPath, timeout: 5000 })).trim();
    const hasUncommitted = statusOutput.length > 0;

    if (hasUncommitted && !config.anthropicKey) {
      return { ok: false, error: 'API key da Anthropic não configurada.' };
    }

    let title = 'Push de commits pendentes';
    let body = '';

    if (hasUncommitted) {
      // Coleta o diff atual (staged + unstaged)
      let diff = '';
      try {
        const staged   = await execAsync('git diff --cached', { cwd: repoPath, timeout: 8000 });
        const unstaged = await execAsync('git diff', { cwd: repoPath, timeout: 8000 });
        diff = (staged + unstaged).trim();
      } catch (e) { diff = ''; }

      if (!diff) {
        diff = statusOutput || 'Mudanças sem diff disponível';
      }

      const diffTruncated = diff.length > 6000 ? diff.substring(0, 6000) + '\n\n[diff truncado por tamanho]' : diff;

      const client = new Anthropic({ apiKey: config.anthropicKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Você é um especialista em Git. Analise as mudanças abaixo e gere uma mensagem de commit em PORTUGUÊS BRASILEIRO.

Formato obrigatório (responda APENAS com a mensagem, sem explicações adicionais):
Linha 1: título curto e direto (máximo 60 caracteres), no imperativo (ex: "Adiciona", "Corrige", "Atualiza")
Linha 2: em branco
Linhas seguintes: descrição concisa das principais mudanças (máximo 3 linhas)

Mudanças:
\`\`\`
${diffTruncated}
\`\`\``
        }]
      });

      const commitMsg = msg.content[0].text.trim();
      const lines = commitMsg.split('\n');
      title = lines[0].trim();
      body = lines.slice(1).join('\n').trim();

      await execAsync('git add .', { cwd: repoPath, timeout: 10000 });
      const commitCmd = body
        ? `git commit -m "${title.replace(/"/g, '\\"')}" -m "${body.replace(/"/g, '\\"')}"`
        : `git commit -m "${title.replace(/"/g, '\\"')}"`;
      await execAsync(commitCmd, { cwd: repoPath, timeout: 15000 });
    }

    // Pull rebase para sincronizar com o remote, depois push
    try {
      await execAsync('git pull --rebase', { cwd: repoPath, timeout: 30000 });
    } catch (e) { }
    await execAsync('git push', { cwd: repoPath, timeout: 30000 });

    return { ok: true, title, body };
  } catch (e) {
    return { ok: false, error: e.message ? e.message.substring(0, 200) : String(e) };
  }
});

ipcMain.handle('open-folder', (_, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('git-pull', async (_, repoPath) => {
  try {
    await execAsync('git pull', { cwd: repoPath, timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message ? e.message.substring(0, 200) : String(e) };
  }
});

ipcMain.handle('open-terminal', (_, folderPath, projectName) => {
  const t = projectName || folderPath;
  const tab1 = `new-tab -d "${folderPath}" cmd /k "claude --resume && title ${t}"`;
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
  const https = require('https');
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

ipcMain.handle('check-deploy-status', async (_, repoPath) => {
  if (!config.githubToken) return { status: 'no-token' };

  try {
    const sha = (await execAsync('git rev-parse HEAD', { cwd: repoPath, timeout: 5000 })).trim();
    let remoteUrl = '';
    try {
      remoteUrl = (await execAsync('git config --get remote.origin.url', { cwd: repoPath, timeout: 3000 })).trim();
    } catch (e) { return { status: 'error', detail: 'Sem remote configurado' }; }

    const gh = parseGithubOwnerRepo(remoteUrl);
    if (!gh) return { status: 'error', detail: 'Não é um repo GitHub' };

    // Tenta check-runs (GitHub Actions)
    const checkRes = await githubApiGet(`/repos/${gh.owner}/${gh.repo}/commits/${sha}/check-runs`);

    if (checkRes.statusCode === 200 && checkRes.data.check_runs && checkRes.data.check_runs.length > 0) {
      const runs = checkRes.data.check_runs;
      const allCompleted = runs.every(r => r.status === 'completed');
      if (!allCompleted) {
        return { status: 'pending', detail: `${runs.filter(r => r.status !== 'completed').length} em andamento` };
      }
      const anyFailed = runs.some(r => r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out');
      if (anyFailed) {
        const failed = runs.filter(r => r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out');
        return { status: 'failure', detail: failed.map(r => r.name).join(', ') };
      }
      return { status: 'success' };
    }

    // Fallback: commit status API (Vercel, Render, deploys externos)
    const statusRes = await githubApiGet(`/repos/${gh.owner}/${gh.repo}/commits/${sha}/status`);

    if (statusRes.statusCode === 200 && statusRes.data.total_count > 0) {
      const state = statusRes.data.state;
      if (state === 'success') return { status: 'success' };
      if (state === 'failure' || state === 'error') {
        const failed = (statusRes.data.statuses || []).filter(s => s.state !== 'success');
        return { status: 'failure', detail: failed.map(s => s.context).join(', ') };
      }
      if (state === 'pending') return { status: 'pending' };
    }

    // API retornou erro HTTP — token sem acesso ao repo
    if (checkRes.statusCode !== 200 || statusRes.statusCode !== 200) {
      return { status: 'error', detail: `Token sem acesso ao repo (HTTP ${checkRes.statusCode || statusRes.statusCode})` };
    }

    return { status: 'none' };
  } catch (e) {
    return { status: 'error', detail: e.message ? e.message.substring(0, 100) : String(e) };
  }
});

// ============================================================
// App
// ============================================================
app.whenReady().then(() => {
  migrateConfigIfNeeded();
  config = loadConfig();
  createWindow();

  if (config.collapsed) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setBounds({ x, y, width: 300, height: 38 }, false);
  }

  const iconPath = app.isPackaged
    ? path.join(path.dirname(process.execPath), 'icon.ico')
    : path.join(__dirname, 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Git Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar', click: () => { mainWindow.show(); mainWindow.focus(); } },
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

    autoUpdater.on('update-downloaded', () => {
      sendUpdate({ type: 'ready' });
    });

    autoUpdater.on('error', (err) => {
      sendUpdate({ type: 'error', msg: err.message });
    });

    // Checa ao iniciar e a cada 4 horas
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
  }

  // Ctrl+Shift+G — esconder/mostrar o Git Monitor
  let windowHidden = false;
  globalShortcut.register('Ctrl+Shift+G', () => {
    if (windowHidden) {
      mainWindow.show();
      windowHidden = false;
    } else {
      mainWindow.hide();
      windowHidden = true;
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());
