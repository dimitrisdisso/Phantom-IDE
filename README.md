# PHANTOM

PHANTOM is a desktop IDE that works like a hacker workstation. It runs as a small operating system of floating windows: editors, terminals, monitors, network tools, Git, databases, a debugger and security scanners. You arrange them however you like across four virtual workspaces.

Everything is real: shells run in a real PTY, monitors read live kernel data, Git uses your Git binary, the debugger speaks the Chrome DevTools Protocol to Node, and the audits run on your project locally. It needs no cloud services, AI APIs or API keys.

## Install & run

You need **Node.js 20.17+** and **git**. These are optional but recommended: `ripgrep` (fast search) and an OpenSSH client (`ssh`, which Windows 10/11 already includes).

```bash
npm install      # Electron, Monaco, xterm.js, node-pty…  (no git-hosted packages, no rebuild step)
npm start        # launch PHANTOM
npm run dev      # launch with DevTools detached
npm run test:backend   # exercise every backend service against your real OS (plain Node)
npm run test:p2p       # internet collaboration: join with only the code (needs internet)
npm run test:relay     # collaboration through the relay (start it: cd relay && npx wrangler@4 dev)
npm run dist     # build installers with electron-builder (fetched on demand via npx)
```

Terminals use **node-pty 1.1**, which is built on N-API. On **Windows and macOS** it installs from prebuilt binaries that work in Electron without a rebuild. On **Linux** it compiles once with the usual toolchain (`build-essential`, `python3`). If it can't install, PHANTOM still runs: Linux and macOS fall back to the system `script` utility, which gives a real PTY that can't resize live, and Windows falls back to plain pipes. The taskbar shows `pty:native` or `pty:bridge`.

If a previous `npm install` failed partway, delete `node_modules` and `package-lock.json` first.

For the intended look, install a programming font such as **JetBrains Mono**, Fira Code or Cascadia Code. PHANTOM picks the first one it finds.

## The window system

