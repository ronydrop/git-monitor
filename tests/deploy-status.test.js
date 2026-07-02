const assert = require('assert');
const {
  findGithubApiProblem,
  githubApiFailureDetail,
  resolveDeployPhase,
  isTerminalDeployPhase
} = require('../deploy-status');
const {
  applyDeployState,
  applyDeployWatchUpdate,
  clearDeployState,
  markDeployError,
  markDeployState,
  pruneDeployErrorsForRepos,
  pruneDeployStatesForRepos,
  repoKey,
  repoVisualStatus,
  sortReposByAttention
} = require('../repo-state');

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

test('ignora combined status pending quando nao existem commit statuses', () => {
  const result = resolveDeployPhase({
    checkRuns: [
      { name: 'Test, build and deploy', status: 'completed', conclusion: 'success' }
    ],
    workflowRuns: [
      { name: 'Deploy', status: 'completed', conclusion: 'success' }
    ],
    statuses: [],
    combinedState: 'pending',
    statusTotal: 0
  });

  assert.strictEqual(result.phase, 'success');
});

test('ignora falha antiga quando rerun mais recente do workflow passou', () => {
  const result = resolveDeployPhase({
    checkRuns: [],
    workflowRuns: [
      {
        id: 200,
        name: 'CI Quality Gate',
        workflow_id: 10,
        run_number: 922,
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-05-18T13:00:00Z'
      },
      {
        id: 199,
        name: 'CI Quality Gate',
        workflow_id: 10,
        run_number: 921,
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-05-18T12:50:00Z'
      }
    ],
    statuses: [],
    combinedState: 'success',
    statusTotal: 0
  });

  assert.strictEqual(result.phase, 'success');
});

test('fase running com progresso numerico nao e terminal', () => {
  assert.strictEqual(isTerminalDeployPhase('running'), false);
  assert.strictEqual(isTerminalDeployPhase('waiting'), false);
  assert.strictEqual(isTerminalDeployPhase('success'), true);
  assert.strictEqual(isTerminalDeployPhase('failure'), true);
});

test('erro de parse da GitHub API com HTTP 200 nao vira ausencia de CI', () => {
  const apiProblem = findGithubApiProblem([
    { statusCode: 200, data: {}, error: 'Resposta invalida da API GitHub: Unexpected token' },
    { statusCode: 404, data: {}, error: '' },
    { statusCode: 404, data: {}, error: '' }
  ]);

  assert.ok(apiProblem);
  assert.strictEqual(apiProblem.statusCode, 200);
  assert.match(apiProblem.error, /Resposta invalida/);
  assert.match(
    githubApiFailureDetail(apiProblem, {}, {}, { owner: 'ronydrop', repo: 'git-monitor' }),
    /Resposta invalida/
  );
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
  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, true);
  assert.strictEqual(repo.deployPhase, 'failure');
  assert.strictEqual(repo.deployDetail, 'CI Quality Gate');
});

test('repo limpo com erro real de deploy nao vira pendencia git', () => {
  const deployErrors = markDeployError({}, 'C:/repo/app', 'failure', 'Deploy Production');
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado'
  }, deployErrors);

  assert.strictEqual(repo.status, 'clean');
  assert.strictEqual(repo.pending, false);
  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, true);
});

test('push bem-sucedido entra em deploy pendente e nao vira sucesso final automaticamente', () => {
  const deployStates = markDeployState({}, 'C:/repo/app', 'waiting', 'Aguardando CI iniciar', Date.now(), {
    sha: 'abc123',
    branch: 'main',
    watchId: 'watch-1'
  });
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'abc123',
    branch: 'main'
  }, deployStates);

  assert.strictEqual(repo.status, 'clean');
  assert.strictEqual(repo.pending, false);
  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, false);
  assert.strictEqual(repo.deployPending, true);
  assert.strictEqual(repo.deployPhase, 'waiting');
  assert.strictEqual(repo.deployDetail, 'Aguardando CI iniciar');
});

