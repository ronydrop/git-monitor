const fs = require('fs');
const path = require('path');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function getNow(options = {}) {
  return options.now ? options.now() : new Date();
}

function hasNulByte(buffer) {
  return buffer.includes(0);
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) {
    return { ok: false, exists: false, value: null, raw: '', error: null };
  }

  try {
    const buffer = fs.readFileSync(file);
    const raw = buffer.toString('utf8');
    if (!raw.trim()) {
      return { ok: false, exists: true, value: null, raw, error: new Error('Arquivo JSON vazio') };
    }

    if (hasNulByte(buffer)) {
      return { ok: false, exists: true, value: null, raw, error: new Error('Arquivo JSON contem bytes NUL') };
    }

    const value = JSON.parse(raw);
    if (!isPlainObject(value)) {
      return { ok: false, exists: true, value: null, raw, error: new Error('Config JSON precisa ser um objeto') };
    }

    return { ok: true, exists: true, value, raw, error: null };
  } catch (error) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) {}
    return { ok: false, exists: true, value: null, raw, error };
  }
}

function atomicWriteFile(file, contents) {
  const dir = path.dirname(file);
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const tmp = path.join(dir, `.${path.basename(file)}.${nonce}.tmp`);
  let fd = null;

  fs.mkdirSync(dir, { recursive: true });

  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, contents, typeof contents === 'string' ? 'utf8' : undefined);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    fsyncDirectory(dir);
  } catch (error) {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function fsyncDirectory(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (_) {
    // Windows often refuses fsync on directories; the file itself was flushed.
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
  }
}

function copyFileAtomic(source, target) {
  atomicWriteFile(target, fs.readFileSync(source, 'utf8'));
}

function uniqueTimestampedFile(dir, prefix, options = {}) {
  const stamp = formatTimestamp(getNow(options));
  let target = path.join(dir, `${prefix}.${stamp}.json`);
  let index = 1;

  while (fs.existsSync(target)) {
    target = path.join(dir, `${prefix}.${stamp}.${index}.json`);
    index += 1;
  }

  return target;
}

function writeTimestampedConfig(configFile, prefix, contents, options = {}) {
  const target = uniqueTimestampedFile(path.dirname(configFile), prefix, options);
  atomicWriteFile(target, contents);
  return target;
}

function preserveInvalidConfig(configFile, raw, options = {}, prefix = 'config.invalid') {
  if (!raw && !fs.existsSync(configFile)) return null;

  const target = uniqueTimestampedFile(path.dirname(configFile), prefix, options);
  const contents = raw != null ? raw : fs.readFileSync(configFile, 'utf8');
  atomicWriteFile(target, contents);
  return target;
}

function defaultBackupFile(configFile) {
  return path.join(path.dirname(configFile), 'config.backup.json');
}

function saveConfigFile(configFile, config, options = {}) {
  const backupFile = options.backupFile || defaultBackupFile(configFile);
  const json = JSON.stringify(config, null, 2);
  if (typeof json !== 'string') {
    throw new Error('Config invalida para serializar');
  }

  const current = readJsonFile(configFile);
  if (!options.skipBackup && backupFile && current.ok) {
    writeTimestampedConfig(configFile, 'config.backup-before-save', current.raw, options);
  }

  atomicWriteFile(configFile, json);

  if (!options.skipBackup && backupFile) {
    copyFileAtomic(configFile, backupFile);
    writeTimestampedConfig(configFile, 'config.backup-after-save', json, options);
  }
}

function isHistoricalBackupName(name, backupFile) {
  if (name === path.basename(backupFile)) return false;
  if (!name.startsWith('config.')) return false;
  if (!name.endsWith('.json')) return false;
  if (name.startsWith('config.invalid.')) return false;
  if (name.startsWith('config.invalid-backup.')) return false;

  return (
    name.startsWith('config.backup-') ||
    name.startsWith('config.backup.') ||
    name.startsWith('config.before-') ||
    name.startsWith('config.current-')
  );
}

function findHistoricalBackup(configFile, backupFile) {
  const dir = path.dirname(configFile);
  if (!fs.existsSync(dir)) return null;

  const candidates = fs.readdirSync(dir)
    .filter(name => isHistoricalBackupName(name, backupFile))
    .map(name => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      const parsed = readJsonFile(file);
      return { file, stat, parsed };
    })
    .filter(candidate => candidate.parsed.ok)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  return candidates[0] || null;
}

function loadConfigFile(configFile, defaultFactory, options = {}) {
  const backupFile = options.backupFile || defaultBackupFile(configFile);
  const logger = options.logger || null;
  const primary = readJsonFile(configFile);

  if (primary.ok) {
    try {
      copyFileAtomic(configFile, backupFile);
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[config] falha ao atualizar backup:', error.message);
      }
    }

    return { config: primary.value, source: 'primary', recovered: false };
  }

  const backup = readJsonFile(backupFile);
  if (backup.ok) {
    if (primary.exists) preserveInvalidConfig(configFile, primary.raw, options);
    atomicWriteFile(configFile, backup.raw);

    if (logger && typeof logger.warn === 'function') {
      logger.warn('[config] config principal invalido; backup restaurado.');
    }

    return { config: backup.value, source: 'backup', recovered: true };
  }

  const historicalBackup = findHistoricalBackup(configFile, backupFile);
  if (historicalBackup) {
    if (primary.exists) preserveInvalidConfig(configFile, primary.raw, options);
    if (backup.exists) preserveInvalidConfig(backupFile, backup.raw, options, 'config.invalid-backup');
    atomicWriteFile(configFile, historicalBackup.parsed.raw);
    atomicWriteFile(backupFile, historicalBackup.parsed.raw);

    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[config] config principal invalido; backup historico restaurado: ${path.basename(historicalBackup.file)}.`);
    }

    return {
      config: historicalBackup.parsed.value,
      source: 'backup-history',
      recovered: true,
      recoveredFrom: historicalBackup.file
    };
  }

  if (primary.exists) preserveInvalidConfig(configFile, primary.raw, options);

  const config = defaultFactory();
  saveConfigFile(configFile, config, { backupFile, skipBackup: true });

  if (primary.exists && logger && typeof logger.warn === 'function') {
    logger.warn('[config] config principal invalido e sem backup; defaults recriados.');
  }

  return { config, source: 'default', recovered: false };
}

module.exports = {
  atomicWriteFile,
  formatTimestamp,
  loadConfigFile,
  readJsonFile,
  saveConfigFile
};
