const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

test('electron updater usa provider generico da VPS Jarvis', () => {
  const pkg = JSON.parse(read('package.json'));

  assert.deepStrictEqual(pkg.build.publish, {
    provider: 'generic',
    url: 'https://updates.botjarvis.com.br/git-monitor/'
  });
});

test('workflow builda no Windows e publica artefatos na VPS', () => {
  const workflow = read('.github/workflows/release.yml');

  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /electron-builder --win portable nsis --publish never/);
  assert.match(workflow, /JARVIS_UPDATE_HOST/);
  assert.match(workflow, /JARVIS_UPDATE_USER/);
  assert.match(workflow, /JARVIS_UPDATE_PORT/);
  assert.match(workflow, /JARVIS_UPDATE_SSH_KEY/);
  assert.match(workflow, /git-monitor-promote-artifacts/);
  assert.match(workflow, /scp -O -P "\$JARVIS_UPDATE_PORT" -i/);
  assert.doesNotMatch(workflow, /npm run release/);
  assert.doesNotMatch(workflow, /gh release edit/);
});

test('wrapper local envia pacote seguro para o runner remoto Jarvis', () => {
  const script = read('.codex/skills/push/scripts/git_monitor_push.ps1');

  assert.match(script, /ssh/i);
  assert.match(script, /scp/i);
  assert.match(script, /'scp'\s*@\('-O'/);
  assert.match(script, /git-monitor-release --apply/);
  assert.match(script, /\/srv\/git-monitor\/incoming/);
  assert.match(script, /New-ReleasePackage/);
  assert.match(script, /'diff'/);
  assert.match(script, /'--binary'/);
  assert.match(script, /'HEAD'/);
  assert.match(script, /Write-GitDiffPatch/);
  assert.doesNotMatch(script, /Set-Content -LiteralPath \$patchPath/);
  assert.match(script, /Write-Utf8NoBom/);
  assert.doesNotMatch(script, /npm'\s*@\('run',\s*'build'\)/);
});

test('runner remoto tem lock, validacoes e push atomico', () => {
  const runner = read('.codex/skills/push/scripts/git_monitor_release.sh');

  assert.match(runner, /flock/);
  assert.match(runner, /\/srv\/git-monitor\/repo/);
  assert.match(runner, /npm ci/);
  assert.match(runner, /npm test/);
  assert.match(runner, /npm audit/);
  assert.match(runner, /git diff --check/);
  assert.match(runner, /npm version "\$next_version" --no-git-tag-version/);
  assert.match(runner, /git push --atomic origin master "v\$next_version"/);
  assert.match(runner, /--validate-package <package\.tgz>/);
  assert.match(runner, /validate_package\(\)/);
});

test('runner remoto aceita dist apenas como ignoredPath e nunca como arquivo aplicavel', () => {
  const runner = read('.codex/skills/push/scripts/git_monitor_release.sh');

  assert.match(runner, /require_ignored_path\(\)/);
  assert.match(runner, /read_json\(\)/);
  assert.match(runner, /replace\(\W*\/\^\\uFEFF\//);
  assert.match(runner, /for \(const key of \["trackedPaths", "untrackedPaths"\]\)/);
  assert.doesNotMatch(runner, /for \(const key of \["trackedPaths", "untrackedPaths", "ignoredPaths"\]\)/);
  assert.match(runner, /dist\/\*/);
});

test('promoter remoto publica latest yml e artefatos atomicamente', () => {
  const promoter = read('.codex/skills/push/scripts/git_monitor_promote_artifacts.sh');

  assert.match(promoter, /\/var\/www\/local-dev-watcher-updates\/git-monitor/);
  assert.match(promoter, /latest\.yml/);
  assert.match(promoter, /GitMonitor-Setup-\$version\.exe/);
  assert.match(promoter, /GitMonitor-Setup-\$version\.exe\.blockmap/);
  assert.match(promoter, /GitMonitor-portable\.exe/);
  assert.match(promoter, /latest\.yml nao aponta/);
  assert.match(promoter, /mv "\$staging_dir" "\$release_dir"/);
});