| Action | How |
|---|---|
| Move / raise | drag the title bar · click anywhere in a window |
| Resize | drag any edge or corner (live size readout) |
| Snap | drag to an edge (half), a corner (quarter) or the top (maximize). Hold **Alt** to disable snapping and magnets |
| Magnetic alignment | windows snap to each other's edges (cyan guides). Set the threshold in Settings |
| Keyboard snap | **Ctrl+←/→/↑/↓** like Win+arrows: halves → quarters, ↑ maximize, ↓ restore/minimize (also **Ctrl+Alt+arrows**). Turn off Ctrl+arrows in Settings to keep word jumps in the editor/terminal |
| Switch windows | **Ctrl+Tab** (hold Ctrl, tap Tab, release to switch; **Ctrl+Shift+Tab** goes back) |
| Close window | **Ctrl+W** (unsaved files still ask first) |
| Jump to a window | **Ctrl+1…9** focuses that window of the current workspace (the numbers are on the taskbar) |
| Duplicate window | **Ctrl+Shift+D** |
| Close all but the code | **Ctrl+Shift+R** closes every window on the workspace except the editor(s). Running terminals are ended |
| Full screen window | **Ctrl+Shift+F** shows the focused window over the whole screen; press again to go back |
| Always on top | pin button or title right-click (amber frame) |
| Minimize / maximize / close | title buttons · double-click title · middle-click title or taskbar to close |
| Multiple instances | every tool can be opened many times (Shift+click a dock icon, or "Duplicate window") |
| Workspaces | **Ctrl+Alt+1–9** switch · **Ctrl+Alt+Shift+1–9** move the focused window · see below |
| Arrange | **Ctrl+Alt+T** tile · cascade · **Ctrl+Alt+D** show desktop · **Alt+`** cycle |
| Layouts | **Ctrl+Shift+L** saves every window on all workspaces, including open files, terminal folders and tool state. Restore from the LAYOUT menu, or use a preset (Dev station, Recon/ops, Debug bay, API lab, Security sweep, Architecture) |

The session (project, windows, positions, states) is saved automatically and restored on launch.

### Workspaces with their own folders

Each workspace has a name, its own windows and **its own folder**. Switching workspace also switches the project: the explorer, **Ctrl+F** (new file), new terminals, search and Git work in that folder.

- **New:** the **+** next to the workspace numbers. Name it, then let PHANTOM create a folder (`PHANTOM Workspaces/<name>` in your home folder) or pick an existing one. It opens with an explorer, editor and terminal.
- **Rename, change folder, delete:** right-click a workspace number (or click its name). Deleting a workspace never deletes its folder or files.
- **Ctrl+O** on a workspace changes that workspace's folder. Up to 9 workspaces.
- A Git repository rooted at your home folder is ignored for folders inside it.

## Running programs (F5, like Visual Studio)

| Key | Action |
|---|---|
| **F5** | Start: debugs JavaScript files in the Debugger; any other language runs in the **Run** terminal. While debugging, F5 continues or pauses |
| **Ctrl+F5** | Start without debugging |
| **Shift+F5** | Stop (ends the debug session, or sends Ctrl+C to the Run terminal) |
| **Ctrl+Shift+F5** | Restart |
| **F10 / F11 / Shift+F11** | Step over / into / out (while paused) |

F5 saves every modified file first, then runs the file open in the active editor. It picks the command from the extension: Python, Node, TypeScript (via `tsx`), Go (`go run`, or `go run .` inside a module), Rust (`cargo run` inside a crate, otherwise `rustc`), C/C++ (`gcc`/`g++` then the binary), C# (`dotnet run --project` with the nearest `.csproj`, otherwise `dotnet run file.cs`), F#, Java, Kotlin, Ruby, PHP, Lua, Perl, R, Julia, Swift, Dart, Zig, Elixir, Haskell, Bash, PowerShell and batch. HTML opens in your browser. The compiler or interpreter has to be installed and on your PATH.

Programs run in a single reusable **Run** terminal, so input prompts (`input()`, `Console.ReadLine()`…) work, and the exit code is printed at the end. To make F5 always run the same thing, like a Visual Studio startup project, use **RUN → Set project run command…** (for example `npm run dev` or `dotnet run`). It's saved per project. The ▶ button in each editor's tab bar does the same, and right-clicking it shows the other options.

## Live collaboration (pair programming)

Two or more people (up to 9) can edit the same file at the same time, each seeing the others' cursors and selections in their own colour with a name tag.

1. **Host:** open **Live Session** from the dock (the people icon) or the palette, then click **START SESSION**. PHANTOM shows a session code (`XXXX-XXXX-XXXX-XXXX`). **COPY INVITE** copies it, ready to send. Once the window says *Online*, people can join from anywhere.
2. **Join:** in your own PHANTOM, open Live Session, paste the code and click **JOIN**. That's all: no address, VPN, port forwarding or account. (Same network? *Same-network options* also has **FIND SESSIONS** and a direct address field, tried at the same time.)
3. **Share files:** whoever owns a file shares it: **SHARE CURRENT FILE**, right-click a tab → *Share in live session*, or right-click it in the explorer. Everyone else clicks **OPEN** and edits along.
4. **Save:** the file stays on its owner's disk. Ctrl+S from anyone saves it there. Chat lives in the Live Session window.

How it works:
- **Sync:** operational transformation (`renderer/js/shared/ot.js`, the same family of algorithm as Google Docs). The host orders all edits, so everyone converges to identical text even when typing in the same spot at the same time.
- **Connection:** peer-to-peer over the internet using [Hyperswarm](https://github.com/holepunchto/hyperswarm). The code is turned (scrypt, separate salt) into an anonymous 32-byte topic. The host announces that topic on the public Hyperswarm DHT and guests look it up. The DHT then punches a hole through both routers, so the computers connect directly with no server in between. The DHT's public bootstrap nodes only help peers find each other; they never see the code, the key or your files. On the same network, a direct TCP connection (port 7457) is tried in parallel and whichever connects first wins. When a direct link isn't possible, PHANTOM falls back to the **relay** (below). Announcing usually takes a few seconds, sometimes up to ~20.
- **Encryption:** the session code is never sent. Both sides derive an AES-256-GCM key from it with scrypt, so all traffic, including your code, is encrypted and authenticated. A connection with the wrong code can't read or send anything; it's rejected and logged to the event stream, and an address is locked out for a minute after 5 failed attempts. Each new session gets a fresh 80-bit code.
- **Relay (Cloudflare):** some networks (mobile data, CGNAT, strict office/school Wi-Fi) block direct connections. For those, both sides connect out to a small relay on Cloudflare's free Workers plan, which forwards the already-encrypted bytes (it never sees the code or your files). Deploy it once and put its `wss://` address in `phantomRelay` in `package.json`: see [relay/README.md](relay/README.md). Without a relay, people on those networks can't connect. Windows Firewall only matters for the optional direct same-network connection: **ALLOW THROUGH FIREWALL** under *Same-network options* adds the rule (administrator prompt).
- **Ending:** if the host ends the session, guests keep their open shared files as local copies they can *Save As*.

