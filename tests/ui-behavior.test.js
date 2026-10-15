const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDebouncedSave } = require('../config-store');

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

test('movimento da janela persiste somente a posição final e descarrega ao sair', () => {
  const source = read('main.js');
  const moved = source.match(/mainWindow\.on\('moved', (\(\) => \{[\s\S]*?\n  \})\);/);
  const closed = source.match(/mainWindow\.on\('closed', (\(\) => \{[\s\S]*?\n  \})\);/);
  const quit = source.match(/app\.on\('will-quit', (\(\) => \{[\s\S]*?\n\})\);/);
  assert.ok(moved && closed && quit);
  const originalSet = global.setTimeout;
  const originalClear = global.clearTimeout;
  const timers = new Map();
  let id = 0;
  global.setTimeout = fn => { timers.set(++id, fn); return id; };
  global.clearTimeout = timer => timers.delete(timer);
  let position = [0, 0];
  const saved = [];
  const config = { windowX: 0, windowY: 0 };
  const context = {
    config,
    mainWindow: { getPosition: () => position },
    resizeInterval: null,
    fadeAnim: null,
    ghostTimer: null,
    globalShortcut: { unregisterAll() {} },
    windowPositionSave: createDebouncedSave(() => saved.push({ ...config }))
  };
  try {
    const onMoved = vm.runInNewContext(`(${moved[1]})`, context);
    onMoved();
    assert.strictEqual(timers.size, 0);
    position = [10, 20]; onMoved();
    position = [30, 40]; onMoved();
    assert.strictEqual(timers.size, 1);
    assert.deepStrictEqual(saved, []);
    vm.runInNewContext(`(${closed[1]})()`, context);
    assert.deepStrictEqual(saved, [{ windowX: 30, windowY: 40 }]);
    assert.strictEqual(timers.size, 0);
    position = [50, 60]; onMoved();
    vm.runInNewContext(`(${quit[1]})()`, context);
    assert.deepStrictEqual(saved[1], { windowX: 50, windowY: 60 });
    assert.strictEqual(timers.size, 0);
    context.resizeInterval = 1;
    position = [70, 80]; onMoved();
    assert.strictEqual(timers.size, 0);
    assert.strictEqual(config.windowX, 50);
  } finally {
    global.setTimeout = originalSet;
    global.clearTimeout = originalClear;
  }
});