test('status visual de deploy pendente domina git limpo', () => {
  assert.strictEqual(repoVisualStatus({ status: 'clean', deployPending: true }), 'deploying');
  assert.strictEqual(repoVisualStatus({ status: 'clean' }, true), 'deploying');
  assert.strictEqual(repoVisualStatus({ status: 'clean', deployPending: false }), 'clean');
  assert.strictEqual(repoVisualStatus({ status: 'clean', deployError: true }), 'deploy-error');
});

test('timeout do watcher aparece como erro claro de deploy', () => {
  const deployStates = markDeployState({}, 'C:/repo/app', 'timeout', 'Monitoramento expirou sem conclusao no GitHub', Date.now(), {
    sha: 'abc123',
    branch: 'main',
    watchId: 'watch-1'
  });
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'abc123',
    branch: 'main'
  }, deployStates);

  assert.strictEqual(repo.pending, false);
  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, true);
  assert.strictEqual(repo.deployPhase, 'timeout');
  assert.match(repo.deployDetail, /expirou/);
});

test('repo sem CI detectavel aparece como erro de deploy verificavel', () => {
  const deployStates = markDeployState({}, 'C:/repo/app', 'no-ci', 'Nenhum workflow, check-run ou commit status encontrado', Date.now(), {
    sha: 'abc123',
    branch: 'main',
    watchId: 'watch-1'
  });
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'abc123',
    branch: 'main'
  }, deployStates);

  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, true);
  assert.strictEqual(repo.deployPhase, 'no-ci');
});

test('repo sem deploy configurado ignora estado antigo de deploy ausente', () => {
  const deployStates = markDeployState({}, 'C:/repo/brain', 'no-ci', 'Nenhum workflow, check-run ou commit status encontrado', Date.now(), {
    sha: 'abc123',
    branch: 'main',
    watchId: 'watch-1'
  });
  const repo = applyDeployState({
    name: 'Brain',
    path: 'C:/repo/brain',
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'abc123',
    branch: 'main',
    deployEnabled: false
  }, deployStates);

  assert.strictEqual(repo.pending, false);
  assert.strictEqual(repo.needsAttention, false);
  assert.strictEqual(repo.deployEnabled, false);
  assert.strictEqual(repo.deployPending, false);
  assert.strictEqual(repo.deployError, false);
  assert.strictEqual(repo.deployPhase, 'none');
  assert.strictEqual(repo.deployDetail, 'Sem deploy');
  assert.strictEqual(repoVisualStatus(repo), 'clean');
});

test('repo sem deploy configurado remove estado de deploy persistido no prune', () => {
  const deployStates = markDeployState({}, 'C:/repo/brain', 'no-ci', 'Nenhum workflow, check-run ou commit status encontrado', Date.now(), {
    sha: 'abc123',
    branch: 'main',
    watchId: 'watch-1'
  });
  const pruned = pruneDeployStatesForRepos(deployStates, [
    { name: 'Brain', path: 'C:/repo/brain', deployEnabled: false }
  ]);

  assert.deepStrictEqual(pruned, {});
});

test('repo sem deploy configurado remove erro legado persistido no prune', () => {
  const deployErrors = markDeployError({}, 'C:/repo/brain', 'no-ci', 'Nenhum workflow, check-run ou commit status encontrado', Date.now(), {
    sha: 'abc123',
    branch: 'main',
    watchId: 'watch-1'
  });
  const pruned = pruneDeployErrorsForRepos(deployErrors, [
    { name: 'Brain', path: 'C:/repo/brain', deployEnabled: false }
  ]);

  assert.deepStrictEqual(pruned, {});
});

test('timeout legado salvo no config agora permanece visivel', () => {
  const repoPath = 'C:/repo/app';
  const deployStates = {
    [repoKey(repoPath)]: {
      phase: 'timeout',
      detail: 'Timeout aguardando deploy',
      failedAt: Date.now(),
      sha: 'abc123'
    }
  };
  const repo = applyDeployState({
    name: 'App',
    path: repoPath,
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'abc123'
  }, deployStates);

  assert.strictEqual(repo.pending, false);
  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, true);
});

