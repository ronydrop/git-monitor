const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs   = require('fs');

// ============================================================
// CONFIG
// ============================================================
const CONFIG_FILE = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, 'config.json');

function getDefaultConfig() {
  return {
    intervalMs: 2000,
    windowX: null,
    windowY: null,
    windowWidth: 800,
    windowHeight: 480
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {}
  const d = getDefaultConfig();
  saveConfig(d);
  return d;
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {}
}

let mainWindow, tray, config;

// ============================================================
// JANELA PRINCIPAL — janela normal, nao widget fixo
// ============================================================
function createWindow() {
  const opts = {
    width:  config.windowWidth  || 800,
    height: config.windowHeight || 480,
    frame: false,
    backgroundColor: '#03040a',
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    minWidth: 480,
    minHeight: 300,
    webPreferences: { nodeIntegration: true, contextIsolation: false, touchEvents: true }
  };
  if (config.windowX !== null) opts.x = config.windowX;
  if (config.windowY !== null) opts.y = config.windowY;

  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile('index.html');

  mainWindow.on('moved', () => {
    const [x, y] = mainWindow.getPosition();
    config.windowX = x; config.windowY = y;
    saveConfig(config);
  });
  mainWindow.on('resized', () => {
    const [w, h] = mainWindow.getSize();
    config.windowWidth = w; config.windowHeight = h;
    saveConfig(config);
  });
}

// ============================================================
// IPC — controles de janela
// ============================================================
ipcMain.handle('close-app',        () => app.quit());
ipcMain.handle('minimize-app',     () => mainWindow.minimize());
ipcMain.handle('maximize-app',     () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.handle('toggle-fullscreen',() => mainWindow.setFullScreen(!mainWindow.isFullScreen()));
ipcMain.handle('toggle-ontop',     () => {
  const v = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(v);
  config.alwaysOnTop = v; saveConfig(config);
  return v;
});
ipcMain.handle('get-app-version',  () => app.getVersion());
ipcMain.handle('get-config',       () => config);
ipcMain.handle('save-interval',    (_, ms) => { config.intervalMs = ms; saveConfig(config); });

// ============================================================
// HARDWARE MONITORING via systeminformation
// ============================================================
let si = null;
function getSI() {
  if (!si) si = require('systeminformation');
  return si;
}

// Info estatica — chamado uma vez no startup
ipcMain.handle('get-static-info', async () => {
  const lib = getSI();
  try {
    const [cpu, osInfo, system, bios, diskLayout, graphics] = await Promise.all([
      lib.cpu(),
      lib.osInfo(),
      lib.system(),
      lib.bios(),
      lib.diskLayout(),
      lib.graphics()
    ]);
    return { cpu, osInfo, system, bios, diskLayout, graphics };
  } catch (e) {
    return { error: e.message };
  }
});

// Stats em tempo real — chamado a cada intervalMs
ipcMain.handle('get-realtime-stats', async () => {
  const lib = getSI();
  try {
    const [
      cpuLoad,
      cpuTemp,
      cpuSpeed,
      mem,
      graphics,
      fsSize,
      networkStats,
      battery,
      processes
    ] = await Promise.all([
      lib.currentLoad(),
      lib.cpuTemperature(),
      lib.cpuCurrentSpeed(),
      lib.mem(),
      lib.graphics(),
      lib.fsSize(),
      lib.networkStats('*'),
      lib.battery(),
      lib.processes()
    ]);
    return { cpuLoad, cpuTemp, cpuSpeed, mem, graphics, fsSize, networkStats, battery, processes };
  } catch (e) {
    return { error: e.message };
  }
});

// ============================================================
// APP INIT
// ============================================================
app.whenReady().then(() => {
  config = loadConfig();
  createWindow();

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'icon.ico');

  if (fs.existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip('PC Monitor');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Mostrar',  click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      { label: 'Sair',     click: () => app.quit() }
    ]));
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  }

  // Atalho global Ctrl+Shift+P — esconde/mostra
  globalShortcut.register('Ctrl+Shift+P', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
