const path = require('path');

const PENDING_STATES = new Set(['dirty', 'dirty-ahead', 'ahead', 'behind', 'diverged', 'error']);
const DEPLOY_PENDING_PHASES = new Set(['waiting', 'running']);
const DEPLOY_ERROR_PHASES = new Set(['failure', 'error', 'timeout', 'no-token', 'no-ci', 'no-github']);
const DEPLOY_SUCCESS_PHASES = new Set(['success']);
const DEPLOY_STATE_PHASES = new Set([
  ...DEPLOY_PENDING_PHASES,
  ...DEPLOY_ERROR_PHASES,
  ...DEPLOY_SUCCESS_PHASES
]);

function repoKey(repoPath) {
  if (!repoPath) return '';
  return path.resolve(repoPath).toLowerCase();
}

function isPendingRepo(repo) {
  return !!(repo && PENDING_STATES.has(repo.status));
}

function needsAttentionRepo(repo) {
  return !!(repo && (isPendingRepo(repo) || repo.deployPending || repo.deployError));
}

function repoDeployEnabled(repo) {
  return !(repo && repo.deployEnabled === false);
}

function repoAttentionRank(repo) {
  if (repo && repo.deployPending) return 0;
  if (repo && repo.deployError) return 1;
  const order = {
    diverged: 2,
    behind: 3,
    ahead: 4,
    'dirty-ahead': 5,
    dirty: 6,
    error: 7,
    busy: 8,
    clean: 9
  };
  return order[(repo && repo.status) || 'clean'] ?? 99;
}

function repoVisualStatus(repo, isDeploying = false) {
  const deployEnabled = repoDeployEnabled(repo);
  if (deployEnabled && repo && repo.deployError) return 'deploy-error';
  if (deployEnabled && (isDeploying || (repo && repo.deployPending))) return 'deploying';
  return (repo && repo.status) || 'clean';
}

function sortReposByAttention(repos) {
  return [...(repos || [])]
    .map((repo, index) => ({ repo, index }))
    .sort((a, b) => {
      const rankDiff = repoAttentionRank(a.repo) - repoAttentionRank(b.repo);
      return rankDiff || a.index - b.index;
    })
    .map(entry => entry.repo);
}

function isDeployPendingEntry(entry) {
  return !!(entry && DEPLOY_PENDING_PHASES.has(entry.phase));
}

function isDeployErrorEntry(entry) {
  return !!(entry && DEPLOY_ERROR_PHASES.has(entry.phase));
}

function isDeployStateEntry(entry) {
  return !!(entry && DEPLOY_STATE_PHASES.has(entry.phase));
}

function isDeployStateStaleForRepo(repo, entry) {
  if (!repo || !entry) return false;
  if (Number(repo.behind || 0) > 0) return true;
  if (entry.sha && repo.headSha && entry.sha !== repo.headSha) return true;
  if (entry.branch && repo.branch && entry.branch !== repo.branch) return true;
  return false;
}

function defaultDeployDetail(phase) {
  switch (phase) {
    case 'waiting':
      return 'Aguardando CI iniciar';
    case 'running':
      return 'Deploy em andamento';
    case 'success':
      return 'Deploy concluido';
    case 'failure':
      return 'Deploy falhou';
    case 'timeout':
      return 'Monitoramento expirou sem conclusao no GitHub';
    case 'no-token':
      return 'Configure um token GitHub para monitorar o deploy';
    case 'no-ci':
      return 'Nenhum workflow, check-run ou commit status encontrado';
    case 'no-github':
      return 'Remote origin nao e GitHub; deploy nao monitorado';
    case 'error':
    default:
      return 'Erro ao monitorar deploy';
  }
}

function pickMeta(meta, previous, field) {
  if (Object.prototype.hasOwnProperty.call(meta || {}, field)) {
    return meta[field] || '';
  }
  return previous && previous[field] ? previous[field] : '';
}

function normalizeDeployStateEntry(entry) {
  if (!isDeployStateEntry(entry)) return null;
  const now = Date.now();
  const phase = entry.phase;
  const failedAt = isDeployErrorEntry(entry)
    ? (entry.failedAt || entry.updatedAt || now)
    : null;
  return {
    phase,
    detail: entry.detail || defaultDeployDetail(phase),
    failedAt,
    startedAt: entry.startedAt || entry.failedAt || entry.updatedAt || now,
    updatedAt: entry.updatedAt || entry.failedAt || now,
    sha: entry.sha || '',
    branch: entry.branch || '',
    remoteUrl: entry.remoteUrl || '',
    owner: entry.owner || '',
    repo: entry.repo || '',
    watchId: entry.watchId || ''
  };
}

function sanitizeDeployStates(deployStates) {
  const next = {};
  for (const [key, entry] of Object.entries(deployStates || {})) {
    const normalized = normalizeDeployStateEntry(entry);
    if (normalized) next[key] = normalized;
  }
  return next;
}

