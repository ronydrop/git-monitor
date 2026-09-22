const EMPTY_COMMIT_MESSAGE_ERROR = 'IA retornou mensagem de commit vazia. Tente novamente ou troque o modelo/provedor.';
const COMMIT_COMPLETION_TOKEN_LIMIT = 600;
const COMMIT_COMPLETION_RETRY_TOKEN_LIMIT = 1200;

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

function completionRetryDiagnostic(response, provider, model) {
  const choice = response?.choices?.[0];
  return {
    provider,
    model,
    finishReason: choice?.finish_reason || null,
    completionTokens: response?.usage?.completion_tokens ?? null,
    reasoningTokens: response?.usage?.completion_tokens_details?.reasoning_tokens ?? null
  };
}

async function generateOpenAiCompatibleCommitMessage({
  client,
  model,
  provider,
  prompt,
  reasoningEffort,
  onRetry
}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const request = {
      model,
      max_completion_tokens: attempt === 0
        ? COMMIT_COMPLETION_TOKEN_LIMIT
        : COMMIT_COMPLETION_RETRY_TOKEN_LIMIT,
      messages: [{ role: 'user', content: prompt }]
    };
    if (reasoningEffort) request.reasoning = { effort: reasoningEffort };

    const response = await client.chat.completions.create(request);
    const content = textFromContent(response?.choices?.[0]?.message?.content);
    if (cleanCommitMessage(content)) return ensureCommitMessage(content, provider);

    if (attempt === 0 && typeof onRetry === 'function') {
      onRetry(completionRetryDiagnostic(response, provider, model));
    }
  }

  return ensureCommitMessage('', provider);
}

async function generateCommitMessageWithFallback({
  attempts,
  fallbackMessage,
  onFailure
}) {
  for (const attempt of attempts) {
    try {
      return ensureCommitMessage(await attempt.generate(), attempt.provider);
    } catch (error) {
      if (typeof onFailure === 'function') {
        onFailure({
          provider: attempt.provider,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return ensureCommitMessage(fallbackMessage, 'Fallback');
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
  generateCommitMessageWithFallback,
  generateOpenAiCompatibleCommitMessage,
  parseCommitMessage,
  textFromContent
};
