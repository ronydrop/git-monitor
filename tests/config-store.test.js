const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  atomicWriteFile,
  createDebouncedSave,
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

test('salva atomicamente com um histórico anterior e backup fixo atual', () => {
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
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.backup-after-save.20260102-030405.json')), false);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('configuração equivalente não regrava arquivos nem gera históricos', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'config.json');
  const raw = '{"repos":[],"theme":"obsidian"}';
  fs.writeFileSync(file, raw);
  const originalOpen = fs.openSync;
  fs.openSync = (target, flags, ...args) => {
    assert.ok(!String(flags).includes('w'), 'não deve abrir arquivos para escrita');
    return originalOpen(target, flags, ...args);
  };
  try {
    saveConfigFile(file, { theme: 'obsidian', repos: [] });
    saveConfigFile(file, { repos: [], theme: 'obsidian' });
  } finally {
    fs.openSync = originalOpen;
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json']);
});

test('retém os 20 históricos válidos mais recentes, inclusive colisões no mesmo segundo', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'config.json');
  for (let version = 0; version <= 35; version += 1) {
    saveConfigFile(file, { repos: [], version }, { now: fixedNow });
  }
  const histories = fs.readdirSync(dir).filter(name => name.startsWith('config.backup-before-save.'));
  assert.strictEqual(histories.length, 20);
  assert.deepStrictEqual(histories.map(name => readJson(path.join(dir, name)).version).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i + 15));
  assert.strictEqual(readJson(path.join(dir, 'config.backup.json')).version, 35);
  fs.writeFileSync(file, '{');
  fs.writeFileSync(path.join(dir, 'config.backup.json'), '{');
  const restored = loadConfigFile(file, () => ({ repos: [] }));
  assert.strictEqual(restored.source, 'backup-history');
  assert.strictEqual(restored.config.version, 34);
});

test('rotação na abertura inclui os históricos existentes e preserva cópias especiais', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ repos: [], version: 50 }));
  for (let i = 0; i < 25; i += 1) {
    fs.writeFileSync(path.join(dir, `config.backup-after-save.20260102-030405.${i}.json`), JSON.stringify({ version: i }));
  }
  fs.writeFileSync(path.join(dir, 'config.backup-after-save.20260103-030405.json'), '{');
  fs.writeFileSync(path.join(dir, 'config.before-manual.json'), '{"original":true}');
  fs.writeFileSync(path.join(dir, 'config.invalid.20260101-000000.json'), '{');
  loadConfigFile(file, () => ({ repos: [] }));
  const valid = fs.readdirSync(dir).filter(name => name.startsWith('config.backup-after-save.') && readJsonFile(path.join(dir, name)).ok);
  assert.strictEqual(valid.length, 20);
  assert.strictEqual(Math.min(...valid.map(name => readJson(path.join(dir, name)).version)), 5);
  assert.deepStrictEqual(readJson(path.join(dir, 'config.before-manual.json')), { original: true });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.invalid.20260101-000000.json'), 'utf8'), '{');
});

test('falha de gravação não remove os históricos de recuperação', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"version":0}');
  for (let i = 0; i < 25; i += 1) {
    fs.writeFileSync(path.join(dir, `config.backup-after-save.20260101-000000.${i}.json`), '{"version":0}');
  }
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file) throw new Error('falha simulada');
    return originalRename(from, to);
  };
  try {
    assert.throws(() => saveConfigFile(file, { version: 1 }), /falha simulada/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(readJson(file).version, 0);
  assert.strictEqual(fs.readdirSync(dir).filter(name => name.startsWith('config.backup-after-save.')).length, 25);
});

test('salvamento agrupado usa a posição final e descarrega a pendência ao fechar', () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  let id = 0;
  global.setTimeout = (fn, delay) => { assert.strictEqual(delay, 500); timers.set(++id, fn); return id; };
  global.clearTimeout = timer => timers.delete(timer);
  let position = 0;
  const saved = [];
  try {
    const writer = createDebouncedSave(() => saved.push(position));
    for (position = 1; position <= 10; position += 1) writer.schedule();
    position = 10;
    assert.deepStrictEqual(saved, []);
    assert.strictEqual(timers.size, 1);
    [...timers.values()][0]();
    assert.deepStrictEqual(saved, [10]);
    assert.strictEqual(timers.size, 0);
    position = 20;
    writer.schedule();
    writer.flush();
    writer.flush();
    assert.deepStrictEqual(saved, [10, 20]);
    assert.strictEqual(timers.size, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
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
