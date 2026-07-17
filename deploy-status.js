const FAILED_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'stale',
  'startup_failure',
  'timed_out'
]);

const TERMINAL_PHASES = new Set([
  'none',
  'no-ci',
  'success',
  'failure',
  'timeout',
  'error',
  'no-token',
  'no-github'
]);
const DEPLOY_WATCH_MAX_AGE_MS = 45 * 60 * 1000;
const DEPLOY_WATCH_TIMEOUT_DETAIL = 'Monitoramento expirou após 45 minutos sem conclusão no GitHub';

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function latestStatuses(statuses) {
  const seen = new Set();
  return asList(statuses).filter(status => {
    const key = status.context || status.description || status.target_url || '';
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runTime(run) {
  return Date.parse(run.updated_at || run.run_started_at || run.created_at || '') || 0;
}

function runStartedAt(run) {
  if (!run) return 0;
  return Date.parse(
    run.run_started_at || run.started_at || run.created_at || run.updated_at || ''
  ) || 0;
}

function runNumber(run) {
  return Number(run.run_number || run.check_suite?.id || run.id || 0) || 0;
}

function runAttempt(run) {
  return Number(run.run_attempt || 0) || 0;
}

function isNewerRun(candidate, current) {
  const candidateTime = runTime(candidate);
  const currentTime = runTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;

  const candidateNumber = runNumber(candidate);
  const currentNumber = runNumber(current);
  if (candidateNumber !== currentNumber) return candidateNumber > currentNumber;

  const candidateAttempt = runAttempt(candidate);
  const currentAttempt = runAttempt(current);
  if (candidateAttempt !== currentAttempt) return candidateAttempt > currentAttempt;

  return Number(candidate.id || 0) > Number(current.id || 0);
}

function latestByKey(items, keyFn) {
  const latest = new Map();
  for (const item of asList(items)) {
    const key = keyFn(item);
    if (!key) {
      latest.set(Symbol('item'), item);
      continue;
    }
    const current = latest.get(key);
    if (!current || isNewerRun(item, current)) latest.set(key, item);
  }
  return [...latest.values()];
}

function latestWorkflowRuns(workflowRuns) {
  return latestByKey(workflowRuns, run =>
    run.workflow_id || run.workflow_name || run.path || run.name || ''
  );
}

function latestCheckRuns(checkRuns) {
  return latestByKey(checkRuns, run => run.name || run.external_id || '');
}

function isPendingRun(run) {
  return !!run && !!run.status && run.status !== 'completed';
}

function isFailedRun(run) {
  return !!run && FAILED_CONCLUSIONS.has(String(run.conclusion || '').toLowerCase());
}

function checkRunName(run) {
  return run.name || 'check';
}

function workflowRunName(run) {
  return run.name || run.display_title || run.workflow_name || run.path || 'workflow';
}

function statusName(status) {
  return status.context || status.description || 'commit status';
}

function failureCountText(count) {
  return count === 1 ? '1 falhou' : `${count} falharam`;
}

function isTerminalDeployPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

function deployPhaseDetail(result = {}) {
  if (result.phase === 'running') {
    return result.job || result.detail || result.failedDetail || '';
  }
  if (result.phase === 'failure') {
    return result.failedDetail || result.detail || result.job || '';
  }
  return result.detail || result.job || result.failedDetail || '';
}

function applyDeployWatchDeadline(
  result = {},
  deployState = {},
  now = Date.now(),
  maxAgeMs = DEPLOY_WATCH_MAX_AGE_MS
) {
  if (result.phase !== 'waiting' && result.phase !== 'running') return result;

  const activeRunStartedAt = Number(result.activeRunStartedAt) || 0;
  const stateUpdatedAt = Number(
    deployState.updatedAt || deployState.failedAt || deployState.startedAt
  ) || 0;
  const hasNewActiveRun = activeRunStartedAt > stateUpdatedAt;
  const startedAt = hasNewActiveRun
    ? activeRunStartedAt
    : (Number(deployState.startedAt) || 0);

  if (deployState.phase === 'timeout' && !hasNewActiveRun) {
    return {
      ...result,
      phase: 'timeout',
      detail: deployState.detail || DEPLOY_WATCH_TIMEOUT_DETAIL,
      job: '',
      failed: false,
      failedDetail: ''
    };
  }

  if (startedAt && now - startedAt >= maxAgeMs) {
    return {
      ...result,
      phase: 'timeout',
      detail: DEPLOY_WATCH_TIMEOUT_DETAIL,
      job: '',
      failed: false,
      failedDetail: ''
    };
  }

  if (!hasNewActiveRun) return result;
  return {
    ...result,
    resetStartedAt: true,
    startedAt: activeRunStartedAt
  };
}

function findGithubApiProblem(responses = []) {
  return asList(responses).find(res => res && res.error) ||
    asList(responses).find(res => res && res.statusCode === 0) ||
    asList(responses).find(res =>
      res && res.statusCode && res.statusCode !== 200 && res.statusCode !== 404
    ) ||
    null;
}

function isTransientGithubApiResponse(response) {
  if (!response) return false;
  const code = Number(response.statusCode) || 0;

  if (code === 0) return !!response.error;
  if (code === 408 || code === 429 || code >= 500) return true;
  return code >= 200 && code < 300 && !!response.error;
}

function isTransientGithubApiProblem(responses = []) {
  const problems = asList(responses).filter(response => {
    if (!response) return false;
    return !!response.error || Number(response.statusCode) !== 200;
  });

  return problems.length > 0 && problems.every(isTransientGithubApiResponse);
}

function githubApiRetryDetail(responses = []) {
  const transient = asList(responses).find(isTransientGithubApiResponse) || {};
  const code = Number(transient.statusCode) || 0;
  const httpDetail = code ? ` (HTTP ${code})` : '';
  return `API do GitHub temporariamente indisponível${httpDetail}; nova tentativa automática`;
}

function githubApiFailureDetail(workflowRes = {}, checkRes = {}, statusRes = {}, gh = {}) {
  const responses = [workflowRes, checkRes, statusRes].filter(Boolean);
  const failed = responses.find(res => res.error) ||
    responses.find(res => res.statusCode && res.statusCode !== 200) ||
    responses.find(res => res.statusCode === 0) ||
    responses[0] || {};
  const code = failed.statusCode || 0;
  const apiMessage = failed.error || (failed.data && failed.data.message) || '';
  const repoLabel = gh.owner && gh.repo ? `${gh.owner}/${gh.repo}` : 'repositorio';

  if (/Resposta invalida da API GitHub/i.test(apiMessage)) return apiMessage;
  if (code === 0) return `Erro de rede ao acessar GitHub: ${apiMessage || 'sem resposta da API'}`;
  if (code === 401) return 'Token GitHub invalido ou expirado; atualize nas configuracoes';
  if (code === 403 && /rate limit/i.test(apiMessage)) return `GitHub API rate limit atingido para ${repoLabel}`;
  if (code === 403) return `Token sem permissao para consultar Actions/status de ${repoLabel}`;
  if (code === 404) return `Token sem acesso a ${repoLabel}; configure token especifico do repo`;
  return `Erro ao acessar GitHub (HTTP ${code})${apiMessage ? ': ' + apiMessage : ''}`;
}

function resolveDeployPhase(input = {}) {
  const checkRuns = latestCheckRuns(input.checkRuns);
  const workflowRuns = latestWorkflowRuns(input.workflowRuns);
  const statuses = latestStatuses(input.statuses);
  const combinedState = input.combinedState || null;
  const statusTotal = Number.isFinite(input.statusTotal)
    ? input.statusTotal
    : statuses.length;
  const hasCommitStatusSignal = statusTotal > 0 || statuses.length > 0;

  const pendingCheckRuns = checkRuns.filter(isPendingRun);
  const failedCheckRuns = checkRuns.filter(isFailedRun);

  const pendingWorkflowRuns = workflowRuns.filter(isPendingRun);
  const failedWorkflowRuns = workflowRuns.filter(isFailedRun);

  const pendingStatuses = statuses.filter(status => status.state === 'pending');
  const failedStatuses = statuses.filter(status => status.state === 'failure' || status.state === 'error');

  const combinedPending = hasCommitStatusSignal && combinedState === 'pending' && pendingStatuses.length === 0;
  const combinedFailed = hasCommitStatusSignal && (combinedState === 'failure' || combinedState === 'error') && failedStatuses.length === 0;

  const pendingCount =
    pendingCheckRuns.length +
    pendingWorkflowRuns.length +
    pendingStatuses.length +
    (combinedPending ? 1 : 0);

  const failedCount =
    failedCheckRuns.length +
    failedWorkflowRuns.length +
    failedStatuses.length +
    (combinedFailed ? 1 : 0);

  const statusSignalCount = Math.max(
    statusTotal,
    statuses.length,
    combinedPending || combinedFailed ? 1 : 0
  );
  const total = checkRuns.length + workflowRuns.length + statusSignalCount;
  const failedNames = [
    ...failedWorkflowRuns.map(workflowRunName),
    ...failedCheckRuns.map(checkRunName),
    ...failedStatuses.map(statusName)
  ];
  if (combinedFailed) failedNames.push('commit status');
  const failedDetail = failedNames.length > 0 ? failedNames.join(', ') : 'deploy falhou';
  const pendingRunCount = pendingCheckRuns.length + pendingWorkflowRuns.length;
  const failedRunCount = failedCheckRuns.length + failedWorkflowRuns.length;

  if (failedRunCount > 0 && pendingRunCount === 0) {
    return {
      phase: 'failure',
      detail: failedDetail,
      failedDetail
    };
  }

  if (pendingCount > 0) {
    const activeWorkflow =
      pendingWorkflowRuns.find(run => run.status === 'in_progress') ||
      pendingWorkflowRuns[0];
    const activeCheck =
      pendingCheckRuns.find(run => run.status === 'in_progress') ||
      pendingCheckRuns[0];
    const activeStatus = pendingStatuses[0];

    let job = activeWorkflow
      ? workflowRunName(activeWorkflow)
      : activeCheck
        ? checkRunName(activeCheck)
        : activeStatus
          ? statusName(activeStatus)
          : 'Deploy em andamento';

    if (failedCount > 0) {
      job = `${failureCountText(failedCount)}, ${job}`;
    }

    const activeRunStartedAt = Math.max(
      runStartedAt(activeWorkflow),
      runStartedAt(activeCheck)
    );

    return {
      phase: 'running',
      job,
      total,
      done: Math.max(0, total - pendingCount),
      failed: failedCount > 0,
      failedDetail: failedCount > 0 ? failedDetail : '',
      activeRunStartedAt
    };
  }

  if (failedCount > 0) {
    return {
      phase: 'failure',
      detail: failedDetail
    };
  }

  if (hasCommitStatusSignal && combinedState !== null && combinedState !== 'success') {
    return { phase: 'waiting' };
  }

  return { phase: 'success' };
}

module.exports = {
  applyDeployWatchDeadline,
  DEPLOY_WATCH_MAX_AGE_MS,
  deployPhaseDetail,
  findGithubApiProblem,
  githubApiFailureDetail,
  githubApiRetryDetail,
  isTransientGithubApiProblem,
  resolveDeployPhase,
  isTerminalDeployPhase
};
