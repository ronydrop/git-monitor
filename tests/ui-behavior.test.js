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

test('floating renderer removes stale deploy buttons after backend refresh', () => {
  const index = read('index.html');

  assert.match(index, /function reconcileActiveDeployButtons\s*\(\s*results\s*\)/);
  assert.match(index, /delete activeDeployBtns\[repoPath\]/);
  assert.match(index, /const results = await ipcRenderer\.invoke\('check-repos'\);[\s\S]*reconcileActiveDeployButtons\(lastResults\);[\s\S]*renderRepos\(lastResults\)/);
});

test('startup revalidates persisted pending deploys before resuming watchers', () => {
  const main = read('main.js');

  assert.match(main, /async function resumePendingDeployWatchers\s*\(/);
  assert.match(main, /await resolveDeployPhaseForRepoSnapshot\s*\(/);
  assert.match(main, /deployPhase\.phase === 'success'[\s\S]*clearDeployState/);
  assert.match(main, /await resumePendingDeployWatchers\s*\(\s*\)/);
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
