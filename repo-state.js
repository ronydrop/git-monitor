const path = require('path');

const PENDING_STATES = new Set(['dirty', 'dirty-ahead', 'ahead', 'behind', 'diverged', 'error']);
const DEPLOY_ERROR_PHASES = new Set(['failure', 'timeout', 'error']);

function repoKey(repoPath) {
  if (!repoPath) return '';
  return path.resolve(repoPath).toLowerCase();
}

function isPendingRepo(repo) {
  return !!(repo && (PENDING_STATES.has(repo.status) || repo.deployError));
}

function applyDeployState(repo, deployErrors) {
  const entry = deployErrors && deployErrors[repoKey(repo.path)];
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
    detail: detail || (phase === 'timeout' ? 'Timeout aguardando deploy' : 'Deploy falhou'),
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
  repoKey
};
