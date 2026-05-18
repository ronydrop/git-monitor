const assert = require('assert');
const { resolveDeployPhase, isTerminalDeployPhase } = require('../deploy-status');
const { applyDeployState, markDeployError, clearDeployError } = require('../repo-state');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

test('mantem pendente quando um workflow falhou e outro ainda esta rodando', () => {
  const result = resolveDeployPhase({
    checkRuns: [],
    workflowRuns: [
      { name: 'Deploy Production (OCI API)', status: 'completed', conclusion: 'failure' },
      { name: 'Gateway Portal Vercel Guard', status: 'in_progress', conclusion: null }
    ],
    statuses: [],
    combinedState: 'success',
    statusTotal: 0
  });

  assert.strictEqual(result.phase, 'running');
  assert.strictEqual(result.failed, true);
  assert.match(result.failedDetail, /Deploy Production/);
  assert.match(result.job, /falhou/);
  assert.match(result.job, /Gateway Portal Vercel Guard/);
});

test('marca falha quando workflow terminou com erro', () => {
  const result = resolveDeployPhase({
    checkRuns: [],
    workflowRuns: [
      { name: 'Deploy Production (OCI API)', status: 'completed', conclusion: 'failure' }
    ],
    statuses: [],
    combinedState: 'success',
    statusTotal: 0
  });

  assert.strictEqual(result.phase, 'failure');
  assert.match(result.detail, /Deploy Production/);
});

test('nao transforma workflow pendente em sucesso por causa de commit status success', () => {
  const result = resolveDeployPhase({
    checkRuns: [],
    workflowRuns: [
      { name: 'Gateway Portal Vercel Guard', status: 'queued', conclusion: null }
    ],
    statuses: [
      { context: 'vercel', state: 'success' }
    ],
    combinedState: 'success',
    statusTotal: 1
  });

  assert.strictEqual(result.phase, 'running');
});

test('retorna sucesso somente quando todos os sinais conhecidos passaram', () => {
  const result = resolveDeployPhase({
    checkRuns: [
      { name: 'build', status: 'completed', conclusion: 'success' }
    ],
    workflowRuns: [
      { name: 'Deploy Production (OCI API)', status: 'completed', conclusion: 'success' }
    ],
    statuses: [
      { context: 'vercel', state: 'success' }
    ],
    combinedState: 'success',
    statusTotal: 1
  });

  assert.strictEqual(result.phase, 'success');
});

test('fase running com progresso numerico nao e terminal', () => {
  assert.strictEqual(isTerminalDeployPhase('running'), false);
  assert.strictEqual(isTerminalDeployPhase('waiting'), false);
  assert.strictEqual(isTerminalDeployPhase('success'), true);
  assert.strictEqual(isTerminalDeployPhase('failure'), true);
});

test('mantem erro de deploy separado do status git pendente', () => {
  const deployErrors = markDeployError({}, 'C:/repo/app', 'failure', 'CI Quality Gate');
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'dirty',
    detail: '2 arquivo(s) modificado(s)'
  }, deployErrors);

  assert.strictEqual(repo.status, 'dirty');
  assert.strictEqual(repo.pending, true);
  assert.strictEqual(repo.deployError, true);
  assert.strictEqual(repo.deployPhase, 'failure');
  assert.strictEqual(repo.deployDetail, 'CI Quality Gate');
});

test('repo limpo com erro de deploy continua pendente ate novo commit push', () => {
  const deployErrors = markDeployError({}, 'C:/repo/app', 'timeout', 'Timeout aguardando deploy');
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado'
  }, deployErrors);

  assert.strictEqual(repo.status, 'clean');
  assert.strictEqual(repo.pending, true);
  assert.strictEqual(repo.deployError, true);
});

test('novo commit push limpa erro de deploy armazenado', () => {
  const deployErrors = markDeployError({}, 'C:/repo/app', 'failure', 'CI Quality Gate');
  const cleared = clearDeployError(deployErrors, 'C:/repo/app');
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'dirty',
    detail: '1 arquivo(s) modificado(s)'
  }, cleared);

  assert.strictEqual(repo.pending, true);
  assert.strictEqual(repo.deployError, false);
  assert.strictEqual(repo.deployDetail, '');
});
