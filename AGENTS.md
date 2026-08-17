Responda sempre de forma objetiva, tecnica e pratica.
Priorize solucoes aplicaveis em codigo real, especialmente em PHP, Laravel, JavaScript e bancos de dados.

Antes de sugerir grandes mudancas, aponte riscos, impactos e alternativas.
Quando houver ambiguidade, faca no maximo uma pergunta curta de esclarecimento.

Prefira exemplos de codigo completos e organizados.
Evite respostas genericas, longas ou teoricas demais.

Considere contexto de sistemas financeiros, pagamentos, chargebacks, taxas, webhooks e seguranca.
Quando possivel, antecipe edge cases e problemas de producao.

Use linguagem direta, em portugues.

## Git / Branches

Nunca crie, troque, publique ou sugira branch automaticamente.

So crie uma branch quando o usuario pedir explicitamente, por exemplo:
- "crie uma branch"
- "abre uma branch para isso"
- "faz em uma branch separada"

Se precisar modificar arquivos, trabalhe na branch atual.

Antes de qualquer `git checkout`, `git switch`, `git branch`, `git push` ou criacao de PR, peca confirmacao explicita.

Excecao: quando o usuario invocar `/merge-all` ou pedir explicitamente a skill `merge-all`, esta regra de nao navegar entre branches nao se aplica; siga o fluxo da skill, incluindo troca/uso de branches quando necessario.

Quando o usuario pedir explicitamente uma nova branch, use o prefixo `codex/`.

## Excecao local: `/push` / `Git Monitor Push`

Quando o usuario enviar `/push` neste repositorio ou invocar explicitamente a skill local "Git Monitor Push" (`git-monitor-push`), isso conta como confirmacao explicita para executar o fluxo de publicacao local: bump patch automatico, validacoes, build Electron, commit, tag `vX.Y.Z` e push atomico para `origin/master`.

Nessa situacao, carregue e siga a skill local do seu agente; nao use nenhuma skill global/externa chamada `push`:

- Codex: `.codex/skills/push/SKILL.md`
- Claude Code: `.claude/skills/push/SKILL.md`

As duas sao launchers do mesmo script `.codex/skills/push/scripts/git_monitor_push.ps1`. Nao peca uma confirmacao adicional para commit, tag ou push. Fora dessa invocacao explicita, continue pedindo confirmacao antes de qualquer commit, tag, push, branch, PR ou release.
