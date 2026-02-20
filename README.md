# Git Monitor

> Widget desktop minimalista para monitorar repositórios Git em tempo real — com commit via IA, status de deploy e muito mais.

![Git Monitor Preview](assets/preview.png)

## ✨ Funcionalidades

- **Monitoramento em tempo real** — verifica status de múltiplos repos (dirty, ahead, behind, clean)
- **Commit com IA** — gera título e descrição em português via Claude (Anthropic) e faz push automático
- **Push All** — commita e dá push em todos os repos modificados de uma vez
- **Status de deploy** — monitora GitHub Actions após push (verde = sucesso, vermelho = falha)
- **Ghost mode** — define uma zona na tela; quando o mouse passa naquela área, o widget fica quase invisível
- **Opacidade e posicionamento** — slider de opacidade, snap para cantos da tela, travar posição
- **Atalho global** — `Ctrl+Shift+G` para esconder/mostrar o widget
- **Janela de configuração** — abre terminal com 2 abas (Claude + projeto) por repo, link do GitHub, drag-to-reorder

## 📦 Download

Baixe o executável portátil em [Releases](https://github.com/ronydrop/git-monitor/releases).

## 🛠️ Instalação e uso (desenvolvimento)

```bash
# Clone o repositório
git clone https://github.com/ronydrop/git-monitor.git
cd git-monitor

# Instale as dependências
npm install

# Rode em modo desenvolvimento
npm start
```

## ⚙️ Configuração

Clique no ícone ⚙ no widget para configurar:

| Campo | Descrição |
|-------|-----------|
| **Repositórios** | Adicione os repos pelo caminho local. Suporte a browse de pasta |
| **Intervalo** | Frequência de verificação (10s a 5min) |
| **Anthropic API Key** | Para geração de commits com IA. Obtenha em [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **GitHub Token** | Para monitorar status de deploy. Crie em [github.com/settings/tokens](https://github.com/settings/tokens) com escopo `repo` |

## 🏗️ Build

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; npm run build
```

O executável portátil será gerado em `dist/GitMonitor.exe`.

## 🧰 Tecnologias

- [Electron](https://www.electronjs.org/)
- [Anthropic Claude](https://www.anthropic.com/) — geração de mensagens de commit
- [GitHub API](https://docs.github.com/en/rest) — monitoramento de deploy

## 👤 Autor

**Rony Drop**
- GitHub: [@ronydrop](https://github.com/ronydrop)

## 📄 Licença

MIT © [Rony Drop](https://github.com/ronydrop)
