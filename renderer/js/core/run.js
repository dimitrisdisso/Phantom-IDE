// Visual-Studio-style run/debug: F5 start, Ctrl+F5 run without debugging, Shift+F5 stop,
// Ctrl+Shift+F5 restart. Programs run in a dedicated "Run" terminal (real PTY, so stdin works).
import { call, bus } from './api.js';
import { wm } from './wm.js';
import { project } from './project.js';
import { dirtyDocs, saveDoc } from './docs.js';
import { toast, prompt, fail } from './ui.js';
import { basename, dirname, ext, join } from './dom.js';

const isWin = () => window.phantom && window.phantom.platform === 'win32';
let last = null; // { debug } of the last start, for restart

/** Active file of the most recently used editor window. */
export function activeFile() {
  const ed = wm.recent('editor');
  return (ed && ed.instance && ed.instance.activeFile && ed.instance.activeFile()) || null;
}

async function findUp(start, test, levels = 10) {
  let dir = start;
  for (let i = 0; i < levels; i++) {
    try {
      const hit = (await call('fs:list', dir)).find((e) => !e.dir && test(e.name));
      if (hit) return hit.path;
    } catch { /* unreadable */ }
    const up = dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return null;
}

/** Decide how to run a file. Returns { cwd, steps: [argv…] } or { native } or { error }. */
export async function planFor(file) {
  const dir = dirname(file);
  const e = ext(file);
  const base = basename(file).replace(/\.[^.]+$/, '');
  const out = join(dir, base + (isWin() ? '.exe' : ''));
  const py = isWin() ? 'python' : 'python3';
  const cwd = project.root && file.startsWith(project.root) ? project.root : dir;
  const plan = (steps, at = cwd) => ({ cwd: at, steps });
  switch (e) {
    case 'py': case 'pyw': return plan([[py, file]]);
    case 'js': case 'mjs': case 'cjs': return plan([['node', file]]);
    case 'ts': case 'mts': case 'cts': case 'tsx': return plan([['npx', '--yes', 'tsx', file]]);
    case 'go': { const mod = await findUp(dir, (n) => n === 'go.mod'); return mod ? plan([['go', 'run', '.']], dir) : plan([['go', 'run', file]]); }
    case 'rs': { const cargo = await findUp(dir, (n) => n === 'Cargo.toml'); return cargo ? plan([['cargo', 'run']], dirname(cargo)) : plan([['rustc', file, '-o', out], [out]]); }
    case 'c': return plan([['gcc', file, '-o', out], [out]]);
    case 'cpp': case 'cc': case 'cxx': return plan([['g++', '-std=c++20', file, '-o', out], [out]]);
    case 'cs': { const proj = await findUp(dir, (n) => /\.csproj$/i.test(n)); return proj ? plan([['dotnet', 'run', '--project', proj]], dirname(proj)) : plan([['dotnet', 'run', file]], dir); }
    case 'fs': case 'fsx': return plan([['dotnet', 'fsi', file]]);
    case 'java': return plan([['java', file]]);
    case 'kt': return plan([['kotlinc', file, '-include-runtime', '-d', join(dir, base + '.jar')], ['java', '-jar', join(dir, base + '.jar')]]);
    case 'rb': return plan([['ruby', file]]);
    case 'php': return plan([['php', file]]);
    case 'lua': return plan([['lua', file]]);
    case 'pl': return plan([['perl', file]]);
    case 'r': return plan([['Rscript', file]]);
    case 'jl': return plan([['julia', file]]);
    case 'swift': return plan([['swift', file]]);
    case 'dart': return plan([['dart', 'run', file]]);
    case 'zig': return plan([['zig', 'run', file]]);
    case 'ex': case 'exs': return plan([['elixir', file]]);
    case 'hs': return plan([['runghc', file]]);
    case 'sh': case 'bash': return plan([['bash', file]]);
    case 'ps1': return plan([[isWin() ? 'powershell' : 'pwsh', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]]);
    case 'bat': case 'cmd': return plan([['cmd', '/c', file]]);
    case 'html': case 'htm': case 'svg': return { native: file };
    default: return { error: `PHANTOM doesn't know how to run .${e || basename(file)} files yet. Set a run command for this project from the RUN menu.` };
  }
}

// ── shell-specific command lines ──
export function shellKind(shellPath) {
  const b = basename(String(shellPath || '')).toLowerCase().replace(/\.exe$/, '');
  if (b === 'pwsh') return 'pwsh';
  if (b === 'powershell') return 'powershell';
  if (b === 'cmd') return 'cmd';
  return 'posix';
}
function quote(a, kind) {
  a = String(a);
  const safe = kind === 'posix' ? /^[\w@%+=:,./-]+$/ : /^[\w@%+=:,./\\-]+$/;
  if (safe.test(a)) return a;
  if (kind === 'posix') return `'${a.replace(/'/g, "'\\''")}'`;
  if (kind === 'cmd') return `"${a.replace(/"/g, '""')}"`;
  return `"${a.replace(/[`"$]/g, '`$&')}"`;
}
export function commandLine(p, kind) {
  const ps = kind === 'pwsh' || kind === 'powershell';
  const cd = kind === 'posix' ? `cd ${quote(p.cwd, kind)}` : kind === 'cmd' ? `cd /d ${quote(p.cwd, kind)}` : `Set-Location -LiteralPath ${quote(p.cwd, kind)}`;
  const cmds = p.raw ? [p.raw] : p.steps.map((argv) => (ps ? '& ' : '') + argv.map((a) => quote(a, kind)).join(' '));
  if (kind === 'posix') return `clear; ${cd} && ${cmds.join(' && ')}; printf '\\n\\033[2m[process exited with code %s]\\033[0m\\n' $?`;
  if (kind === 'cmd') return `cls & ${cd} && ${cmds.join(' && ')}`;
  const chain = cmds.reduce((acc, c, i) => (i === 0 ? c : `${acc}; if ($?) { ${c} }`), '');
  return 'Clear-Host; ' + cd + '; ' + chain + '; Write-Host ""; Write-Host ("[process exited with code " + $(if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }) + "]") -ForegroundColor DarkGray';
}

// ── per-project run command (like a VS startup project) ──
async function overrides() { return (await call('store:get', 'run-configs', {}).catch(() => ({}))) || {}; }
export async function projectCommand() { return project.root ? (await overrides())[project.root] || null : null; }
export async function configure() {
  if (!project.root) { toast('open a project first (Ctrl+O)', 'warn'); return; }
  const all = await overrides();
  const v = await prompt('Run command for this project', all[project.root] || '', {
    label: `Used by F5 / Ctrl+F5 in ${project.name}, in place of running the current file.\nRuns from the project root in your shell's syntax, e.g.  npm run dev  ·  python -m app  ·  dotnet run\nLeave empty to go back to running the current file.`,
    placeholder: 'npm start', select: false
  });
  if (v === null) return;
  if (v.trim()) all[project.root] = v.trim(); else delete all[project.root];
  await call('store:set', 'run-configs', all);
  toast(v.trim() ? `F5 now runs: ${v.trim()}` : 'F5 runs the current file again', 'info', 'RUN');
  bus.emit('run:config');
}

