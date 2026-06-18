const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  atomicWriteFile,
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

test('salva config de forma atomica com backup antes e depois', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  const backupFile = path.join(dir, 'config.backup.json');
  const current = { repos: [{ name: 'Atual' }], version: 1 };
  const next = { repos: [{ name: 'Nova' }], version: 2 };
  fs.writeFileSync(configFile, JSON.stringify(current, null, 2));

  saveConfigFile(configFile, next, { backupFile, now: fixedNow });

  assert.deepStrictEqual(readJson(configFile), next);
  assert.deepStrictEqual(readJson(backupFile), next);
  assert.deepStrictEqual(readJson(path.join(dir, 'config.backup-before-save.20260102-030405.json')), current);
  assert.deepStrictEqual(readJson(path.join(dir, 'config.backup-after-save.20260102-030405.json')), next);
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

test('restaura backup historico quando config principal e backup fixo estao invalidos', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  const backupFile = path.join(dir, 'config.backup.json');
  const historicalBackup = path.join(dir, 'config.backup-after-save.20260102-020304.json');
  fs.writeFileSync(configFile, '\u0000'.repeat(128));
  fs.writeFileSync(backupFile, '{"repos": [');
  fs.writeFileSync(historicalBackup, JSON.stringify({ repos: [{ name: 'Historico' }], version: 7 }, null, 2));

  const loaded = loadConfigFile(configFile, () => ({ repos: [] }), {
    backupFile,
    now: fixedNow
  });

  assert.strictEqual(loaded.source, 'backup-history');
  assert.strictEqual(loaded.recovered, true);
  assert.deepStrictEqual(loaded.config, { repos: [{ name: 'Historico' }], version: 7 });
  assert.deepStrictEqual(readJson(configFile), { repos: [{ name: 'Historico' }], version: 7 });
  assert.deepStrictEqual(readJson(backupFile), { repos: [{ name: 'Historico' }], version: 7 });
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'config.invalid.20260102-030405.json'), 'utf8'),
    '\u0000'.repeat(128)
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

test('identifica JSON com bytes NUL como config invalida', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, Buffer.alloc(64));

  const result = readJsonFile(configFile);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.exists, true);
  assert.match(result.error.message, /NUL/);
});

test('escrita atomica faz fsync antes do rename', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  const originalFsyncSync = fs.fsyncSync;
  const fsyncCalls = [];
  fs.fsyncSync = (fd) => {
    fsyncCalls.push(fd);
    return originalFsyncSync(fd);
  };

  try {
    atomicWriteFile(configFile, '{"ok":true}');
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.ok(fsyncCalls.length >= 1);
  assert.deepStrictEqual(readJson(configFile), { ok: true });
});

test('falha no rename preserva arquivo alvo e remove temporario', () => {
  const dir = makeTempDir();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, '{"ok":"old"}');
  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('rename failed');
  };

  try {
    assert.throws(() => atomicWriteFile(configFile, '{"ok":"new"}'), /rename failed/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepStrictEqual(readJson(configFile), { ok: 'old' });
  assert.deepStrictEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});
