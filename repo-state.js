const path = require('path');

const PENDING_STATES = new Set(['dirty', 'dirty-ahead', 'ahead', 'behind', 'diverged', 'error']);
const DEPLOY_ERROR_PHASES = new Set(['failure', 'error']);

function repoKey(repoPath) {
  if (!repoPath) return '';
  return path.resolve(repoPath).toLowerCase();
}

function isPendingRepo(repo) {
  return !!(repo && (PENDING_STATES.has(repo.status) || repo.deployError));
}

function isDeployErrorEntry(entry) {
  return !!(entry && DEPLOY_ERROR_PHASES.has(entry.phase));
}

function sanitizeDeployErrors(deployErrors) {
  const next = {};
  for (const [key, entry] of Object.entries(deployErrors || {})) {
    if (isDeployErrorEntry(entry)) next[key] = entry;
  }
  return next;
}

function applyDeployState(repo, deployErrors) {
  const rawEntry = deployErrors && deployErrors[repoKey(repo.path)];
  const entry = isDeployErrorEntry(rawEntry) ? rawEntry : null;
  const next = {
    ...repo,
    deployError: !!entry,
    deployPhase: entry ? entry.phase : '',
    deployDetail: entry ? entry.detail : '',
    deployFailedAt: entry ? entry.failedAt : null
  };
  next.pending = isPendingRepo(next);
  return next;
}

function markDeployError(deployErrors, repoPath, phase, detail, now = Date.now()) {
  if (!DEPLOY_ERROR_PHASES.has(phase)) return { ...(deployErrors || {}) };
  const next = { ...(deployErrors || {}) };
  next[repoKey(repoPath)] = {
    phase,
    detail: detail || 'Deploy falhou',
    failedAt: now
  };
  return next;
}

function clearDeployError(deployErrors, repoPath) {
  const next = { ...(deployErrors || {}) };
  delete next[repoKey(repoPath)];
  return next;
}

module.exports = {
  applyDeployState,
  clearDeployError,
  isPendingRepo,
  markDeployError,
  repoKey,
  sanitizeDeployErrors
};
