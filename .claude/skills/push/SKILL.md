---
name: push
description: Use somente no repo Git Monitor quando o usuario digitar /push neste projeto ou invocar explicitamente esta skill para publicar uma nova versao patch (preflight local, release no Friday, commit, tag vX.Y.Z, push para origin/master e promocao dos artefatos). A invocacao explicita conta como confirmacao dessas acoes; fora dela, continue pedindo confirmacao.
allowed-tools:
  - Bash
  - PowerShell
---

# Push do Git Monitor

## Regra central

Quando o usuario digitar `/push` neste repo ou invocar explicitamente esta skill, isso conta como confirmacao explicita para executar preflight, empacotamento das mudancas, release no Friday, bump patch, validacoes, commit, tag anotada, push para `origin/master` e promocao dos artefatos. Nao peca confirmacao adicional para commit, tag, push ou release.

Fora de `/push` ou da invocacao explicita desta skill, continue seguindo `AGENTS.md`: nao rode build publicavel, commit, push, tag, release, PR nem troca/criacao de branch sem confirmacao explicita.

O script e o mesmo usado pela skill do Codex (`.codex/skills/push/scripts/git_monitor_push.ps1`) — fonte unica, dois launchers. Nao duplique, nao reescreva e nao crie uma variante em `.claude/`.

## Ambiente

O Claude Code roda no Windows neste projeto e o script e PowerShell. Rode da raiz `C:\Users\ronyo\projects\git-monitor`; o script aborta se o cwd nao for a raiz do repo Git Monitor.

O script exige `git`, `node`, `npm`, `ssh`, `scp` e `tar` no PATH, alem de SSH funcional para o host `friday`.

## Execucao

1. Confirme que o cwd e `C:\Users\ronyo\projects\git-monitor`.
2. Rode o script unico da skill:

```bash
powershell -ExecutionPolicy Bypass -File .codex/skills/push/scripts/git_monitor_push.ps1
```

3. Nao crie branch, nao troque branch, nao crie tag local e nao abra PR. Commit, tag e push sao feitos pelo runner no Friday.
4. Se o script falhar, siga o protocolo de recuperacao abaixo. Pare imediatamente quando a falha estiver na lista de bloqueios protegidos ou quando o limite de tentativas for atingido.

Overrides existem mas raramente sao necessarios: `-RemoteHost friday` e `-RemoteCommand git-monitor-release`.

## Etapas do pipeline

Local (`git_monitor_push.ps1`):

1. Preflight: repo correto, branch `master`, remote `ronydrop/git-monitor`, fetch de `origin/master`, comparacao ahead/behind, comandos obrigatorios.
2. Classificacao das mudancas em seguras, ignoradas (`dist/`) e bloqueadas; qualquer bloqueada aborta antes de tudo.
3. Calculo da proxima versao patch a partir de `package.json` e checagem de tag local/remota livre.
4. Preflight remoto: `ssh friday git-monitor-release --plan-only`.
5. Empacotamento (`changes.patch` + untracked seguros + `manifest.json`), `scp` para `/srv/git-monitor/incoming` e `ssh friday git-monitor-release --apply <pacote>`.

Remoto (`git-monitor-release --apply`, sob lock):

6. Clone em `/srv/git-monitor/repo` resetado para `origin/master`, `baseHead` do pacote validado contra o HEAD remoto, patch aplicado, `dist/` removido.
7. `npm ci`, `npm test`, `npm audit`, `git diff --check`.
8. `npm version <patch> --no-git-tag-version`, commit `chore: publica Git Monitor vX.Y.Z`, tag anotada `vX.Y.Z`, `git push --atomic origin master vX.Y.Z`.
9. Espera o workflow `Release` do mesmo commit, baixa o artifact `git-monitor-artifacts-vX.Y.Z`, promove para o feed em `/var/www/local-dev-watcher-updates/git-monitor` e publica a release ponte no GitHub Releases.

O divisor de agua para recuperacao e o `git push --atomic` da etapa 8.

## Recuperacao de falhas

Ao encontrar um erro durante `/push`:

1. Capture a saida completa, o comando e a etapa que falharam.
2. Determine se a etapa 8 ja concluiu: `git fetch origin master --tags`, `git rev-parse refs/remotes/origin/master`, `git ls-remote --tags origin` e a versao em `package.json` do remoto.
3. Diagnostique a causa raiz reproduzindo a falha com o menor comando aplicavel (por exemplo `npm test` local para falha de teste).
4. Aplique somente a correcao minima, segura e reversivel necessaria.
5. Rode primeiro a validacao focada que falhou.
6. Retome conforme as regras abaixo.
7. No maximo 2 novas tentativas para a mesma causa. Se persistir, pare e reporte causa, evidencias, correcoes tentadas e estado local/remoto.