## Tools

- **Editor** (Monaco): tabs, split groups (Ctrl+\\, drag tabs between groups or windows), IntelliSense for JS/TS/JSON/CSS/HTML, word-based completion everywhere, shared models across all editor windows, external-change detection with conflict warning, breakpoints (gutter/F9), optional autosave. Rename a file or change its extension with **F2** or by double-clicking its tab. **Ctrl+F4** closes a tab and **Ctrl+PgUp/PgDn** switch tabs. Find is **Ctrl+Alt+F** (Ctrl+H for replace), because Ctrl+F creates a new file.
- **Terminal** (xterm.js + node-pty): real shells, 256-colour/truecolor, scrollback search (right-click → Find), clickable links, copy/paste (Ctrl+Shift+C/V). The working directory is tracked so layouts reopen terminals in the right folder.
- **Explorer**: lazy tree, git status colours, create/rename/duplicate/trash (to the system trash), open-with menus, keyboard navigation.
- **Search**: project-wide search powered by ripgrep (built-in fallback). Supports regex, case and whole-word options, include/exclude globs, and replace-all with confirmation.
- **Git**: stage, unstage, discard, commit/amend, inline diffs, side-by-side Monaco diff, ASCII graph log with commit inspection, branches/checkout, fetch, pull (ff-only), push (auto-sets upstream), stash.
- **Debugger**: Node.js via `--inspect-brk` and CDP. Breakpoints, continue/pause/step over/into/out (F5/F10/F11), call stack, lazily-expanded scopes, and evaluation in the selected frame.
- **Test Runner**: auto-detects jest, vitest, mocha, node:test, pytest, unittest, cargo and go. Shows a live pass/fail/skip count, failure list and run history, with an optional watch mode.
- **Build Monitor**: detects npm/pnpm/yarn scripts, Makefile targets, cargo, go, python and docker tasks. Runs several at once with timing, error/warning counts and stop/rerun.
- **API Tester**: all common methods, params↔URL sync, headers, JSON/text/form bodies, bearer/basic auth, `{{env}}` variables, history, saved requests, copy as cURL. Requests run from the main process, so CORS doesn't apply.
- **Database**: SQLite (native `node:sqlite`, `sql.js` fallback), PostgreSQL and MySQL/MariaDB. Schema browser, Monaco SQL editor with table/column completion, result grid, CSV/JSON copy. Destructive statements ask for confirmation, and passwords are never written to disk.
- **SSH**: profiles (port, identity file, ProxyJump, L/R/D forwards) plus import from `~/.ssh/config`. Sessions run the system OpenSSH client in a PTY, so your keys, agent and known_hosts apply.
- **System Monitor**: total and per-core CPU, memory/swap, disk I/O, network throughput, filesystems, load, uptime, temperature, and a process list (filter, sort by CPU/memory, top 8–40). End a process with its ✕ button, the Delete key or a right-click; Shift+Delete or *End process tree* also ends its child processes.
- **Network**: per-interface traffic graphs, every socket with its owning process, listening ports (one click to open them in the API tester or probe them), interfaces.
- **Processes**: live CPU% (computed from /proc deltas on Linux), sortable, filterable, tree view, details (exe, cwd, fds, I/O), signals with confirmation, End process tree (Shift+Delete).
- **Event Stream**: one live feed of file changes, Git state, process spawn/exit, ports opening and closing, PTY sessions, task results, debugger, security and resource-pressure events.
- **Logs**: tail -f any file (handles rotation) or PHANTOM's own log, with level colouring, filter/regex and follow mode.
- **Security Audit**: npm/pnpm audit, pip-audit, cargo audit and govulncheck when installed; a committed-secret scanner (AWS, GitHub, Slack, Stripe, private keys, JWTs, DB URLs…, with masked previews); and config checks for env files not ignored or committed, curl-pipe-sh scripts, unpinned or git dependencies, missing lockfiles, root containers, world-writable files and stray key material. Results are graded A–F.
- **Architecture**: a force-directed import graph for JS/TS (including tsconfig path aliases), Python, Go, Rust and CSS. Directory clustering, cycle detection (Tarjan SCC), most-imported/most-dependent lists, optional external packages. Double-click a module to open it.
- **Markdown / JSON viewers**: live markdown preview (sanitised with DOMPurify, follows unsaved edits) and a collapsible JSON tree with path copy, filtering and JSON Lines support.

