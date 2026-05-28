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

function readJsonFile(file) {
  if (!fs.existsSync(file)) {
    return { ok: false, exists: false, value: null, raw: '', error: null };
  }

  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) {
      return { ok: false, exists: true, value: null, raw, error: new Error('Arquivo JSON vazio') };
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
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);

  fs.mkdirSync(dir, { recursive: true });

  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function copyFileAtomic(source, target) {
  atomicWriteFile(target, fs.readFileSync(source, 'utf8'));
}

function preserveInvalidConfig(configFile, raw, options = {}) {
  if (!raw && !fs.existsSync(configFile)) return null;

  const stamp = formatTimestamp(options.now ? options.now() : new Date());
  const target = path.join(path.dirname(configFile), `config.invalid.${stamp}.json`);
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
    copyFileAtomic(configFile, backupFile);
  }

  atomicWriteFile(configFile, json);
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
