const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadConfigFile,
  readJsonFile,
  saveConfigFile
} = require('../config-store');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-monitor-config-'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fixedNow() {
  return new Date(2026, 0, 2, 3, 4, 5);
}

test('cria config default quando nao existe config nem backup', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  const backupFile = path.join(dir, 'config.backup.json');

  const loaded = loadConfigFile(configFile, () => ({ repos: [], theme: 'obsidian' }), {
    backupFile,
    now: fixedNow
  });

  assert.strictEqual(loaded.source, 'default');
  assert.deepStrictEqual(loaded.config, { repos: [], theme: 'obsidian' });
  assert.deepStrictEqual(readJson(configFile), { repos: [], theme: 'obsidian' });
  assert.strictEqual(fs.existsSync(backupFile), false);
});

test('salva config de forma atomica e preserva backup anterior valido', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  const backupFile = path.join(dir, 'config.backup.json');
  fs.writeFileSync(configFile, JSON.stringify({ repos: [{ name: 'Atual' }], version: 1 }, null, 2));

  saveConfigFile(configFile, { repos: [{ name: 'Nova' }], version: 2 }, { backupFile });

  assert.deepStrictEqual(readJson(configFile), { repos: [{ name: 'Nova' }], version: 2 });
  assert.deepStrictEqual(readJson(backupFile), { repos: [{ name: 'Atual' }], version: 1 });
  assert.deepStrictEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('restaura backup quando config principal esta truncado', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  const backupFile = path.join(dir, 'config.backup.json');
  fs.writeFileSync(configFile, '{"repos": [');
  fs.writeFileSync(backupFile, JSON.stringify({ repos: [{ name: 'Backup' }], token: 'preservado' }, null, 2));

  const loaded = loadConfigFile(configFile, () => ({ repos: [] }), {
    backupFile,
    now: fixedNow
  });

  assert.strictEqual(loaded.source, 'backup');
  assert.strictEqual(loaded.recovered, true);
  assert.deepStrictEqual(loaded.config, { repos: [{ name: 'Backup' }], token: 'preservado' });
  assert.deepStrictEqual(readJson(configFile), { repos: [{ name: 'Backup' }], token: 'preservado' });
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'config.invalid.20260102-030405.json'), 'utf8'),
    '{"repos": ['
  );
});

test('restaura backup quando config principal sumiu', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  const backupFile = path.join(dir, 'config.backup.json');
  fs.writeFileSync(backupFile, JSON.stringify({ repos: [{ name: 'Backup' }] }, null, 2));

  const loaded = loadConfigFile(configFile, () => ({ repos: [] }), { backupFile });

  assert.strictEqual(loaded.source, 'backup');
  assert.strictEqual(loaded.recovered, true);
  assert.deepStrictEqual(readJson(configFile), { repos: [{ name: 'Backup' }] });
});

test('identifica JSON vazio como config invalida', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, '');

  const result = readJsonFile(configFile);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.exists, true);
  assert.match(result.error.message, /vazio/);
});
