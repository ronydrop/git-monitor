# Git Monitor

> Widget desktop minimalista para monitorar repositórios Git em tempo real — com commit via IA, status de deploy e muito mais.

## ✨ Funcionalidades

- **Monitoramento em tempo real** — verifica status de múltiplos repos (dirty, ahead, behind, clean)
- **Commit com IA** — gera título e descrição em português via Anthropic, OpenAI ou OpenRouter e faz push automático
- **Push All** — commita e dá push em todos os repos modificados de uma vez
- **Status de deploy** — monitora GitHub Actions após push (verde = sucesso, vermelho = falha)
- **Ghost mode** — define uma zona na tela; quando o mouse passa naquela área, o widget fica quase invisível
- **Opacidade e posicionamento** — slider de opacidade, snap para cantos da tela, travar posição
- **Atalho global** — `Ctrl+Shift+G` para esconder/mostrar o widget
- **Auto-update** — detecta e instala novas versões automaticamente

---

## 📦 Instalar (usuário final)

1. Vá em [Releases](https://github.com/ronydrop/git-monitor/releases)
2. Baixe o `GitMonitor-Setup-X.X.X.exe`
3. Execute e siga a instalação (one-click)
4. O app abre automaticamente na bandeja do sistema

> Ou baixe `GitMonitor-portable.exe` para usar sem instalar.

---

## 🛠️ Rodar em desenvolvimento

```bash
git clone https://github.com/ronydrop/git-monitor.git
cd git-monitor
npm install
npm start
```

---

## 🏗️ Fazer build

```powershell
# Portátil (.exe que roda sem instalar)
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; npm run build

# Instalador (.exe com instalação/desinstalação)
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; npm run build-installer
```

Os arquivos ficam em `dist/`.

---

## 🚀 Publicar nova versão (release automático)

O GitHub Actions builda e publica automaticamente quando você cria uma tag `v*`.

```powershell
# Patch: 1.0.0 → 1.0.1 (bug fix)
npm run version:patch

# Minor: 1.0.0 → 1.1.0 (nova feature)
npm run version:minor

# Major: 1.0.0 → 2.0.0 (breaking change)
npm run version:major
```

Isso vai:
1. Bumpar a versão no `package.json`
2. Criar um commit + tag `vX.X.X`
3. Fazer push para o GitHub
4. GitHub Actions detecta a tag e builda o instalador automaticamente
5. Cria um Release público com os arquivos

> **Requisito:** nas configurações do repositório no GitHub, vá em **Settings → Actions → General → Workflow permissions** e marque **"Read and write permissions"**.

---

## ⚙️ Configuração

Clique em ⚙ no widget:

| Campo | Descrição |
|-------|-----------|
| **Repositórios** | Caminho local dos repos. Suporte a browse de pasta |
| **Intervalo** | Frequência de verificação (10s a 5min) |
| **IA & Auth** | Provider principal, modelo e credencial para commits com IA |
| **Anthropic API Key** | Token opcional do Claude → [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **OpenAI API Key** | Token opcional da OpenAI → [platform.openai.com](https://platform.openai.com/api-keys) |
| **OpenRouter API Key** | Token opcional para modelos OpenRouter → [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| **GitHub Token** | Para monitorar deploy → [github.com/settings/tokens](https://github.com/settings/tokens) com escopo `repo` |
| **Atalho** | `Ctrl+Shift+G` — esconde/mostra o widget globalmente |

---

## 🧰 Tecnologias

- [Electron](https://www.electronjs.org/)
- [Anthropic Claude](https://www.anthropic.com/)
- [OpenAI](https://openai.com/)
- [OpenRouter](https://openrouter.ai/)
- [GitHub API](https://docs.github.com/en/rest)
- [electron-updater](https://www.electron.build/auto-update)

## 👤 Autor

**Rony Drop** · [@ronydrop](https://github.com/ronydrop)

## 📄 Licença

MIT © [Rony Drop](https://github.com/ronydrop)