test('tray left click focuses widget instead of opening config in notch mode', () => {
  const main = read('main.js');

  assert.match(main, /function showOrFocusWidget\s*\(/);
  assert.match(main, /tray\.on\('click',\s*showOrFocusWidget\)/);
  assert.match(main, /label:\s*'Abrir configurações'[\s\S]*click:\s*\(\)\s*=>\s*openConfigWindow\(\)/);
  assert.doesNotMatch(main, /tray\.on\('click'[\s\S]*?if\s*\(config\.widgetMode\s*===\s*'notch'\)\s*{[\s\S]*?openConfigWindow\(\)/);
});

test('widget topmost state is reinforced through one helper', () => {
  const main = read('main.js');

  assert.match(main, /powerMonitor/);
  assert.match(main, /function ensureWidgetOnTop\s*\(\s*reason,\s*options\s*=\s*\{\s*\}\s*\)/);
  assert.match(main, /function ensureWidgetOnTop[\s\S]*setAlwaysOnTop\(true,\s*'screen-saver'\)[\s\S]*setVisibleOnAllWorkspaces\(true,\s*\{\s*visibleOnFullScreen:\s*true\s*\}\)[\s\S]*moveTop\(\)/);
  assert.match(main, /function createFloatingWindow[\s\S]*ensureWidgetOnTop\('floating-created'\)/);
  assert.match(main, /mainWindow\.on\('show'[\s\S]*ensureWidgetOnTop\('floating-show'\)/);
  assert.match(main, /function createNotchWindow[\s\S]*ensureWidgetOnTop\('notch-created'\)/);
  assert.match(main, /const repositionNotch = \(\) => \{[\s\S]*setBounds\(\{ x: nx, y: ny, width, height \}\)[\s\S]*ensureWidgetOnTop\('notch-display-change'\)/);
  assert.match(main, /function showOrFocusWidget\(\)[\s\S]*ensureWidgetOnTop\('show-or-focus', \{ show: true, focus: config\.widgetMode !== 'notch' \}\)/);
  assert.match(main, /const restoreMain = \(\) => \{[\s\S]*ensureWidgetOnTop\('zone-select-restore', \{ show: true \}\)/);
  assert.match(main, /else \{ ensureWidgetOnTop\('shortcut-toggle', \{ show: true, focus: config\.widgetMode !== 'notch' \}\); \}/);
  assert.match(main, /powerMonitor\.on\('resume'[\s\S]*ensureWidgetOnTop\('power-resume'\)/);
  assert.match(main, /powerMonitor\.on\('unlock-screen'[\s\S]*ensureWidgetOnTop\('power-unlock'\)/);
});

test('visible widget has a lightweight topmost watchdog without stealing focus', () => {
  const main = read('main.js');

  assert.match(main, /const WIDGET_TOPMOST_WATCHDOG_MS\s*=\s*3000/);
  assert.match(main, /let widgetTopmostWatchdog\s*=\s*null/);
  assert.match(main, /function shouldRunWidgetTopmostWatchdog\s*\(\s*\)/);

  const guard = main.match(/function shouldRunWidgetTopmostWatchdog\s*\(\s*\)\s*{[\s\S]*?return true;\s*\n}/);
  assert.ok(guard, 'watchdog guard should exist');
  assert.match(guard[0], /mainWindow\.isVisible\(\)/);
  assert.match(guard[0], /zoneWindow[\s\S]*isDestroyed\(\)/);

  assert.match(main, /setInterval\(\s*\(\)\s*=>\s*{[\s\S]*shouldRunWidgetTopmostWatchdog\(\)[\s\S]*ensureWidgetOnTop\('topmost-watchdog'\)/);
  assert.doesNotMatch(main, /ensureWidgetOnTop\('topmost-watchdog',\s*\{[\s\S]*(show|focus):/);
  assert.match(main, /createWindowForMode\(\);[\s\S]*startWidgetTopmostWatchdog\(\);/);
});

function topmostScenario(mode = 'notch') {
  const order = [];
  let focused = 'outro aplicativo';
  const window = name => ({
    visible: true, minimized: false, destroyed: false, topmost: false,
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    isFocused() { return focused === name; },
    setAlwaysOnTop(value) { this.topmost = value; },
    setVisibleOnAllWorkspaces() {},
    moveTop() { this.visible = true; order.push(name); },
    show() { this.visible = true; focused = name; },
    showInactive() { this.visible = true; },
    focus() { focused = name; }
  });
  const context = {
    mainWindow: window('widget'), config: { widgetMode: mode },
    configWindow: null, zoneWindow: null, diffWindows: new Map(),
    inputPollersPaused: false, widgetTopmostWatchdog: null,
    WIDGET_TOPMOST_WATCHDOG_MS: 3000,
    setInterval(callback) { context.tick = callback; return { unref() {} }; }
  };
  const main = read('main.js');
  for (const name of ['ensureWidgetOnTop', 'shouldRunWidgetTopmostWatchdog', 'startWidgetTopmostWatchdog']) {
    const source = main.match(new RegExp('function ' + name + '\\([^]*?\\n}'));
    assert.ok(source, name);
    vm.runInNewContext(source[0], context);
  }
  context.startWidgetTopmostWatchdog();
  return { context, window, order, focused: () => focused };
}

test('recupera a prioridade com configurações e diffs abertos nos dois modos sem roubar foco', () => {
  for (const mode of ['floating', 'notch']) {
    const { context, window, order, focused } = topmostScenario(mode);
    context.configWindow = window('configurações');
    const diff = window('diff');
    context.diffWindows.set('repositório', diff);
    context.tick();
    assert.strictEqual(context.mainWindow.topmost, true, mode);
    assert.strictEqual(context.configWindow.topmost, true);
    assert.strictEqual(diff.topmost, true);
    assert.deepStrictEqual(order, ['widget', 'configurações', 'diff']);
    assert.strictEqual(focused(), 'outro aplicativo');

    context.configWindow.focus();
    order.length = 0;
    context.tick();
    assert.deepStrictEqual(order, ['widget', 'diff', 'configurações']);
    assert.strictEqual(focused(), 'configurações');
  }
});

test('janelas auxiliares ocultas, minimizadas ou destruídas não impedem a recuperação', () => {
  for (const state of ['hidden', 'minimized', 'destroyed']) {
    const { context, window, order } = topmostScenario();
    const auxiliary = window('auxiliar');
    auxiliary.visible = state !== 'hidden';
    auxiliary.minimized = state === 'minimized';
    auxiliary.destroyed = state === 'destroyed';
    context.configWindow = auxiliary;
    context.diffWindows.set('repositório', auxiliary);
    context.tick();
    assert.strictEqual(context.mainWindow.topmost, true, state);
    assert.deepStrictEqual(order, ['widget']);
    assert.strictEqual(auxiliary.visible, state !== 'hidden');
  }
});

test('recuperação automática respeita widget oculto, minimizado e sessão bloqueada', () => {
  for (const mode of ['floating', 'notch']) {
    for (const state of ['hidden', 'minimized', 'locked']) {
      const { context, order } = topmostScenario(mode);
      context.mainWindow.visible = state !== 'hidden';
      context.mainWindow.minimized = state === 'minimized';
      context.inputPollersPaused = state === 'locked';
      context.tick();
      context.ensureWidgetOnTop('power-resume');
      assert.deepStrictEqual(order, [], `${mode}: ${state}`);
      assert.strictEqual(context.mainWindow.visible, state !== 'hidden');
    }
  }
});

test('seleção de zona suspende a recuperação e exibição explícita preserva foco do notch', () => {
  const { context, window, order, focused } = topmostScenario();
  context.zoneWindow = window('seleção');
  context.tick();
  assert.deepStrictEqual(order, []);
  context.zoneWindow = null;
  context.mainWindow.visible = false;
  context.ensureWidgetOnTop('shortcut-toggle', { show: true });
  assert.strictEqual(context.mainWindow.visible, true);
  assert.strictEqual(context.mainWindow.topmost, true);
  assert.strictEqual(focused(), 'outro aplicativo');
});

test('widget roots hide overflow and use internal shadow padding', () => {
  const index = read('index.html');
  const notch = read('notch.html');

  assert.match(index, /html,\s*body\s*{[\s\S]*overflow:\s*hidden/);
  assert.match(index, /\.widget-shell\s*{[\s\S]*padding:[^;]*var\(--shadow-pad/);
  assert.match(index, /<div class="widget-shell">\s*<div class="container"/);

  assert.match(notch, /html,\s*body\s*{[\s\S]*overflow:\s*hidden/);
  assert.match(notch, /--notch-shadow-pad:\s*\d+px/);
  assert.match(notch, /#pill\s*{[\s\S]*right:\s*var\(--notch-shadow-pad\)/);
  assert.doesNotMatch(notch, /translateX\(-50%\)/);
});

test('commit errors render as inline widget alerts instead of external toast windows', () => {
  const index = read('index.html');
  const notch = read('notch.html');

  assert.match(index, /class="widget-alerts"/);
  assert.match(index, /function showWidgetAlert\s*\(/);
  assert.match(index, /function showCommitToast\s*\([\s\S]*showWidgetAlert/);

  assert.match(notch, /class="notch-alerts"/);
  assert.match(notch, /function showNotchAlert\s*\(/);
  assert.match(notch, /function showCommitToast\s*\([\s\S]*showNotchAlert/);
});

test('alertas compactos preservam o erro completo no tooltip nos dois modos', () => {
  const message = ('Falha ao criar o commit: ' + 'Inventário financeiro exige revisão. '.repeat(20)).trim();
  for (const file of ['index.html', 'notch.html']) {
    const source = read(file);
    const nodes = [];
    const element = () => ({ classList: { toggle() {} }, replaceChildren() {}, appendChild(child) { this.children.push(child); }, children: [] });
    const target = element();
    const context = {
      widgetAlerts: [], document: { getElementById: () => target, createElement() { const node = element(); nodes.push(node); return node; } },
      icon: () => element(), setTimeout() {}, updateShape() {}, miniAlertsEl: target, expandedAlertsEl: element()
    };
    const functions = file === 'index.html'
      ? ['renderWidgetAlerts', 'showWidgetAlert', 'showCommitToast']
      : ['renderAlertContainer', 'renderNotchAlerts', 'showNotchAlert', 'showCommitToast'];
    for (const name of functions) {
      const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  }'));
      assert.ok(match, name);
      vm.runInNewContext(match[0], context);
    }
    context.showCommitToast('err', message);
    assert.strictEqual(context.widgetAlerts[0].text, message);
    assert.strictEqual(nodes[0].title, message);
    assert.ok(nodes[1].textContent.length <= 240);
  }
});

require('node:test').test('IPC preserva o motivo do hook e separa commit, timeout e push', async () => {
  const main = read('main.js');
  const source = main.slice(main.indexOf("ipcMain.handle('commit-and-push'"), main.indexOf("ipcMain.handle('open-folder'"));
  const { formatGitError, formatGitOperationError } = require('../git-sync');
  const { buildCommitArgs } = require('../commit-message');
  for (const failedStage of ['commit', 'timeout', 'push']) {
    let handler;
    let released = false;
    const commands = [];
    const reason = 'Commit bloqueado: UNCLASSIFIED_UNRESOLVED: ' + 'PostbackQueryRepository.history '.repeat(15);
    const error = Object.assign(new Error('Command failed: git commit -m ' + 'Descrição '.repeat(40)), {
      stderr: reason, stdout: 'Revisão do inventário',
      ...(failedStage === 'timeout' ? { killed: true, signal: 'SIGTERM' } : {})
    });
    const context = {
      ipcMain: { handle(channel, callback) { handler = callback; } }, acquireRepoLock: async () => () => { released = true; },
      markWriting() {}, cleanStaleLock() {}, findConfiguredRepo: () => null, repoDeployEnabled: () => false,
      getDeployStateForRepo: () => null, isDeployStatePending: () => false, clearDeployState: value => value, saveConfig() {},
      config: { anthropicKey: 'fixture' }, verifyGitRemoteAccess: async () => { commands.push('remote-preflight'); },
      generateCommitMessage: async () => 'Correção de teste', parseCommitMessage: () => ({ title: 'Correção de teste', body: '' }),
      buildCommitArgs, pullRebaseCommand: () => 'git pull --rebase', pushCommand: () => 'git push', formatGitError, formatGitOperationError,
      isGitAuthError: () => false, isRebaseConflictError: () => false,
      gitExec: async command => {
        commands.push(command);
        if (command === 'git push') throw error;
        if (command.includes('--abbrev-ref')) return 'dev';
        if (command === 'git rev-parse HEAD') return 'abcdef';
        if (command.includes('status')) return 'M arquivo.ts';
        return '';
      },
      gitExecFile: async () => { if (failedStage !== 'push') throw error; }
    };
    vm.runInNewContext(source, context);
    const result = await handler(null, 'fixture');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes(reason));
    assert.ok(result.error.startsWith(failedStage === 'push' ? 'Falha no push' : 'Falha ao criar o commit'));
    assert.strictEqual(result.error.includes('tempo limite excedido'), failedStage === 'timeout');
    assert.strictEqual(commands.includes('git push'), failedStage === 'push');
    assert.ok(commands.indexOf('remote-preflight') < commands.indexOf('git add .'));
    assert.ok(released);
  }
});

test('seletores mostram preços sem perder o modelo salvo e normalizam modelos removidos', () => {
  const main = read('main.js');
  const config = read('config.html');
  const catalog = {};
  vm.runInNewContext(main.slice(main.indexOf('const AI_PROVIDERS ='), main.indexOf('function isDeployModeDisabled')) +
    '\nthis.options = AI_MODEL_OPTIONS; this.defaults = DEFAULT_AI_MODELS; this.normalize = normalizeAiModel;', catalog);
  const selects = {};
  for (const provider of Object.keys(catalog.options)) {
    const models = catalog.options[provider];
    const saved = models[models.length - 1].id;
    assert.strictEqual(catalog.normalize(provider, saved), saved);
    assert.strictEqual(catalog.normalize(provider, 'modelo-removido'), catalog.defaults[provider]);
    assert.strictEqual(new Set(models.map(model => model.id)).size, models.length);
    for (const model of models) {
      assert.ok(Number.isFinite(model.pricing.input) && model.pricing.input >= 0, model.id);
      assert.ok(Number.isFinite(model.pricing.output) && model.pricing.output >= 0, model.id);
    }
    selects[provider + 'Model'] = {
      children: [],
      appendChild(option) { this.children.push(option); },
      get selectedOptions() { return this.children.filter(option => option.value === this.value); }
    };
  }
  const configSafe = { aiModelOptions: catalog.options };
  for (const provider of Object.keys(catalog.options)) {
    configSafe[provider + 'Model'] = catalog.options[provider].at(-1).id;
  }
  const context = {
    configSafe,
    clearEl: el => { el.children = []; },
    document: { getElementById: id => selects[id], createElement: () => ({}) }
  };
  const render = config.slice(config.indexOf('  function populateModelSelects()'), config.indexOf('  const modeHints ='));
  vm.runInNewContext(render + '\npopulateModelSelects();', context);
  for (const provider of Object.keys(catalog.options)) {
    const select = selects[provider + 'Model'];
    assert.strictEqual(select.value, configSafe[provider + 'Model']);
    assert.strictEqual(select.children.length, catalog.options[provider].length);
    assert.ok(select.children.every(option => /US\$.*ent\..*saída/.test(option.textContent)));
    assert.strictEqual(select.title, select.selectedOptions[0].textContent);
  }
  assert.match(selects.anthropicModel.children[0].textContent, /0,10.*0,50/);
  const deepseek = selects.openrouterModel.children.find(option => option.value === 'deepseek/deepseek-v4.1-flash');
  assert.match(deepseek.textContent, /0,01368.*0,891/);
  for (const provider of Object.keys(catalog.options)) delete configSafe[provider + 'Model'];
  vm.runInNewContext('populateModelSelects();', context);
  for (const provider of Object.keys(catalog.options)) {
    assert.strictEqual(selects[provider + 'Model'].value, catalog.defaults[provider]);
  }
});

test('commit-and-push valida acesso remoto antes de criar commit local', () => {
  const main = read('main.js');
  const commitAndPush = main.match(/ipcMain\.handle\('commit-and-push'[\s\S]*?ipcMain\.handle\('open-folder'/);

  assert.ok(commitAndPush, 'commit-and-push handler should exist');
  assert.match(main, /async function verifyGitRemoteAccess\s*\(repoPath,\s*branch\)/);
  assert.match(main, /gitExecFile\(\['ls-remote', '--heads', 'origin', branch\]/);
  assert.match(commitAndPush[0], /if \(hasUncommitted\) \{\s*stage = 'na validação do acesso remoto';\s*await verifyGitRemoteAccess\(repoPath, initialBranch\);[\s\S]*await gitExec\('git add \.'/);
});

test('notch reveal does not force hover expansion and uses shared geometry fallback', () => {
  const main = read('main.js');
  const notch = read('notch.html');
  const revealHandler = notch.match(/ipcRenderer\.on\('notch-reveal',\s*\(\)\s*=>\s*{[\s\S]*?}\);/);

  assert.ok(revealHandler, 'notch-reveal handler should exist');
  assert.doesNotMatch(revealHandler[0], /hovered\s*=\s*true/);
  assert.match(revealHandler[0], /minimized\s*=\s*false/);
  assert.match(revealHandler[0], /hovered\s*=\s*false/);
  assert.match(main, /const NOTCH_COMPACT_LEFT\s*=\s*102/);
  assert.match(main, /left:\s*NOTCH_COMPACT_LEFT/);
  assert.match(main, /left:\s*N\(rect\.left,\s*NOTCH_COMPACT_LEFT\)/);
  assert.doesNotMatch(main, /N\(rect\.left,\s*65\)/);
});

test('notch ghost zone is automatic around reported notch geometry', () => {
  const main = read('main.js');
  const notch = read('notch.html');

  assert.match(main, /const NOTCH_GHOST_ZONE_PAD_X\s*=\s*\d+/);
  assert.match(main, /const NOTCH_GHOST_ZONE_PAD_Y\s*=\s*\d+/);
  assert.match(main, /function getNotchInteractionGeometry\s*\(bounds,\s*rect\)/);
  assert.match(main, /ghostZone:\s*inflateRect\(hitRect,\s*NOTCH_GHOST_ZONE_PAD_X,\s*NOTCH_GHOST_ZONE_PAD_Y\)/);
  assert.match(main, /const shouldGhost\s*=\s*pointInRect\(c,\s*ghostZone\)\s*&&\s*!inside/);
  assert.match(main, /sendNotchGhostState\(shouldGhost\)/);
  assert.match(main, /ipcMain\.handle\('start-zone-select'[\s\S]*config\.widgetMode === 'notch'[\s\S]*return/);

  assert.match(notch, /ipcRenderer\.on\('notch-ghost',\s*\(_,\s*on\)\s*=>\s*{/);
  assert.match(notch, /pill\.classList\.toggle\('ghost',\s*ghostActive\)/);
  assert.doesNotMatch(notch, /const want = ev\.ctrlKey/);
});

test('floating renderer removes stale deploy buttons after backend refresh', () => {
  const index = read('index.html');

  assert.match(index, /function reconcileActiveDeployButtons\s*\(\s*results\s*\)/);
  assert.match(index, /delete activeDeployBtns\[repoPath\]/);
  assert.match(index, /const results = await ipcRenderer\.invoke\('check-repos'\);[\s\S]*reconcileActiveDeployButtons\(lastResults\);[\s\S]*renderRepos\(lastResults\)/);
});

test('notch renderer removes stale deploy rows after backend refresh', () => {
  const notch = read('notch.html');

  assert.match(notch, /const LOCAL_DEPLOY_RECONCILE_GRACE_MS\s*=\s*15000/);
  assert.match(notch, /function reconcileDeployingRows\s*\(\s*results\s*\)/);
  assert.match(notch, /Date\.now\(\) - \(entry\.startedAt \|\| 0\) < LOCAL_DEPLOY_RECONCILE_GRACE_MS/);
  assert.match(notch, /function settlePushAllDeploy\s*\(\s*repoPath,\s*phase\s*\)/);
  assert.match(notch, /settlePushAllDeploy\(repoPath,\s*repo\.deployError \? 'failure' : 'success'\)/);
  assert.match(notch, /delete deployingRows\[repoPath\]/);
  assert.match(notch, /delete deployPhases\[repoPath\]/);
  assert.match(notch, /deployingRows\[r\.path\]\s*=\s*\{ repoName: r\.name \|\| r\.path, fromPushAll: true, startedAt: Date\.now\(\) \}/);
  assert.match(notch, /deployingRows\[p\]\s*=\s*\{ repoName: rname, fromPushAll: false, startedAt: Date\.now\(\) \}/);
  assert.match(notch, /const res = await ipcRenderer\.invoke\('notch-all-repos'\);[\s\S]*repos = \(res && res\.repos\) \|\| \[\];[\s\S]*reconcileDeployingRows\(repos\);[\s\S]*renderList\(\)/);
});

test('renderers let pending deploy dominate clean git visual status', () => {
  const index = read('index.html');
  const notch = read('notch.html');

  assert.match(index, /const \{ repoVisualStatus \} = require\('\.\/repo-state'\)/);
  assert.match(index, /function displayStatus\s*\(\s*r,\s*isDeploying\s*\)\s*{[\s\S]*repoVisualStatus\(r,\s*!!isDeploying\)/);
  assert.match(index, /const visualStatus = displayStatus\(r,\s*isDeploying\);[\s\S]*dot\.className = 'repo-dot ' \+ visualStatus/);
  assert.match(index, /badge\.className = 'repo-badge badge-' \+ visualStatus/);
  assert.match(index, /detailEl\.textContent = detailText\(r,\s*isDeploying\)/);
  assert.match(index, /'Deploy em andamento' : 'Deploy pendente'/);

  assert.match(notch, /const \{ repoVisualStatus \} = require\('\.\/repo-state'\)/);
  assert.match(notch, /\.dot\.deploying/);
  assert.match(notch, /function isDeployingRepo\s*\(r\)\s*{[\s\S]*r\.deployPending[\s\S]*deployingRows\[r\.path\]/);
  assert.match(notch, /function displayStatus\s*\(r\)\s*{[\s\S]*repoVisualStatus\(r,\s*isDeployingRepo\(r\)\)/);
  assert.match(notch, /const isDeploying = isDeployingRepo\(r\)/);
  assert.match(notch, /repos\.filter\(r => r\.needsAttention \|\| r\.pending \|\| r\.deployPending \|\| r\.deployError\)/);
});

test('transient GitHub API failures stay pending instead of becoming deploy errors', () => {
  const main = read('main.js');

  assert.match(main, /isTransientGithubApiProblem/);
  assert.match(main, /githubApiRetryDetail/);
  assert.ok(
    (main.match(/if \(isTransientGithubApiProblem\(apiResponses\)\)/g) || []).length >= 2,
    'snapshot reconciliation and active watcher must both handle transient API failures'
  );
  assert.match(main, /isTransientGithubApiProblem\(apiResponses\)[\s\S]*phase:\s*'waiting'[\s\S]*githubApiRetryDetail\(apiResponses\)/);
});

test('deploy reconciliation uses persisted deadline and phase-aware detail', () => {
  const main = read('main.js');

  assert.match(main, /applyDeployWatchDeadline/);
  assert.ok(
    (main.match(/applyDeployWatchDeadline\(/g) || []).length >= 2,
    'snapshot reconciliation and active watcher must share the persisted deadline'
  );
  assert.match(main, /deployPhaseDetail/);
  assert.ok(
    (main.match(/detail:\s*deployPhaseDetail\(/g) || []).length >= 3,
    'every persisted deploy update must use phase-aware detail'
  );
  assert.doesNotMatch(main, /DEPLOY_MAX_ATTEMPTS/);
});

test('CI failures from external pushes are detected without a stored deploy state', () => {
  const main = read('main.js');

  assert.doesNotMatch(main, /if \(!current \|\| current\.phase === 'success'\) continue;/);
  assert.match(main, /shouldRefreshRepoCi\(repo, current, ciProbeCache\.get\(probeKey\), now\)/);
  assert.match(main, /if \(!current\) \{\s*next = await probeRepoCiState\(repo, next, now\);/);
  assert.match(main, /isAdoptedProbePhase\(deployPhase\.phase\)/);
});

test('deploy status details expose the complete reason in native hover tooltips', () => {
  const index = read('index.html');
  const notch = read('notch.html');

  assert.match(index, /const fullDetailText = detailText\(r,\s*isDeploying\);[\s\S]*detailEl\.textContent = fullDetailText;[\s\S]*if \(r\.deployDetail\) detailEl\.title = fullDetailText;/);
  assert.match(notch, /const fullDetailText = detailText\(r\);[\s\S]*className:\s*'detail',[\s\S]*textContent:\s*fullDetailText,[\s\S]*title:\s*r\.deployDetail \? fullDetailText : ''/);
});

test('error alerts stay visible for at least ten seconds', () => {
  const index = read('index.html');
  const notch = read('notch.html');

  assert.match(index, /type === 'err'[\s\S]*Math\.max\(Number\(duration\) \|\| 0,\s*10000\)/);
  assert.match(index, /const duration = type === 'err' \? 10000 : 3500/);

  assert.match(notch, /type === 'err'[\s\S]*Math\.max\(Number\(duration\) \|\| 0,\s*10000\)/);
  assert.match(notch, /const displayDuration = type === 'err'[\s\S]*Math\.max\(Number\(duration\) \|\| 0,\s*10000\)/);
});

test('startup revalidates persisted pending deploys before resuming watchers', () => {
  const main = read('main.js');

  assert.match(main, /async function resumePendingDeployWatchers\s*\(/);
  assert.match(main, /await resolveDeployPhaseForRepoSnapshot\s*\(/);
  assert.match(main, /deployPhase\.phase === 'success'[\s\S]*clearDeployState/);
  assert.match(main, /await resumePendingDeployWatchers\s*\(\s*\)/);
});

test('startup prunes persisted deploy state for repos without deploy', () => {
  const main = read('main.js');

  assert.match(main, /pruneDeployErrorsForRepos/);
  assert.match(main, /function loadConfig\s*\(\s*\)[\s\S]*cfg\.repos = normalizeReposDeployConfig\(cfg\.repos\)/);
  assert.match(main, /function loadConfig\s*\(\s*\)[\s\S]*cfg\.deployStates = pruneDeployStatesForRepos\(cfg\.deployStates,\s*cfg\.repos\)/);
  assert.match(main, /function loadConfig\s*\(\s*\)[\s\S]*cfg\.deployErrors = pruneDeployErrorsForRepos\(cfg\.deployErrors,\s*cfg\.repos\)/);
  assert.match(main, /if \(normalizedDeployConfig !== originalDeployConfig\) \{[\s\S]*saveConfig\(cfg\)/);
});

test('repo lists are sorted with deploy and git pending items first', () => {
  const main = read('main.js');
  const repoState = read('repo-state.js');

  assert.match(repoState, /function sortReposByAttention\s*\(/);
  assert.match(main, /sortReposByAttention\(results\.map\(r => applyDeployState/);
  assert.match(main, /repos: sortReposByAttention\(filtered\)/);
  assert.match(main, /const pending = sortReposByAttention\(results/);
  assert.match(main, /const mapped = sortReposByAttention\(mapReposForNotch\(results\)\)/);
});

test('local packaged builds without update metadata do not call autoUpdater', () => {
  const main = read('main.js');
  const checkForUpdates = main.match(/function checkForUpdatesSafely\s*\(\s*\)\s*{[\s\S]*?\n}/);

  assert.ok(checkForUpdates, 'safe update checker should exist');
  assert.match(main, /function hasAutoUpdateMetadata\s*\(\s*\)/);
  assert.match(main, /path\.join\(process\.resourcesPath,\s*'app-update\.yml'\)/);
  assert.match(main, /function localBuildUpdateStatus\s*\(\s*\)[\s\S]*type:\s*'local-build'/);
  assert.match(checkForUpdates[0], /!hasAutoUpdateMetadata\(\)[\s\S]*localBuildUpdateStatus\(\)/);
  assert.match(checkForUpdates[0], /return\s+autoUpdater\.checkForUpdates\(\)/);
  assert.match(main, /ipcMain\.handle\('check-for-updates',\s*\(\)\s*=>\s*{[\s\S]*checkForUpdatesSafely\(\)/);
});

test('update errors display the real message instead of assuming missing release', () => {
  const config = read('config.html');

  assert.match(config, /function updateErrorLabel\s*\(\s*status\s*\)/);
  assert.match(config, /Build local sem auto-update/);
  assert.match(config, /sem release publicado/);
  assert.match(config, /status\.msg/);
  assert.match(config, /status\.type === 'local-build'/);
  assert.match(config, /setIconLabel\(btn,\s*'x',\s*updateErrorLabel\(status\)\)/);
  assert.doesNotMatch(config, /status\.type === 'error'\)[\s\S]*setIconLabel\(btn,\s*'x',\s*'Erro: sem release publicado'/);
});
