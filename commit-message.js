const EMPTY_COMMIT_MESSAGE_ERROR = 'IA retornou mensagem de commit vazia. Tente novamente ou troque o modelo/provedor.';

function cleanCommitMessage(msg) {
  let text = String(msg || '');

  text = text
    .replace(/^```[\w-]*\s*\r?\n?/gm, '')
    .replace(/^```\s*$/gm, '')
    .trim();

  text = text.replace(/^["'`]|["'`]$/g, '');
  text = text.replace(/^(mensagem de commit|commit message|commit):\s*/i, '');

  return text.trim();
}

function textFromContent(content) {
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }

  return content ? String(content) : '';
}

function ensureCommitMessage(msg, provider) {
  const cleaned = cleanCommitMessage(msg);
  if (!cleaned) {
    throw new Error(`${provider}: resposta vazia ao gerar commit`);
  }
  return cleaned;
}

function parseCommitMessage(msg) {
  const lines = String(msg || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd());

  const firstTitleIndex = lines.findIndex(line => line.trim());
  const title = firstTitleIndex >= 0 ? lines[firstTitleIndex].trim() : '';
  const body = firstTitleIndex >= 0
    ? lines.slice(firstTitleIndex + 1).join('\n').trim()
    : '';

  if (!title) {
    throw new Error(EMPTY_COMMIT_MESSAGE_ERROR);
  }

  return { title, body };
}

function buildCommitArgs(title, body) {
  const parsedTitle = String(title || '').trim();
  const parsedBody = String(body || '').trim();

  if (!parsedTitle) {
    throw new Error(EMPTY_COMMIT_MESSAGE_ERROR);
  }

  return parsedBody
    ? ['commit', '-m', parsedTitle, '-m', parsedBody]
    : ['commit', '-m', parsedTitle];
}

module.exports = {
  EMPTY_COMMIT_MESSAGE_ERROR,
  buildCommitArgs,
  cleanCommitMessage,
  ensureCommitMessage,
  parseCommitMessage,
  textFromContent
};
