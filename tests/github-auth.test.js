const assert = require('assert');
const {
  mergeRepoGithubSecrets,
  parseGithubRemote,
  resolveGithubToken
} = require('../github-auth');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

test('interpreta remote ssh com alias de conta GitHub', () => {
  const parsed = parseGithubRemote('git@github-work:cliente/projeto.git');

  assert.deepStrictEqual(parsed, {
    owner: 'cliente',
    repo: 'projeto',
    host: 'github-work',
    webUrl: 'https://github.com/cliente/projeto'
  });
});

test('usa token GitHub especifico do repositorio antes do token global', () => {
  const resolved = resolveGithubToken(
    { githubToken: 'repo-token' },
    'git@github.com:cliente/projeto.git',
    { githubToken: 'global-token' }
  );

  assert.deepStrictEqual(resolved, {
    token: 'repo-token',
    source: 'repo'
  });
});

test('usa token GitHub global quando repo nao tem override', () => {
  const resolved = resolveGithubToken(
    { githubToken: '' },
    'https://github.com/cliente/projeto.git',
    { githubToken: 'global-token' }
  );

  assert.deepStrictEqual(resolved, {
    token: 'global-token',
    source: 'global'
  });
});

test('preserva token do repo existente quando config salva sem segredo reeditado', () => {
  const merged = mergeRepoGithubSecrets(
    [{ name: 'App', path: 'C:/repo/app', githubToken: 'repo-token' }],
    [{ name: 'App novo', path: 'C:/repo/app', enabled: true }]
  );

  assert.deepStrictEqual(merged, [
    { name: 'App novo', path: 'C:/repo/app', enabled: true, githubToken: 'repo-token' }
  ]);
});

test('preserva token por path original quando caminho do repo e editado', () => {
  const merged = mergeRepoGithubSecrets(
    [{ name: 'App', path: 'C:/repo/app', githubToken: 'repo-token' }],
    [{ name: 'App', path: 'D:/repos/app', githubTokenSourcePath: 'C:/repo/app' }]
  );

  assert.deepStrictEqual(merged, [
    { name: 'App', path: 'D:/repos/app', githubToken: 'repo-token' }
  ]);
});

test('remove token especifico quando config envia remocao explicita', () => {
  const merged = mergeRepoGithubSecrets(
    [{ name: 'App', path: 'C:/repo/app', githubToken: 'repo-token' }],
    [{ name: 'App', path: 'C:/repo/app', githubToken: '', githubTokenAction: 'remove' }]
  );

  assert.deepStrictEqual(merged, [
    { name: 'App', path: 'C:/repo/app' }
  ]);
});

test('parseia remote HTTPS sem .git', () => {
  const parsed = parseGithubRemote('https://github.com/Aprovei-Hub/trustfy-white-label-new');

  assert.deepStrictEqual(parsed, {
    owner: 'Aprovei-Hub',
    repo: 'trustfy-white-label-new',
    host: 'github.com',
    webUrl: 'https://github.com/Aprovei-Hub/trustfy-white-label-new'
  });
});

test('parseia remote HTTPS com .git', () => {
  const parsed = parseGithubRemote('https://github.com/Aprovei-Hub/trustfy-white-label-new.git');

  assert.deepStrictEqual(parsed, {
    owner: 'Aprovei-Hub',
    repo: 'trustfy-white-label-new',
    host: 'github.com',
    webUrl: 'https://github.com/Aprovei-Hub/trustfy-white-label-new'
  });
});

test('parseia remote ssh:// explicito', () => {
  const parsed = parseGithubRemote('ssh://git@github.com/owner/repo.git');

  assert.deepStrictEqual(parsed, {
    owner: 'owner',
    repo: 'repo',
    host: 'github.com',
    webUrl: 'https://github.com/owner/repo'
  });
});
