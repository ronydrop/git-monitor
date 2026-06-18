const assert = require('assert');
const {
  assertSafeBranchName,
  formatGitError,
  isGitAuthError,
  isRebaseConflictError,
  pullRebaseCommand,
  pushCommand
} = require('../git-sync');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

test('nao classifica falta de upstream como conflito de rebase', () => {
  const error = {
    message: [
      'Command failed: git pull --rebase',
      'There is no tracking information for the current branch.'
    ].join('\n')
  };

  assert.strictEqual(isRebaseConflictError(error), false);
});

test('classifica conflito real no pull rebase', () => {
  const error = {
    stderr: [
      'CONFLICT (content): Merge conflict in src/app.js',
      'error: could not apply abc1234... altera app'
    ].join('\n')
  };

  assert.strictEqual(isRebaseConflictError(error), true);
  assert.strictEqual(isGitAuthError(error), false);
});

test('classifica HTTP 401 como erro de autenticacao Git', () => {
  const error = {
    stderr: [
      'error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401',
      'fatal: Authentication failed for https://github.com/Aprovei-Hub/aprovei-shadow.git/'
    ].join('\n')
  };

  assert.strictEqual(isGitAuthError(error), true);
  assert.strictEqual(isRebaseConflictError(error), false);
});

test('classifica falta de usuario e prompt desabilitado como erro de auth Git', () => {
  const error = {
    stderr: 'fatal: could not read Username for https://github.com: terminal prompts disabled'
  };

  assert.strictEqual(isGitAuthError(error), true);
});

test('monta pull e push explicitos sem depender de upstream local', () => {
  assert.strictEqual(pullRebaseCommand('master'), 'git pull --rebase origin master');
  assert.strictEqual(pushCommand('feature/teste'), 'git push origin HEAD:feature/teste');
});

test('bloqueia branch insegura para comando shell', () => {
  assert.throws(() => assertSafeBranchName('main; rm -rf .'), /Nome de branch nao suportado/);
  assert.throws(() => assertSafeBranchName('HEAD'), /Branch atual invalida/);
});

test('formata stderr real antes da mensagem do comando', () => {
  const error = {
    stderr: 'fatal: could not read Username',
    message: 'Command failed: git pull --rebase'
  };

  assert.strictEqual(formatGitError(error), 'fatal: could not read Username Command failed: git pull --rebase');
});