test('novo commit push limpa erro de deploy armazenado', () => {
  const deployErrors = markDeployError({}, 'C:/repo/app', 'failure', 'CI Quality Gate');
  const cleared = clearDeployState(deployErrors, 'C:/repo/app');
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'dirty',
    detail: '1 arquivo(s) modificado(s)'
  }, cleared);

  assert.strictEqual(repo.pending, true);
  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, false);
  assert.strictEqual(repo.deployDetail, '');
});

test('polling antigo nao sobrescreve estado de push mais novo', () => {
  const deployStates = markDeployState({}, 'C:/repo/app', 'waiting', 'Aguardando deploy novo', Date.now(), {
    sha: 'new-sha',
    branch: 'main',
    watchId: 'new-watch'
  });
  const result = applyDeployWatchUpdate(deployStates, 'C:/repo/app', {
    phase: 'failure',
    detail: 'Deploy antigo falhou',
    sha: 'old-sha',
    branch: 'main',
    watchId: 'old-watch'
  }, Date.now());

  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'new-sha',
    branch: 'main'
  }, result.deployStates);

  assert.strictEqual(result.applied, false);
  assert.strictEqual(repo.deployPending, true);
  assert.strictEqual(repo.deployPhase, 'waiting');
  assert.strictEqual(repo.deployDetail, 'Aguardando deploy novo');
});

test('erro de deploy salvo nao aparece quando repo local mudou de commit', () => {
  const deployErrors = markDeployError(
    {},
    'C:/repo/app',
    'failure',
    'CI Quality Gate',
    Date.now(),
    { sha: 'old-sha' }
  );
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'new-sha'
  }, deployErrors);

  assert.strictEqual(repo.pending, false);
  assert.strictEqual(repo.needsAttention, false);
  assert.strictEqual(repo.deployError, false);
  assert.strictEqual(repo.deployDetail, '');
});

test('erro de deploy salvo nao domina status quando remoto avancou', () => {
  const deployErrors = markDeployError({}, 'C:/repo/app', 'failure', 'CI Quality Gate');
  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'behind',
    detail: '1 commit(s) para pull',
    behind: 1
  }, deployErrors);

  assert.strictEqual(repo.status, 'behind');
  assert.strictEqual(repo.pending, true);
  assert.strictEqual(repo.needsAttention, true);
  assert.strictEqual(repo.deployError, false);
  assert.strictEqual(repo.deployDetail, '');
});

test('sucesso do watcher limpa estado pendente persistido', () => {
  const deployStates = markDeployState({}, 'C:/repo/app', 'running', 'Deploy em andamento', Date.now(), {
    sha: 'abc123',
    branch: 'main',
    watchId: 'watch-1'
  });

  const result = applyDeployWatchUpdate(deployStates, 'C:/repo/app', {
    phase: 'success',
    detail: 'Deploy concluido',
    watchId: 'watch-1'
  }, Date.now());

  const repo = applyDeployState({
    name: 'App',
    path: 'C:/repo/app',
    status: 'clean',
    detail: 'Sincronizado',
    headSha: 'abc123',
    branch: 'main'
  }, result.deployStates);

  assert.strictEqual(result.applied, true);
  assert.deepStrictEqual(result.deployStates, {});
  assert.strictEqual(repo.deployPending, false);
  assert.strictEqual(repo.needsAttention, false);
});

test('ordena pendencias de deploy e git no topo mantendo ordem estavel por prioridade', () => {
  const sorted = sortReposByAttention([
    { name: 'Clean', status: 'clean' },
    { name: 'Dirty B', status: 'dirty' },
    { name: 'Deploying', status: 'clean', deployPending: true },
    { name: 'Behind', status: 'behind' },
    { name: 'Dirty A', status: 'dirty' },
    { name: 'Deploy Error', status: 'clean', deployError: true },
    { name: 'Ahead', status: 'ahead' }
  ]);

  assert.deepStrictEqual(sorted.map(r => r.name), [
    'Deploying',
    'Deploy Error',
    'Behind',
    'Ahead',
    'Dirty B',
    'Dirty A',
    'Clean'
  ]);
});
