const path = require('path');

const PENDING_STATES = new Set(['dirty', 'dirty-ahead', 'ahead', 'behind', 'diverged', 'error']);
const DEPLOY_ERROR_PHASES = new Set(['failure', 'error']);

function repoKey(repoPath) {
  if (!repoPath) return '';
  return path.resolve(repoPath).toLowerCase();
}

function isPendingRepo(repo) {
  return !!(repo && PENDING_STATES.has(repo.status));
}

function needsAttentionRepo(repo) {
  return !!(repo && (isPendingRepo(repo) || repo.deployError));
}

function isDeployErrorEntry(entry) {
  return !!(entry && DEPLOY_ERROR_PHASES.has(entry.phase));
}

function isDeployErrorStaleForRepo(repo, entry) {
  if (!repo || !entry) return false;
  if (Number(repo.behind || 0) > 0) return true;
  if (entry.sha && repo.headSha && entry.sha !== repo.headSha) return true;
  return false;
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
  const entry = isDeployErrorEntry(rawEntry) && !isDeployErrorStaleForRepo(repo, rawEntry)
    ? rawEntry
    : null;
  const next = {
    ...repo,
    deployError: !!entry,
    deployPhase: entry ? entry.phase : '',
    deployDetail: entry ? entry.detail : '',
    deployFailedAt: entry ? entry.failedAt : null
  };
  next.pending = isPendingRepo(next);
  next.needsAttention = needsAttentionRepo(next);
  return next;
}

function markDeployError(deployErrors, repoPath, phase, detail, now = Date.now(), meta = {}) {
  if (!DEPLOY_ERROR_PHASES.has(phase)) return { ...(deployErrors || {}) };
  const next = { ...(deployErrors || {}) };
  next[repoKey(repoPath)] = {
    phase,
    detail: detail || 'Deploy falhou',
    failedAt: now,
    sha: meta.sha || '',
    branch: meta.branch || ''
  };
  return next;
}

function clearDeployError(deployErrors, repoPath) {
  const next = { ...(deployErrors || {}) };
  delete next[repoKey(repoPath)];
  return next;
}

function pruneDeployErrorsForRepos(deployErrors, repos) {
  let next = sanitizeDeployErrors(deployErrors);
  for (const repo of repos || []) {
    const key = repoKey(repo.path);
    if (next[key] && isDeployErrorStaleForRepo(repo, next[key])) {
      delete next[key];
    }
  }
  return next;
}

module.exports = {
  applyDeployState,
  clearDeployError,
  isPendingRepo,
  markDeployError,
  needsAttentionRepo,
  pruneDeployErrorsForRepos,
  repoKey,
  sanitizeDeployErrors
};
