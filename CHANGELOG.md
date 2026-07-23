# Changelog

Todas as mudanças notáveis deste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [1.2.69] - 2026-07-23

### Alterado

- Reduzido o uso de CPU dos pollers de cursor do widget (ghost mode da janela flutuante e passthrough do notch): cadência adaptativa via `setTimeout` encadeado que desacelera quando o cursor está longe do widget, dedupe de chamadas a `setIgnoreMouseEvents` (só dispara quando o estado realmente muda) e pausa automática dos pollers durante lock/suspend do sistema via `powerMonitor`.
