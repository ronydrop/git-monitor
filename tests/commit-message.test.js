const assert = require('assert');
const {
  EMPTY_COMMIT_MESSAGE_ERROR,
  buildCommitArgs,
  cleanCommitMessage,
  ensureCommitMessage,
  generateCommitMessageWithFallback,
  generateOpenAiCompatibleCommitMessage,
  parseCommitMessage,
  textFromContent
} = require('../commit-message');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('ok - ' + name);
    } catch (err) {
      console.error('not ok - ' + name);
      throw err;
    }
  }
}

test('repete resposta OpenRouter truncada sem raciocinio e com limite maior', async () => {
  const requests = [];
  const retries = [];
  const responses = [
    {
      choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'pensando' } }],
      usage: { completion_tokens: 600, completion_tokens_details: { reasoning_tokens: 600 } }
    },
    {
      choices: [{ finish_reason: 'stop', message: { content: 'Corrige geração de commit' } }],
      usage: { completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 0 } }
    }
  ];
  const client = {
    chat: {
      completions: {
        create: async request => {
          requests.push(request);
          return responses.shift();
        }
      }
    }
  };

  const message = await generateOpenAiCompatibleCommitMessage({
    client,
    model: 'deepseek/deepseek-v4-flash',
    provider: 'OpenRouter',
    prompt: 'diff de teste',
    reasoningEffort: 'none',
    onRetry: retry => retries.push(retry)
  });

  assert.strictEqual(message, 'Corrige geração de commit');
  assert.deepStrictEqual(requests.map(request => request.max_completion_tokens), [600, 1200]);
  assert.ok(requests.every(request => !Object.hasOwn(request, 'max_tokens')));
  assert.deepStrictEqual(requests.map(request => request.reasoning), [
    { effort: 'none' },
    { effort: 'none' }
  ]);
  assert.deepStrictEqual(retries, [{
    provider: 'OpenRouter',
    model: 'deepseek/deepseek-v4-flash',
    finishReason: 'length',
    completionTokens: 600,
    reasoningTokens: 600
  }]);
});

test('usa fallback deterministico quando todos os provedores falham', async () => {
  const failures = [];
  const message = await generateCommitMessageWithFallback({
    attempts: [
      { provider: 'OpenRouter', generate: async () => { throw new Error('resposta vazia'); } },
      { provider: 'Anthropic', generate: async () => { throw new Error('oauth expirado'); } }
    ],
    fallbackMessage: 'Atualiza arquivos do projeto',
    onFailure: failure => failures.push(failure)
  });

  assert.strictEqual(message, 'Atualiza arquivos do projeto');
  assert.deepStrictEqual(failures, [
    { provider: 'OpenRouter', error: 'resposta vazia' },
    { provider: 'Anthropic', error: 'oauth expirado' }
  ]);
});

test('retorna primeira mensagem valida sem chamar os provedores seguintes', async () => {
  let fallbackCalled = false;
  const message = await generateCommitMessageWithFallback({
    attempts: [
      { provider: 'OpenRouter', generate: async () => 'Atualiza integração OpenRouter' },
      { provider: 'Anthropic', generate: async () => { fallbackCalled = true; return 'Não usar'; } }
    ],
    fallbackMessage: 'Atualiza arquivos do projeto'
  });

  assert.strictEqual(message, 'Atualiza integração OpenRouter');
  assert.strictEqual(fallbackCalled, false);
});

test('rejeita mensagem vazia antes de montar commit', () => {
  assert.throws(() => parseCommitMessage(''), new RegExp(EMPTY_COMMIT_MESSAGE_ERROR));
  assert.throws(() => parseCommitMessage('   '), new RegExp(EMPTY_COMMIT_MESSAGE_ERROR));
  assert.throws(() => parseCommitMessage(null), new RegExp(EMPTY_COMMIT_MESSAGE_ERROR));
  assert.throws(() => parseCommitMessage(undefined), new RegExp(EMPTY_COMMIT_MESSAGE_ERROR));
});

test('usa primeira linha nao vazia como titulo', () => {
  const parsed = parseCommitMessage('\nCorrige validacao de commit\n\nDetalha ajuste');

  assert.deepStrictEqual(parsed, {
    title: 'Corrige validacao de commit',
    body: 'Detalha ajuste'
  });
});

test('separa titulo e corpo com quebras de linha Windows', () => {
  const parsed = parseCommitMessage('Corrige validacao de commit\r\n\r\nDetalha ajuste\r\nOutra linha');

  assert.deepStrictEqual(parsed, {
    title: 'Corrige validacao de commit',
    body: 'Detalha ajuste\nOutra linha'
  });
});

test('nao aceita resposta limpa para vazio', () => {
  assert.throws(() => ensureCommitMessage('```', 'OpenAI'), /OpenAI: resposta vazia ao gerar commit/);
});

test('limpa markdown, aspas e prefixo de commit', () => {
  assert.strictEqual(
    cleanCommitMessage('```text\n"Commit: Corrige validacao de commit"\n```'),
    'Corrige validacao de commit'
  );
});

test('extrai texto de conteudo em array de providers', () => {
  assert.strictEqual(
    textFromContent([{ text: 'Corrige ' }, 'validacao', { ignored: true }]),
    'Corrige validacao'
  );
});

test('monta argumentos seguros para git commit sem shell', () => {
  assert.deepStrictEqual(
    buildCommitArgs('Corrige "validacao" de commit', ''),
    ['commit', '-m', 'Corrige "validacao" de commit']
  );
  assert.deepStrictEqual(
    buildCommitArgs('Corrige validacao de commit', 'Detalha "ajuste"'),
    ['commit', '-m', 'Corrige validacao de commit', '-m', 'Detalha "ajuste"']
  );
});

run().catch(() => {
  process.exitCode = 1;
});
