const assert = require('assert');
const {
  EMPTY_COMMIT_MESSAGE_ERROR,
  buildCommitArgs,
  cleanCommitMessage,
  ensureCommitMessage,
  parseCommitMessage,
  textFromContent
} = require('../commit-message');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

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
