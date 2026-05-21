---
name: git-monitor-push
description: Use somente no repo Git Monitor quando o usuario digitar /push neste projeto ou invocar explicitamente a skill Git Monitor Push para publicar uma nova versao patch via validacoes locais, build Electron, commit, tag vX.Y.Z e push atomico para origin/master. A invocacao explicita de /push neste repo ou desta skill conta como confirmacao para essas acoes; fora disso, continue pedindo confirmacao.
---

# Push Do Git Monitor

## Regra central

Quando o usuario digitar `/push` neste repo ou invocar explicitamente esta skill pela interface como "Git Monitor Push", isso conta como confirmacao explicita para executar validacoes, build, bump de versao, commit, tag e push. Nao faca perguntas adicionais de confirmacao, mas aborte em qualquer falha de preflight.

O identificador interno desta skill e `git-monitor-push` para nao colidir com skills locais de outros repos que tambem usam `/push`.

Fora de `/push` ou da invocacao explicita desta skill, continue seguindo `AGENTS.md`: nao rode build publicavel, commit, push, tag, release, PR ou troca/criacao de branch sem confirmacao explicita.

## Execucao

1. Confirme que o cwd e `C:\Users\ronyo\projects\git-monitor`.
2. Rode o script unico da skill:

```powershell
powershell -ExecutionPolicy Bypass -File .codex\skills\push\scripts\git_monitor_push.ps1
```

3. Nao crie branch, nao troque branch e nao crie PR.
4. Se o script falhar, reporte o erro e pare. Nao tente continuar manualmente uma publicacao parcial.

## Dry-run tecnico

Para testar preflight e calculo de versao sem alterar arquivos, use:

```powershell
powershell -ExecutionPolicy Bypass -File .codex\skills\push\scripts\git_monitor_push.ps1 -PlanOnly
```

`-PlanOnly` nao faz bump, build, commit, tag ou push.

Para validar apenas funcoes internas do script, use:

```powershell
powershell -ExecutionPolicy Bypass -File .codex\skills\push\scripts\git_monitor_push.ps1 -SelfTest
```

## O que o script garante

- Branch atual precisa ser `master`.
- Remote `origin` precisa apontar para `ronydrop/git-monitor`.
- Versao nova e sempre patch automatico a partir de `package.json`.
- Arquivos perigosos bloqueiam a publicacao antes de qualquer commit.
- Build local roda com `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- Artefatos locais gerados em `dist/` sao limpos antes do commit.
- Commit usa `chore: publica Git Monitor vX.Y.Z`.
- Tag anotada usa `vX.Y.Z`.
- Push usa `git push --atomic origin master vX.Y.Z`.
- O GitHub Actions existente publica o release quando recebe a tag `v*`.
