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

function resolveDeployPhase(input = {}) {
  const checkRuns = latestCheckRuns(input.checkRuns);
  const workflowRuns = latestWorkflowRuns(input.workflowRuns);
  const statuses = latestStatuses(input.statuses);
  const combinedState = input.combinedState || null;
  const statusTotal = Number.isFinite(input.statusTotal)
    ? input.statusTotal
    : statuses.length;

  const pendingCheckRuns = checkRuns.filter(isPendingRun);
  const failedCheckRuns = checkRuns.filter(isFailedRun);

  const pendingWorkflowRuns = workflowRuns.filter(isPendingRun);
  const failedWorkflowRuns = workflowRuns.filter(isFailedRun);

  const pendingStatuses = statuses.filter(status => status.state === 'pending');
  const failedStatuses = statuses.filter(status => status.state === 'failure' || status.state === 'error');

  const combinedPending = combinedState === 'pending' && pendingStatuses.length === 0;
  const combinedFailed = (combinedState === 'failure' || combinedState === 'error') && failedStatuses.length === 0;

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

    return {
      phase: 'running',
      job,
      total,
      done: Math.max(0, total - pendingCount),
      failed: failedCount > 0,
      failedDetail: failedCount > 0 ? failedDetail : ''
    };
  }

  if (failedCount > 0) {
    return {
      phase: 'failure',
      detail: failedDetail
    };
  }

  if (combinedState !== null && combinedState !== 'success') {
    return { phase: 'waiting' };
  }

  return { phase: 'success' };
}

module.exports = { resolveDeployPhase, isTerminalDeployPhase };