Global keys: **F5** run · **Ctrl+Shift+P** command palette · **Ctrl+P** go to file (`file:line`) · **Ctrl+O** open folder · **Ctrl+`** terminal · **Ctrl+Shift+H/E/G** search/explorer/git · **Ctrl+,** settings · **Ctrl+F** new file (type any name.extension) · **Ctrl+W** close window · **Ctrl+Tab** switch window · **Ctrl+arrows** arrange window · **F11** fullscreen.

Themes: PHANTOM, FSOCIETY, E CORP, AMBER CRT, DARK ARMY, ICEBREAKER, GHOST. You can also set a custom accent, glow intensity, scanlines and grid.

## Architecture

```
main/
  main.js          Electron bootstrap: app:// protocol, CSP, hardened session, IPC wiring
  preload.js       sandboxed contextBridge: window.phantom.invoke / on (channel allowlist)
  registry.js      builds the backend core and loads services
  util.js          exec/walk/which helpers (no Electron imports)
  services/*.js    one module per domain: fs, watch, pty, sys, proc, net, git, search, http,
                   db, ssh, audit, tasks, debug, arch, logs, events, store, app
renderer/
  index.html, css/ base · window manager · tool styles
  js/core/         api (bridge, shared pollers, telemetry), wm (window manager), shell (chrome,
                   palette, keys, layouts), docs (Monaco models, breakpoints), settings (themes),
                   project, ui (modals/menus/toasts), graph (canvas plots), dom
  js/apps/*.js     one module per tool: { id, title, icon, size, create(win, state) → instance }
tools/
  backend-test.js  integration tests for every service (runs in plain Node)
  ot-test.js       randomised convergence tests for the collaboration engine
  p2p-test.js      host + guest find each other on the internet DHT with only the code (needs internet)
  relay-test.js    host + 2 guests through the Cloudflare relay only (run relay/ locally or pass its URL)
  collab-test.js   host + 2 guests over real encrypted TCP, concurrent editing
  devbridge.js     dev harness: serves the renderer over HTTP with the real backend (for UI testing)
```

Adding a tool means writing one file in `renderer/js/apps/` and registering it in `main.js` (and optionally the dock). A tool's `instance` can implement `serialize`, `apply`, `onResize`, `onShow`, `onFocus`, `canClose` and `destroy`. The window manager handles persistence, instances and workspaces.

**Security model.** The renderer runs with `contextIsolation`, `sandbox: true` and `nodeIntegration: false`. It is served only from the `app://` scheme, with path-traversal checks, a strict CSP (no remote scripts, no eval), navigation blocked and new windows denied. IPC handlers accept calls only from PHANTOM's own origin and validate their inputs. Git refs and SSH hosts/users are validated against option injection. Commands use `execFile` without a shell; the exception is user-authored build tasks, which run in a shell just as they would in a terminal. Process signals refuse PHANTOM itself and PID ≤ 1. Port probes are limited to loopback. Deletes go to the system trash. Database passwords and API auth values are never persisted.

**Performance.** All monitors share pollers, so one backend sample serves every window. Polling pauses for hidden or minimised windows and background workspaces. Backend snapshots are cached and de-duplicated. On Linux the file watcher skips `node_modules`, `.git` and build output. Terminal output is batched, and Monaco models are shared and reference-counted.
