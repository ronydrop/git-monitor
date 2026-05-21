function gitErrorText(error) {
  return [
    error && error.stderr,
    error && error.stdout,
    error && error.message
  ].filter(Boolean).join('\n').trim();
}

function isRebaseConflictError(error) {
  const text = gitErrorText(error);
  return (
    /^\s*CONFLICT\b/im.test(text) ||
    /error:\s+could not apply\s+[0-9a-f]+/i.test(text) ||
    /resolve all conflicts manually/i.test(text) ||
    /fix conflicts and then run ["']?git rebase --continue/i.test(text)
  );
}

function formatGitError(error) {
  const text = gitErrorText(error) || String(error || 'Erro Git desconhecido');
  return text.replace(/\s+/g, ' ').trim();
}

function assertSafeBranchName(branch) {
  if (!branch || branch === 'HEAD') {
    throw new Error('Branch atual invalida para push automatico.');
  }

  if (
    branch.startsWith('-') ||
    branch.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error(`Nome de branch nao suportado para push automatico: ${branch}`);
  }

  return branch;
}

function pullRebaseCommand(branch) {
  return `git pull --rebase origin ${assertSafeBranchName(branch)}`;
}

function pushCommand(branch) {
  return `git push origin HEAD:${assertSafeBranchName(branch)}`;
}

module.exports = {
  assertSafeBranchName,
  formatGitError,
  gitErrorText,
  isRebaseConflictError,
  pullRebaseCommand,
  pushCommand
};
