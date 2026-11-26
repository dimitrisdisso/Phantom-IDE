# PHANTOM IDE

[![CI](https://github.com/k4paz/Ohh-Phantom-IDE/actions/workflows/ci.yml/badge.svg)](https://github.com/k4paz/Ohh-Phantom-IDE/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

PHANTOM is a desktop IDE built around a floating-window workstation. It combines a Monaco editor, real terminal sessions, project tools, system monitoring, Git, databases, SSH, debugging, and security auditing in a customizable Electron interface.

## Highlights

- Floating, resizable, snap-aware windows across four workspaces
- Monaco editor with shared models, split groups, breakpoints, and external-change detection
- Real PTY terminals powered by `node-pty` with xterm.js
- Integrated Git, search, debugger, test runner, build monitor, API tester, and database tools
- Live system, network, process, log, event, architecture, and security views
- Local-first operation with no required cloud services or API keys
- Sandboxed Electron renderer and an allowlisted IPC bridge

## Requirements

- Node.js 20.17 or newer
- Git
- A desktop environment

Optional tools unlock additional integrations:

- `ripgrep` for faster project search
- OpenSSH for SSH sessions
- Language runtimes and build tools for running and debugging projects

## Quick start

```bash
npm install
npm start
```

For detached developer tools:

```bash
npm run dev
```

Run the backend integration test:

```bash
npm test
```

Build platform installers:

```bash
npm run dist
```

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `F5` | Start or continue |
| `Ctrl+F5` | Start without debugging |
| `Shift+F5` | Stop |
| `F10` / `F11` | Step over / step into |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+P` | Go to file |
| `Ctrl+O` | Open folder |
| `Ctrl+\`` | Terminal |
| `Ctrl+Shift+F` | Search |
| `Ctrl+Shift+E` | Explorer |
| `Ctrl+Shift+G` | Git |
| `Ctrl+,` | Settings |

## Project structure

```text
main/
  main.js          Electron bootstrap
  preload.js       Sandboxed IPC bridge
  registry.js      Backend service registry
  services/        Domain-specific backend services
renderer/
  index.html       Application shell
  css/             Base, window, and tool styles
  js/core/         Window manager and shared UI/runtime modules
  js/apps/         Individual floating tool modules
tools/
  backend-test.js  Plain-Node backend integration test
  devbridge.js     Optional HTTP UI development harness
```

## Development

The renderer runs only through the privileged `app://` scheme. Electron uses context isolation, a disabled Node integration, a sandboxed renderer, a strict CSP, and allowlisted IPC handlers.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## Security

PHANTOM validates IPC inputs and privileged paths, blocks navigation and external renderer APIs, rejects process signals targeting protected PIDs, and runs destructive database operations behind confirmations. Database passwords and API authentication values are not persisted.

Report vulnerabilities privately through GitHub Security Advisories. Do not open a public issue for a sensitive security report.

## License

Released under the [MIT License](LICENSE).
