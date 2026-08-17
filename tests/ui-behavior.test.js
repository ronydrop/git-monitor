const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
  assert.match(guard[0], /configWindow[\s\S]*isDestroyed\(\)/);
  assert.match(guard[0], /zoneWindow[\s\S]*isDestroyed\(\)/);
  assert.match(guard[0], /diffWindows\.values\(\)/);

  assert.match(main, /setInterval\(\s*\(\)\s*=>\s*{[\s\S]*shouldRunWidgetTopmostWatchdog\(\)[\s\S]*ensureWidgetOnTop\('topmost-watchdog'\)/);
  assert.doesNotMatch(main, /ensureWidgetOnTop\('topmost-watchdog',\s*\{[\s\S]*(show|focus):/);
  assert.match(main, /createWindowForMode\(\);[\s\S]*startWidgetTopmostWatchdog\(\);/);
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

test('commit-and-push valida acesso remoto antes de criar commit local', () => {
  const main = read('main.js');
  const commitAndPush = main.match(/ipcMain\.handle\('commit-and-push'[\s\S]*?ipcMain\.handle\('open-folder'/);

  assert.ok(commitAndPush, 'commit-and-push handler should exist');
  assert.match(main, /async function verifyGitRemoteAccess\s*\(repoPath,\s*branch\)/);
  assert.match(main, /gitExecFile\(\['ls-remote', '--heads', 'origin', branch\]/);
  assert.match(commitAndPush[0], /if \(hasUncommitted\) \{\s*await verifyGitRemoteAccess\(repoPath, initialBranch\);[\s\S]*await gitExec\('git add \.'/);
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