function sanitizeDeployErrors(deployErrors) {
  const next = {};
  for (const [key, entry] of Object.entries(sanitizeDeployStates(deployErrors))) {
    if (isDeployErrorEntry(entry)) next[key] = entry;
  }
  return next;
}

function applyDeployState(repo, deployStates) {
  const deployEnabled = repoDeployEnabled(repo);
  const rawEntry = deployStates && deployStates[repoKey(repo.path)];
  const entry = deployEnabled && isDeployStateEntry(rawEntry) && !isDeployStateStaleForRepo(repo, rawEntry)
    ? rawEntry
    : null;
  const next = {
    ...repo,
    deployEnabled,
    deployPending: isDeployPendingEntry(entry),
    deployError: isDeployErrorEntry(entry),
    deployPhase: deployEnabled ? (entry ? entry.phase : '') : 'none',
    deployDetail: deployEnabled ? (entry ? entry.detail : '') : 'Sem deploy',
    deployFailedAt: entry ? entry.failedAt : null
  };
  next.pending = isPendingRepo(next);
  next.needsAttention = needsAttentionRepo(next);
  return next;
}

function markDeployState(deployStates, repoPath, phase, detail, now = Date.now(), meta = {}) {
  if (!DEPLOY_STATE_PHASES.has(phase)) return sanitizeDeployStates(deployStates);
  const next = sanitizeDeployStates(deployStates);
  const key = repoKey(repoPath);
  const previous = next[key] || null;
  next[key] = {
    phase,
    detail: detail || defaultDeployDetail(phase),
    failedAt: DEPLOY_ERROR_PHASES.has(phase) ? now : null,
    startedAt: meta.startedAt || (previous && previous.startedAt) || now,
    updatedAt: now,
    sha: pickMeta(meta, previous, 'sha'),
    branch: pickMeta(meta, previous, 'branch'),
    remoteUrl: pickMeta(meta, previous, 'remoteUrl'),
    owner: pickMeta(meta, previous, 'owner'),
    repo: pickMeta(meta, previous, 'repo'),
    watchId: pickMeta(meta, previous, 'watchId')
  };
  return next;
}

function markDeployError(deployErrors, repoPath, phase, detail, now = Date.now(), meta = {}) {
  if (!DEPLOY_ERROR_PHASES.has(phase)) return sanitizeDeployErrors(deployErrors);
  return markDeployState(deployErrors, repoPath, phase, detail, now, meta);
}

function clearDeployState(deployStates, repoPath) {
  const next = sanitizeDeployStates(deployStates);
  delete next[repoKey(repoPath)];
  return next;
}

function clearDeployError(deployErrors, repoPath) {
  return clearDeployState(deployErrors, repoPath);
}

function pruneDeployStatesForRepos(deployStates, repos) {
  let next = sanitizeDeployStates(deployStates);
  for (const repo of repos || []) {
    const key = repoKey(repo.path);
    if (next[key] && (!repoDeployEnabled(repo) || isDeployStateStaleForRepo(repo, next[key]))) {
      delete next[key];
    }
  }
  return next;
}

function pruneDeployErrorsForRepos(deployErrors, repos) {
  return sanitizeDeployErrors(pruneDeployStatesForRepos(deployErrors, repos));
}

function applyDeployWatchUpdate(deployStates, repoPath, update = {}, now = Date.now()) {
  const currentStates = sanitizeDeployStates(deployStates);
  const key = repoKey(repoPath);
  const current = currentStates[key] || null;
  const watchId = update.watchId || update.expectedWatchId || '';

  if (watchId && (!current || (current.watchId && current.watchId !== watchId))) {
    return { deployStates: currentStates, applied: false, stale: true };
  }

  if (update.phase === 'success') {
    return {
      deployStates: clearDeployState(currentStates, repoPath),
      applied: true,
      stale: false
    };
  }

  const meta = {
    sha: update.sha || (current && current.sha) || '',
    branch: update.branch || (current && current.branch) || '',
    remoteUrl: update.remoteUrl || (current && current.remoteUrl) || '',
    owner: update.owner || (current && current.owner) || '',
    repo: update.repo || (current && current.repo) || '',
    watchId: watchId || (current && current.watchId) || '',
    startedAt: update.resetStartedAt
      ? (update.startedAt || now)
      : ((current && current.startedAt) || update.startedAt || now)
  };

  return {
    deployStates: markDeployState(
      currentStates,
      repoPath,
      update.phase,
      update.detail || update.failedDetail || '',
      now,
      meta
    ),
    applied: true,
    stale: false
  };
}

module.exports = {
  applyDeployWatchUpdate,
  applyDeployState,
  clearDeployError,
  clearDeployState,
  isPendingRepo,
  markDeployError,
  markDeployState,
  needsAttentionRepo,
  pruneDeployErrorsForRepos,
  pruneDeployStatesForRepos,
  repoDeployEnabled,
  repoKey,
  repoVisualStatus,
  sanitizeDeployErrors,
  sanitizeDeployStates,
  sortReposByAttention
};