Falha **antes** da etapa 8 (preflight, path bloqueado, plan-only remoto, `npm test`, `npm audit`, tag ocupada, pacote sem mudancas): nada foi publicado. Corrija localmente e rode `/push` de novo — o pacote e sempre reconstruido do worktree contra `origin/master`, sem estado parcial para reaproveitar.

Falha **depois** da etapa 8 (workflow `Release` falhou, timeout de espera, download do artifact, promocao, release ponte): o commit e a tag ja estao em `origin/master`. Nao rode `/push` de novo para o mesmo conteudo — isso geraria outra versao patch em cima de uma release incompleta. Nessa situacao:

- Inspecione o run: `gh run list --repo ronydrop/git-monitor --workflow Release` e `gh run view <id> --repo ronydrop/git-monitor --log-failed`.
- Causa transitoria: repita o mesmo workflow (`gh run rerun <id>`) e, apos o sucesso, promova os artefatos no Friday com `git-monitor-promote-artifacts <pacote> vX.Y.Z`.
- Causa em codigo ou configuracao versionada: corrija e publique um novo patch, porque o commit anterior ja e publico. Nunca use force-push nem amend de commit publicado.

Depois de qualquer publicacao bem-sucedida, sincronize o local antes do proximo `/push`: `git pull --rebase origin master`. Sem isso o preflight aborta por `behind` ou `diverged`, ja que o commit de release nasce no clone do Friday.

Pare sem autocorrecao em caso de: arquivo bloqueado no worktree, remote inesperado, branch diferente de `master`, historico atras ou divergente de `origin/master`, tag ja existente, SSH do `friday` sem autenticar, release remoto ja em execucao (lock), conflito Git, `npm audit fix --force`, correcao destrutiva ou qualquer alteracao que exija nova autorizacao.

## Dry-run tecnico

Preflight local e remoto e calculo de versao sem alterar arquivos:

```bash
powershell -ExecutionPolicy Bypass -File .codex/skills/push/scripts/git_monitor_push.ps1 -PlanOnly
```

`-PlanOnly` nao empacota, nao envia pacote, nao faz bump, commit, tag, push nem release. Ele ainda consulta o Friday via SSH.

Validacao apenas das funcoes internas do script, sem rede e sem git:

```bash
powershell -ExecutionPolicy Bypass -File .codex/skills/push/scripts/git_monitor_push.ps1 -SelfTest
```

## O que o pipeline garante

- Branch atual precisa ser `master` e o remote `origin` precisa apontar para `ronydrop/git-monitor`.
- `master` local nao pode estar atras nem divergente de `origin/master`.
- Versao nova e sempre patch automatico a partir de `package.json`, com tag local e remota livres.
- Arquivos perigosos bloqueiam a publicacao antes de qualquer envio: `.secrets/`, `node_modules/`, `assets/`, `config.json`, `nul`, bancos (`.db`, `.sqlite*`) e midia fora de `docs/`, `public/` e `.codex/skills/push/`.
- `dist/` nunca entra no commit: e classificado como ignorado no pacote e removido do indice no clone remoto.
- O pacote carrega `baseHead`; se `origin/master` avancou, o apply remoto aborta em vez de aplicar patch sobre base errada.
- `npm ci`, `npm test` e `npm audit` rodam no Friday antes do bump, sem fixes automaticos.
- Commit usa `chore: publica Git Monitor vX.Y.Z` e tag anotada `vX.Y.Z`, publicados com `git push --atomic origin master vX.Y.Z`.
- Build publicavel roda no GitHub Actions (`Release`, disparado pela tag `v*`), nao na maquina local.
- Artefatos exigidos: `latest.yml`, `GitMonitor-Setup-X.Y.Z.exe`, o `.blockmap` correspondente e `GitMonitor-portable.exe`; `latest.yml` precisa apontar para o setup da versao.
- Promocao no Friday e atomica (staging + `mv`) e o GitHub Releases recebe a release ponte para clientes antigos.
- Release remoto roda sob `flock`: duas publicacoes simultaneas falham em vez de se misturar.
- A instalacao local do Git Monitor permanece intacta; a atualizacao chega pelo auto-update do proprio app.