// ── run terminal ──
async function runTerminal() {
  let w = wm.windows.find((x) => x.app.id === 'terminal' && x.instance && x.instance.isRun);
  if (!w) w = await wm.open('terminal', { state: { cwd: project.root || undefined, title: 'Run', run: true } });
  for (let i = 0; i < 50 && !(w.instance && w.instance.exec); i++) await new Promise((r) => setTimeout(r, 20));
  if (w.ws !== wm.active) wm.switchWorkspace(w.ws);
  wm.restore(w); wm.focus(w);
  return w;
}

async function saveAll() {
  for (const d of dirtyDocs()) { try { await saveDoc(d); } catch (e) { fail(e, 'SAVE BEFORE RUN'); throw e; } }
}

async function debugFile(file) {
  const w = wm.recent('debug');
  if (w && w.instance && w.instance.apply) {
    if (w.ws !== wm.active) wm.switchWorkspace(w.ws);
    wm.restore(w);
    w.instance.apply({ program: file, autostart: true });
  } else await wm.open('debug', { state: { program: file, autostart: true }, focus: false });
}

/** F5 (debug = true) / Ctrl+F5 (debug = false). */
export async function start({ debug = true } = {}) {
  last = { debug };
  try { await saveAll(); } catch { return; }
  const cmd = await projectCommand();
  const file = activeFile();
  if (cmd) {
    const w = await runTerminal();
    w.instance.exec((kind) => commandLine({ cwd: project.root, raw: cmd }, kind));
    return;
  }
  if (!file) {
    toast('Open a file in the editor, or set a run command for this project (RUN menu).', 'warn', 'NOTHING TO RUN');
    return;
  }
  if (debug && /\.(m?js|cjs)$/i.test(file)) { await debugFile(file); return; }
  const p = await planFor(file);
  if (p.error) { toast(p.error, 'warn', 'RUN'); return; }
  if (p.native) { call('fs:openNative', p.native).catch(fail); return; }
  if (debug && !start.warned) { start.warned = true; toast(`The debugger supports JavaScript only, so ${basename(file)} runs without debugging.`, 'info', 'RUN', 4500); }
  const w = await runTerminal();
  w.instance.exec((kind) => commandLine(p, kind));
}

/** Shift+F5 */
export function stop() {
  if (document.body.dataset.debugActive) {
    const d = wm.windows.find((x) => x.app.id === 'debug' && x.instance && x.instance.isActive && x.instance.isActive());
    if (d) { d.instance.stop(); return; }
  }
  const w = wm.windows.find((x) => x.app.id === 'terminal' && x.instance && x.instance.isRun);
  if (w) w.instance.write('\x03');
}

/** Ctrl+Shift+F5 */
export function restart() {
  stop();
  setTimeout(() => start(last || { debug: true }), 500);
}
