// Desktop chrome: top bar, dock, taskbar, menus, command palette, keybindings, layouts, boot.
import { h, icon, esc, bytes, pct, basename, rate } from './dom.js';
import { call, on, bus, telemetry, onTelemetry, platform } from './api.js';
import { wm } from './wm.js';
import { settings, setSetting, THEMES } from './settings.js';
import { project, pickProject, openProject, projectFiles } from './project.js';
import { menu, palette, toast, prompt, confirm, tooltip, fail } from './ui.js';
import { plot } from './graph.js';
import { dirtyDocs, normPath } from './docs.js';
import * as run from './run.js';
import * as live from './collab.js';
import { newFile } from './files.js';
import { spaces, nameOf, newWorkspace, renameWorkspace, setWorkspaceFolder, deleteWorkspace, syncWorkspace } from './workspaces.js';

export const DOCK = [
  ['editor', 'explorer', 'search', 'terminal', 'git'],
  ['debug', 'tests', 'build'],
  ['api', 'db', 'json', 'markdown'],
  ['sysmon', 'net', 'procs', 'logs', 'events'],
  ['collab', 'ssh', 'audit', 'arch']
];

// Fractional layouts (desk 1×1) — scaled to the real desktop by restoreLayout.
export const PRESETS = {
  'Dev station': [
    ['explorer', 0, 0, 0.17, 1], ['editor', 0.17, 0, 0.55, 0.66], ['terminal', 0.17, 0.66, 0.55, 0.34], ['git', 0.72, 0, 0.28, 0.55], ['sysmon', 0.72, 0.55, 0.28, 0.45]
  ],
  'Recon / ops': [
    ['sysmon', 0, 0, 0.5, 0.5], ['net', 0.5, 0, 0.5, 0.5], ['procs', 0, 0.5, 0.5, 0.5], ['events', 0.5, 0.5, 0.5, 0.5]
  ],
  'Debug bay': [
    ['editor', 0, 0, 0.62, 0.65], ['debug', 0.62, 0, 0.38, 0.65], ['terminal', 0, 0.65, 0.4, 0.35], ['tests', 0.4, 0.65, 0.3, 0.35], ['logs', 0.7, 0.65, 0.3, 0.35]
  ],
  'API lab': [
    ['api', 0, 0, 0.55, 1], ['db', 0.55, 0, 0.45, 0.55], ['json', 0.55, 0.55, 0.45, 0.45]
  ],
  'Security sweep': [
    ['audit', 0, 0, 0.55, 1], ['net', 0.55, 0, 0.45, 0.5], ['events', 0.55, 0.5, 0.45, 0.5]
  ],
  'Architecture': [
    ['arch', 0, 0, 0.7, 1], ['explorer', 0.7, 0, 0.3, 0.5], ['search', 0.7, 0.5, 0.3, 0.5]
  ]
};
function presetLayout(name) {
  return { v: 1, active: wm.active, desk: { w: 1, h: 1 }, windows: PRESETS[name].map(([app, x, y, w, hh]) => ({ app, ws: wm.active, rect: { x, y, w, h: hh }, state: {} })) };
}
export async function applyPreset(name, { replace = true } = {}) {
  if (replace) {
    // Only clear the current workspace.
    for (const w of [...wm.windows]) if (w.ws === wm.active && !(await wm.close(w))) return;
  }
  await wm.restoreLayout(presetLayout(name), { replace: false });
}

// ───────── layouts ─────────
async function layouts() { return (await call('store:get', 'layouts', {})) || {}; }
export async function saveLayoutAs() {
  const name = await prompt('Save workspace layout', `layout-${new Date().toISOString().slice(0, 10)}`, { label: 'Saves every window across all four workspaces: positions, sizes, states, open files and terminal folders.' });
  if (!name) return;
  const all = await layouts();
  all[name.trim()] = { ...wm.serialize(), project: project.root, saved: Date.now() };
  await call('store:set', 'layouts', all);
  toast(`layout "${name}" saved (${wm.windows.length} windows)`, 'info', 'LAYOUT');
}
export async function loadLayout(name) {
  const l = (await layouts())[name];
  if (!l) return;
  await wm.restoreLayout(l);
  if (l.project && l.project !== project.root) await openProject(l.project, { silent: true });
  else await syncWorkspace();
  toast(`layout "${name}" restored`, 'info', 'LAYOUT', 1800);
}

// ───────── open file routing ─────────
export async function openFile(path, opts = {}) {
  path = normPath(path);
  let win = opts.newWindow ? null : wm.recent('editor');
  if (!win) win = await wm.open('editor', { state: {} });
  else { wm.restore(win); wm.focus(win); }
  for (let i = 0; i < 50 && !(win.instance && win.instance.openFile); i++) await new Promise((r) => setTimeout(r, 20));
  if (win.instance && win.instance.openFile) await win.instance.openFile(path, opts);
  return win;
}
bus.on('open-file', (p, opts) => openFile(p, opts).catch((e) => fail(e)));

// ───────── window actions (shortcuts, menus, palette) ─────────
/** The current workspace's windows in taskbar order (Ctrl+1…9 follow this). */
const taskOrder = () => wm.windows.filter((w) => w.ws === wm.active && !w.closed).sort((a, b) => a.id - b.id);
function focusNth(i) {
  const w = taskOrder()[i];
  if (!w) { toast(`there is no window ${i + 1} on this workspace`, 'info', 'WINDOW', 1200); return; }
  wm.restore(w); wm.focus(w);
}
function duplicateFocused() {
  const w = wm.focused;
  if (!w) { toast('focus a window first', 'warn', 'WINDOW', 1500); return; }
  if (w.app.singleton) { toast(`only one ${w.app.title} window can be open`, 'warn', 'WINDOW', 2000); return; }
  wm.duplicate(w).catch(fail);
}
let clearing = false;
/** Close every window on this workspace except the code editor(s). */
async function closeAllButCode() {
  if (clearing) return;
  const list = taskOrder();
  if (!list.some((w) => w.app.id === 'editor')) { toast('open a code file first: nothing was closed', 'warn', 'WINDOW'); return; }
  clearing = true;
  try {
    wm.exitFullscreen();
    for (const w of list) if (w.app.id !== 'editor' && !(await wm.close(w))) break;
    const ed = wm.recent('editor'); if (ed) { wm.restore(ed); wm.focus(ed); }
  } finally { clearing = false; }
}
function toggleFullscreenFocused() {
  const w = wm.fsWin || wm.focused;
  if (!w) { toast('focus a window first', 'warn', 'WINDOW', 1500); return; }
  const entering = wm.fsWin !== w;
  wm.toggleFullscreen(w);
  if (entering) toast('Ctrl+Shift+F to leave full screen', 'info', 'FULL SCREEN', 1800);
}

// ───────── commands ─────────
export function commands() {
  const out = [];
  for (const app of wm.apps.values()) if (!app.hidden) out.push({ group: 'tools', label: `Open ${app.title}`, detail: app.desc, icon: app.icon, key: app.key, run: () => wm.open(app.id) });
  out.push(
    { group: 'project', label: 'Open project folder…', icon: 'folder', key: 'Ctrl+O', run: pickProject },
    { group: 'project', label: 'Go to file…', icon: 'file', key: 'Ctrl+P', run: quickOpen },
    { group: 'project', label: 'New file…', detail: 'name it with any extension', icon: 'file', key: 'Ctrl+F', run: () => newFile().catch(fail) },
    ...project.recent.map((r) => ({ group: 'project', label: `Open recent: ${basename(r)}`, detail: r, icon: 'folder', run: () => openProject(r) })),
    { group: 'run', label: 'Run: Start', icon: 'play', key: 'F5', run: () => run.start({ debug: true }) },
    { group: 'run', label: 'Run: Start without debugging', icon: 'play', key: 'Ctrl+F5', run: () => run.start({ debug: false }) },
    { group: 'run', label: 'Run: Stop', icon: 'stop', key: 'Shift+F5', run: run.stop },
    { group: 'run', label: 'Run: Restart', icon: 'refresh', key: 'Ctrl+Shift+F5', run: run.restart },
    { group: 'run', label: 'Run: Set project run command…', icon: 'settings', run: run.configure },
    { group: 'live', label: 'Live: Open session window (host / join)', icon: 'collab', run: () => wm.open('collab') },
    ...(live.session.role ? [{ group: 'live', label: 'Live: Share current file', icon: 'collab', run: () => { const f = run.activeFile(); if (f) live.share(f).catch(fail); else toast('open a file first', 'warn'); } },
      { group: 'live', label: live.session.role === 'host' ? 'Live: End session' : 'Live: Leave session', icon: 'close', run: () => live.leave() }] : []),
    { group: 'window', label: 'Tile windows', icon: 'layout', key: 'Ctrl+Alt+T', run: () => wm.tile() },
    { group: 'window', label: 'Cascade windows', icon: 'layout', run: () => wm.cascade() },
    { group: 'window', label: 'Switch window', icon: 'layout', key: 'Ctrl+Tab', run: () => { switcherStep(1); setTimeout(switcherCommit, 0); } },
    { group: 'window', label: 'Close focused window', icon: 'close', key: 'Ctrl+W', run: () => wm.focused && wm.close(wm.focused) },
    { group: 'window', label: 'Show desktop', icon: 'layout', key: 'Ctrl+Alt+D', run: () => wm.showDesktop() },
    { group: 'window', label: 'Close all windows in this workspace', icon: 'close', run: async () => { for (const w of [...wm.windows]) if (w.ws === wm.active) await wm.close(w); } },
    { group: 'window', label: 'Toggle always-on-top for focused window', icon: 'pin', run: () => wm.focused && wm.setPinned(wm.focused, !wm.focused.pinned) },
    { group: 'window', label: 'Duplicate current window', icon: 'layout', key: 'Ctrl+Shift+D', run: duplicateFocused },
    { group: 'window', label: 'Close all windows except the code file', icon: 'close', key: 'Ctrl+Shift+R', run: closeAllButCode },
    { group: 'window', label: 'Full screen the selected window', icon: 'max', key: 'Ctrl+Shift+F', run: toggleFullscreenFocused },
    ...spaces.map((s, i) => ({ group: 'workspace', label: `Switch to ${s.name}`, detail: s.folder || '', icon: 'layout', key: `Ctrl+Alt+${i + 1}`, run: () => wm.switchWorkspace(i) })),
    { group: 'workspace', label: 'New workspace…', detail: 'with its own folder', icon: 'folder', run: () => newWorkspaceWithWindows() },
    { group: 'workspace', label: 'Rename this workspace…', icon: 'settings', run: () => renameWorkspace(wm.active) },
    { group: 'workspace', label: "Change this workspace's folder…", icon: 'folder', run: () => setWorkspaceFolder(wm.active) },
    { group: 'workspace', label: 'Delete this workspace…', icon: 'close', run: () => deleteWorkspace(wm.active) },
    { group: 'layout', label: 'Save layout as…', icon: 'save', key: 'Ctrl+Shift+L', run: saveLayoutAs },
    ...Object.keys(PRESETS).map((n) => ({ group: 'layout', label: `Preset: ${n}`, icon: 'layout', run: () => applyPreset(n) })),
    { group: 'theme', label: 'Toggle scanlines', icon: 'eye', run: () => setSetting('scanlines', !settings.scanlines) },
    { group: 'theme', label: 'Toggle desktop grid', icon: 'eye', run: () => setSetting('grid', !settings.grid) },
    ...Object.entries(THEMES).map(([k, t]) => ({ group: 'theme', label: `Theme: ${t.name}`, detail: t.desc, icon: 'eye', run: () => setSetting('theme', k) })),
    { group: 'system', label: 'Settings', icon: 'settings', key: 'Ctrl+,', run: () => wm.open('settings') },
    { group: 'system', label: 'Toggle developer tools', icon: 'debug', run: () => call('app:devtools') },
    { group: 'system', label: 'Toggle fullscreen', icon: 'max', key: 'F11', run: () => call('app:fullscreen') },
    { group: 'system', label: 'Reload interface', icon: 'refresh', run: () => location.reload() }
  );
  return out;
}
export async function commandPalette() {
  const l = await layouts();
  palette({ items: [...commands(), ...Object.keys(l).map((n) => ({ group: 'layout', label: `Load layout: ${n}`, icon: 'layout', run: () => loadLayout(n) }))] });
}
export async function quickOpen() {
  if (!project.root) { toast('open a project first (Ctrl+O)', 'warn'); return; }
  const files = await projectFiles();
  palette({
    prefix: '⌕', placeholder: `Go to file in ${project.name}… (append :line)`, footer: `${files.length} files indexed · ↵ open · esc close`,
    items: (q) => {
      const [qq, line] = q.split(':');
      const items = [];
      for (const f of files) {
        const m = qq ? (fuzzyPath(qq, f)) : { score: 0, idx: [] };
        if (m) items.push({ label: f, icon: 'file', match: m, run: () => openFile(project.root + (platform === 'win32' ? '\\' : '/') + f, { line: Number(line) || undefined }) });
      }
      items.sort((a, b) => b.match.score - a.match.score);
      const out = items.slice(0, 200); out.prescored = true; return out;
    }
  });
}
function fuzzyPath(q, f) {
  // favour matches in the basename
  const ql = q.toLowerCase(); const fl = f.toLowerCase();
  let qi = 0; let score = 0; let prev = -2; const idx = [];
  const base = fl.lastIndexOf('/') + 1;
  for (let i = 0; i < fl.length && qi < ql.length; i++) {
    if (fl[i] === ql[qi]) { let s = 1; if (i === prev + 1) s += 5; if (i >= base) s += 2; if (i === base || /[/._-]/.test(fl[i - 1])) s += 3; score += s; idx.push(i); prev = i; qi++; }
  }
  if (qi < ql.length) return null;
  if (fl.slice(base).startsWith(ql)) score += 20;
  return { score: score - f.length * 0.05, idx };
}

// ───────── top bar ─────────
function buildTopbar() {
  const bar = document.getElementById('topbar');
  const menus = {
    SYSTEM: () => [
      { header: 'PHANTOM' },
      { label: 'Command palette', key: 'Ctrl+Shift+P', action: commandPalette },
      { label: 'Settings', key: 'Ctrl+,', action: () => wm.open('settings') },
      '-',
      { label: 'Toggle fullscreen', key: 'F11', action: () => call('app:fullscreen') },
      { label: 'Developer tools', action: () => call('app:devtools') },
      { label: 'Reload interface', action: () => location.reload() },
      '-',
      { label: 'Quit', danger: true, action: quit }
    ],
    PROJECT: () => [
      { label: 'New file…', key: 'Ctrl+F', action: () => newFile().catch(fail) },
      { label: 'Open folder…', key: 'Ctrl+O', action: pickProject },
      { label: 'New workspace…', action: () => newWorkspaceWithWindows() },
      { label: 'Go to file…', key: 'Ctrl+P', action: quickOpen, disabled: !project.root },
      { label: 'Search in project', key: 'Ctrl+Shift+H', action: () => wm.open('search'), disabled: !project.root },
      '-',
      { header: 'RECENT' },
      ...(project.recent.length ? project.recent.map((r) => ({ label: r.replace(project.home, '~'), check: r === project.root, action: () => openProject(r) })) : [{ label: 'none yet', disabled: true }])
    ],
    TOOLS: () => DOCK.flatMap((g, i) => [...(i ? ['-'] : []), ...g.map((id) => { const a = wm.apps.get(id); return a && { label: a.title, key: a.key, action: () => wm.open(id) }; })]),
    RUN: async () => {
      const cmd = await run.projectCommand();
      const f = run.activeFile();
      return [
        { header: cmd ? `PROJECT COMMAND: ${cmd}` : f ? `CURRENT FILE: ${basename(f)}` : 'NOTHING SELECTED' },
        { label: 'Start', key: 'F5', action: () => run.start({ debug: true }) },
        { label: 'Start without debugging', key: 'Ctrl+F5', action: () => run.start({ debug: false }) },
        { label: 'Stop', key: 'Shift+F5', action: run.stop },
        { label: 'Restart', key: 'Ctrl+Shift+F5', action: run.restart },
        '-',
        { label: cmd ? 'Change project run command…' : 'Set project run command…', action: run.configure, disabled: !project.root },
        { label: 'Debugger window', action: () => wm.open('debug') },
        { label: 'Build tasks', action: () => wm.open('build') }
      ];
    },
    WINDOW: () => [
      { label: 'Tile', key: 'Ctrl+Alt+T', action: () => wm.tile() },
      { label: 'Cascade', action: () => wm.cascade() },
      { label: 'Show desktop', key: 'Ctrl+Alt+D', action: () => wm.showDesktop() },
      { label: 'Cycle windows', key: 'Alt+`', action: () => wm.cycle(1) },
      { label: 'Switch window', key: 'Ctrl+Tab', action: () => { switcherStep(1); setTimeout(switcherCommit, 0); } },
      { label: 'Close window', key: 'Ctrl+W', action: () => wm.focused && wm.close(wm.focused), disabled: !wm.focused },
      { label: 'Duplicate window', key: 'Ctrl+Shift+D', action: duplicateFocused, disabled: !wm.focused },
      { label: 'Close all but the code file', key: 'Ctrl+Shift+R', action: closeAllButCode },
      { label: 'Full screen window', key: 'Ctrl+Shift+F', action: toggleFullscreenFocused, disabled: !wm.focused },
      '-',
      { label: 'Snapping to edges', check: settings.snap, action: () => setSetting('snap', !settings.snap) },
      { label: 'Magnetic alignment', check: settings.magnet > 0, action: () => setSetting('magnet', settings.magnet > 0 ? 0 : 10) },
      '-',
      { header: 'WINDOWS' },
      ...wm.windows.filter((w) => w.ws === wm.active).map((w) => ({ label: w.title + (w.sub ? ' — ' + w.sub.slice(-30) : ''), check: w === wm.focused, action: () => { wm.restore(w); wm.focus(w); } }))
    ],
    LAYOUT: async () => {
      const l = await layouts();
      return [
        { label: 'Save layout as…', key: 'Ctrl+Shift+L', action: saveLayoutAs },
        '-', { header: 'PRESETS (current workspace)' },
        ...Object.keys(PRESETS).map((n) => ({ label: n, action: () => applyPreset(n) })),
        '-', { header: 'SAVED' },
        ...(Object.keys(l).length ? Object.entries(l).map(([n, v]) => ({ label: `${n}  ·  ${v.windows.length} win`, action: () => loadLayout(n) })) : [{ label: 'nothing saved', disabled: true }]),
        ...(Object.keys(l).length ? ['-', { label: 'Delete a saved layout…', action: async () => {
          const n = await prompt('Delete layout', Object.keys(l)[0], { label: 'Name: ' + Object.keys(l).join(', ') });
          if (n && l[n] && await confirm('Delete layout', `Delete "${n}"?`, { danger: true, ok: 'DELETE' })) { delete l[n]; await call('store:set', 'layouts', l); toast('deleted ' + n); }
        } }] : [])
      ];
    },
    THEME: () => [
      ...Object.entries(THEMES).map(([k, t]) => ({ label: `${t.name}`, key: t.desc, check: settings.theme === k, action: () => setSetting('theme', k) })),
      '-',
      { label: 'Scanlines', check: settings.scanlines, action: () => setSetting('scanlines', !settings.scanlines) },
      { label: 'Desktop grid', check: settings.grid, action: () => setSetting('grid', !settings.grid) },
      { label: 'Reduce motion', check: settings.reduceMotion, action: () => setSetting('reduceMotion', !settings.reduceMotion) },
      { label: 'More…', action: () => wm.open('settings') }
    ]
  };
  const menuBar = h('div.menu');
  for (const [name, items] of Object.entries(menus)) {
    const b = h('button', name);
    b.addEventListener('mousedown', async (e) => { e.preventDefault(); e.stopPropagation(); const r = b.getBoundingClientRect(); b.classList.add('open'); menu(r.left, r.bottom, await items()); const off = () => { b.classList.remove('open'); document.removeEventListener('mousedown', off, true); }; setTimeout(() => document.addEventListener('mousedown', off, true), 0); });
    menuBar.appendChild(b);
  }
  const projEl = h('span.proj', { on: { click: pickProject } });
  const branchEl = h('span.branch');
  const ws = h('div.ws');
  const meter = (label) => { const c = h('canvas'); const v = h('b', '—'); return { el: h('div.meter', label, c, v), c, v }; };
  const mCpu = meter('CPU'); const mMem = meter('MEM'); const mNet = meter('NET');
  const meters = h('div.meters', { on: { click: () => wm.open('sysmon') }, style: { cursor: 'pointer' } }, mCpu.el, mMem.el, mNet.el);
  const clock = h('div.clock');
  const wctl = h('div.wctl',
    h('button', { html: icon('min'), on: { click: () => call('app:minimize') } }),
    h('button', { html: icon('max'), on: { click: () => call('app:maximize') } }),
    h('button.x', { html: icon('close'), on: { click: quit } }));
  bar.append(h('div.brand', { html: icon('logo') + 'PHANTOM', on: { click: commandPalette }, title: 'Command palette (Ctrl+Shift+P)' }), menuBar,
    h('div.drag', projEl, branchEl), ws, meters, clock, wctl);
  if (platform === 'darwin') wctl.style.display = 'none';

  const meta = () => {
    projEl.textContent = project.root ? project.root.replace(project.home, '~') : '[ no project mounted — click to open ]';
    branchEl.innerHTML = project.branch ? `${icon('branch')} ${esc(project.branch)}` : '';
    branchEl.querySelector('svg') && Object.assign(branchEl.querySelector('svg').style, { width: '10px', height: '10px', verticalAlign: '-1px' });
  };
  bus.on('project:meta', meta); bus.on('project:changed', meta); meta();
  const wsSync = () => {
    ws.innerHTML = '';
    for (let i = 0; i < wm.workspaceCount(); i++) {
      const sp = spaces[i];
      ws.appendChild(h('button' + (i === wm.active ? '.on' : '') + (wm.windows.some((w) => w.ws === i) ? '.has' : ''), {
        title: `${nameOf(i)}${sp && sp.folder ? '\n' + sp.folder : ''}\nCtrl+Alt+${i + 1} · right-click for options`,
        on: { click: () => wm.switchWorkspace(i), contextmenu: (e) => { e.preventDefault(); e.stopPropagation(); workspaceMenu(i, e.clientX, e.clientY + 8); } }
      }, String(i + 1)));
    }
    if (wm.workspaceCount() < wm.maxWorkspaces()) ws.appendChild(h('button.add', { title: 'New workspace with its own folder', on: { click: () => newWorkspaceWithWindows() } }, '+'));
    ws.appendChild(h('span.ws-name', { title: 'Workspace options', on: { click: (e) => workspaceMenu(wm.active, e.clientX - 120, e.clientY + 12) } }, nameOf(wm.active)));
  };
  let wsKey = '';
  // Rebuild only when something shown here changed (wm:changed fires on every focus).
  const wsMaybe = () => { const k = JSON.stringify([wm.active, spaces, [...new Set(wm.windows.map((w) => w.ws))].sort()]); if (k !== wsKey) { wsKey = k; wsSync(); } };
  bus.on('wm:changed', wsMaybe); bus.on('ws:changed', wsMaybe); wsMaybe();
  const tick = () => {
    const d = new Date();
    clock.innerHTML = `<span>${d.toISOString().slice(0, 10)}</span>${d.toTimeString().slice(0, 8)}`;
  };
  setInterval(tick, 1000); tick();
  onTelemetry((s, hist) => {
    mCpu.v.textContent = pct(s.cpu.load);
    mMem.v.textContent = pct((s.mem.used / s.mem.total) * 100);
    mNet.v.textContent = bytes(s.net.rx_sec + s.net.tx_sec);
    const last = hist.slice(-40);
    plot(mCpu.c, [{ data: last.map((x) => x.cpu.load) }], { max: 100, grid: false, points: 40 });
    plot(mMem.c, [{ data: last.map((x) => (x.mem.used / x.mem.total) * 100), color: getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() }], { max: 100, grid: false, points: 40 });
    plot(mNet.c, [{ data: last.map((x) => x.net.rx_sec + x.net.tx_sec), color: getComputedStyle(document.documentElement).getPropertyValue('--amber').trim() }], { grid: false, points: 40 });
    meters.title = `cpu ${pct(s.cpu.load, 1)} · mem ${bytes(s.mem.used)}/${bytes(s.mem.total)} · ↓${rate(s.net.rx_sec)} ↑${rate(s.net.tx_sec)}`;
  });
}

// ───────── workspaces ─────────
function workspaceMenu(i, x, y) {
  menu(x, y, [
    { header: nameOf(i) },
    { label: 'Switch to it', check: i === wm.active, action: () => wm.switchWorkspace(i), key: `Ctrl+Alt+${i + 1}` },
    { label: 'Rename…', action: () => renameWorkspace(i) },
    { label: 'Change folder…', action: () => setWorkspaceFolder(i) },
    { label: 'Open folder in file manager', disabled: !(spaces[i] && spaces[i].folder), action: () => call('fs:openNative', spaces[i].folder).catch(fail) },
    '-',
    { label: 'New workspace…', action: () => newWorkspaceWithWindows(), disabled: wm.workspaceCount() >= wm.maxWorkspaces() },
    { label: 'Delete workspace…', danger: true, action: () => deleteWorkspace(i), disabled: wm.workspaceCount() <= 1 }
  ]);
}
/** A new workspace starts with an explorer, an editor and a terminal pointing at its folder. */
async function newWorkspaceWithWindows() {
  const i = await newWorkspace();
  if (i === null) return;
  await wm.restoreLayout({ v: 1, active: i, desk: { w: 1, h: 1 }, windows: [
    ['explorer', 0, 0, 0.2, 1], ['terminal', 0.2, 0.68, 0.8, 0.32], ['editor', 0.2, 0, 0.8, 0.68]
  ].map(([app, x, y, w, hh]) => ({ app, ws: i, rect: { x, y, w, h: hh }, state: {}, focused: app === 'editor' })) }, { replace: false });
}

// ───────── dock ─────────
function buildDock() {
  const dock = document.getElementById('dock');
  DOCK.forEach((group, gi) => {
    if (gi) dock.appendChild(h('div.sep'));
    for (const id of group) {
      const app = wm.apps.get(id); if (!app) continue;
      const b = h('button', { 'data-app': id, html: icon(app.icon) + '<span class="n"></span>' });
      b.addEventListener('click', (e) => {
        const existing = wm.ofApp(id).filter((w) => w.ws === wm.active);
        if (e.shiftKey || !existing.length || app.singleton) wm.open(id);
        else { const w = wm.recent(id); if (w.min) wm.restore(w); if (w === wm.focused && !e.altKey) wm.open(id); else wm.focus(w); }
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const wins = wm.ofApp(id);
        menu(e.clientX, e.clientY, [{ header: app.title }, { label: 'New window', action: () => wm.open(id) },
          ...(wins.length ? ['-', ...wins.map((w) => ({ label: `${w.title}${w.sub ? ' · ' + w.sub.slice(-28) : ''}  [${nameOf(w.ws)}]`, action: () => { wm.switchWorkspace(w.ws); wm.restore(w); wm.focus(w); } })), '-', { label: `Close all (${wins.length})`, danger: true, action: () => wins.forEach((w) => wm.close(w)) }] : [])]);
      });
      tooltip(b, app.title, app.key || '');
      dock.appendChild(b);
    }
  });
  dock.appendChild(h('div', { style: { flex: '1' } }));
  const sb = h('button', { html: icon('settings'), on: { click: () => wm.open('settings') } });
  tooltip(sb, 'Settings', 'Ctrl+,');
  dock.appendChild(sb);
  const sync = () => {
    for (const b of dock.querySelectorAll('button[data-app]')) {
      const n = wm.windows.filter((w) => w.app.id === b.dataset.app).length;
      b.classList.toggle('running', n > 0);
      b.querySelector('.n').textContent = n > 1 ? n : '';
    }
  };
  bus.on('wm:changed', sync);
}

// ───────── taskbar ─────────
function buildTaskbar() {
  const bar = document.getElementById('taskbar');
  const tasks = h('div.tasks');
  const status = h('div.status');
  bar.append(h('button.start', { html: icon('logo') + ' LAUNCH', on: { click: commandPalette } }), tasks, status);
  const render = () => {
    const list = wm.windows.filter((w) => w.ws === wm.active).sort((a, b) => a.id - b.id);
    tasks.innerHTML = '';
    for (const [n, w] of list.entries()) {
      const b = h('button.task' + (w === wm.focused ? '.focus' : '') + (w.min ? '.min' : ''), { 'data-win': w.id, title: `${w.title}${w.sub ? ' — ' + w.sub : ''}`, html: `${n < 9 ? `<i class="tnum">${n + 1}</i>` : ''}${icon(w.app.icon)}<span>${esc(w.title)}${w.sub ? ' <span class="c-dim">' + esc(basename(w.sub)) + '</span>' : ''}</span>${w.pinned ? '<span class="pin">▲</span>' : ''}` });
      b.addEventListener('click', () => { if (w === wm.focused && !w.min) wm.minimize(w); else { wm.restore(w); wm.focus(w); } });
      b.addEventListener('auxclick', (e) => { if (e.button === 1) wm.close(w); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); wm.windowMenu(w, e.clientX, e.clientY - 300); });
      tasks.appendChild(b);
    }
  };
  bus.on('wm:changed', render);
  const st = { pty: null, events: 0, tasks: 0 };
  const renderStatus = () => {
    const total = wm.windows.length;
    status.innerHTML = `<span>${total} win · ws ${wm.active + 1} ${esc(nameOf(wm.active))}</span>` +
      (st.tasks ? `<span class="warn"><span class="spin"></span> ${st.tasks} task${st.tasks > 1 ? 's' : ''}</span>` : '') +
      (st.pty ? `<span class="${st.pty.native ? 'ok' : 'warn'}" title="${st.pty.native ? 'node-pty' : esc(st.pty.error || '')}">pty:${st.pty.native ? 'native' : 'bridge'}</span>` : '') +
      (live.session.role ? `<button class="ok live-status" title="live session">⇄ LIVE ${live.session.peers.length}</button>` : '') +
      `<span class="ok">● online</span>`;
  };
  call('pty:info').then((i) => { st.pty = i; renderStatus(); }).catch(() => {});
  on('tasks:exit', () => call('tasks:running').then((r) => { st.tasks = r.length; renderStatus(); }));
  bus.on('tasks:started', () => call('tasks:running').then((r) => { st.tasks = r.length; renderStatus(); }));
  bus.on('wm:changed', renderStatus);
  bus.on('collab:changed', renderStatus);
  bus.on('ws:changed', renderStatus);
  status.addEventListener('click', (e) => { if (e.target.closest('.live-status')) wm.open('collab'); });
  renderStatus();
}

function buildWallpaper() {
  const wp = document.getElementById('wallpaper');
  const sig = h('div.sig');
  const hint = h('div.hint', { html: '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> command palette &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>`</kbd> terminal &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>O</kbd> open project &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>F</kbd> new file &nbsp;·&nbsp; <kbd>F5</kbd> run<br><kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> switch windows · <kbd>Ctrl</kbd>+<kbd>W</kbd> close · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> full screen · <kbd>Ctrl</kbd>+arrows arrange · drag windows to screen edges to snap · <kbd>Alt</kbd> while dragging disables magnets' });
  wp.append(sig, hint);
  const upd = () => {
    const s = telemetry.static;
    sig.innerHTML = `<b>PHANTOM</b>${s ? `${esc(s.user)}@${esc(s.hostname)} · ${esc(s.distro)} · ${esc(s.cpuModel)} × ${s.cores}` : ''}`;
    hint.style.display = wm.windows.some((w) => w.visible) ? 'none' : '';
  };
  bus.on('wm:changed', upd); setTimeout(upd, 1500); upd();
}

// ───────── window switcher (Ctrl+Tab) ─────────
// Hold Ctrl and tap Tab to walk the windows of this workspace in most-recently-used order;
// release Ctrl to switch. Shift+Tab walks backwards, Esc cancels, a click picks directly.
let sw = null;
function switcherStep(dir) {
  if (!sw) {
    const cur = wm.windows.filter((w) => w.ws === wm.active && !w.closed);
    if (!cur.length) return;
    const list = [...wm.history].reverse().filter((w) => cur.includes(w));
    for (const w of [...cur].sort((a, b) => b.z - a.z)) if (!list.includes(w)) list.push(w);
    if (list.length === 1) { wm.restore(list[0]); wm.focus(list[0]); return; }
    sw = { list, i: 0, el: h('div.wswitch'), shown: false };
    sw.timer = setTimeout(() => { if (sw) { sw.shown = true; sw.el.classList.add('on'); } }, 120); // quick taps don't flash
    document.getElementById('overlay-root').appendChild(sw.el);
  }
  sw.i = (sw.i + dir + sw.list.length) % sw.list.length;
  renderSwitcher();
}
function renderSwitcher() {
  sw.el.innerHTML = '';
  sw.el.appendChild(h('div.wswitch-hd', `WINDOWS · workspace ${wm.active + 1}`, h('span.sp'), h('span.c-mute', 'Ctrl+Tab next · Shift back · release Ctrl to switch')));
  const grid = h('div.wswitch-grid');
  sw.list.forEach((w, i) => {
    const card = h('div.wswitch-it' + (i === sw.i ? '.on' : '') + (w.min ? '.min' : ''), { html: `<span class="ic">${icon(w.app.icon)}</span><b>${esc(w.title)}</b><span class="c-dim">${esc(w.sub || (w.min ? 'minimized' : w.app.title))}</span>` });
    card.addEventListener('mousedown', (e) => { e.preventDefault(); sw.i = i; switcherCommit(); });
    grid.appendChild(card);
  });
  sw.el.appendChild(grid);
}
function switcherCommit() {
  if (!sw) return;
  const w = sw.list[sw.i]; clearTimeout(sw.timer); sw.el.remove(); sw = null;
  if (w && !w.closed) { wm.restore(w); wm.focus(w); }
}
function switcherCancel() { if (!sw) return; clearTimeout(sw.timer); sw.el.remove(); sw = null; }

// ───────── keyboard ─────────
const overlayOpen = () => !!document.querySelector('#overlay-root .modal, #overlay-root .palette');
function keybindings() {
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey; const k = e.key;
    const f = wm.focused;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (sw) {
      if (k === 'Tab') { stop(); switcherStep(e.shiftKey ? -1 : 1); return; }
      if (k === 'Escape') { stop(); switcherCancel(); return; }
      if (k === 'Enter') { stop(); switcherCommit(); return; }
      if (k === 'ArrowRight' || k === 'ArrowDown') { stop(); switcherStep(1); return; }
      if (k === 'ArrowLeft' || k === 'ArrowUp') { stop(); switcherStep(-1); return; }
      if (k === 'Control' || k === 'Meta' || k === 'Shift') return;
      switcherCommit();
    }
    const plainCtrl = ctrl && !e.altKey;
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    // e.code = the physical key, so these also work with a Greek (or other non-Latin) layout active.
    const shiftKey = plainCtrl && e.shiftKey ? { KeyD: duplicateFocused, KeyR: closeAllButCode, KeyF: toggleFullscreenFocused, KeyH: () => wm.open('search') }[e.code] : null;
    if (plainCtrl && !e.shiftKey && digit) { stop(); if (!overlayOpen()) focusNth(Number(digit[1]) - 1); }
    else if (shiftKey) { stop(); if (!overlayOpen() && !e.repeat) shiftKey(); }
    else if (plainCtrl && k === 'Tab') { stop(); if (!overlayOpen()) switcherStep(e.shiftKey ? -1 : 1); }
    else if (plainCtrl && !e.shiftKey && (k === 'f' || k === 'F' || e.code === 'KeyF')) { stop(); if (!overlayOpen()) newFile().catch(fail); }
    else if (plainCtrl && !e.shiftKey && (k === 'w' || k === 'W' || e.code === 'KeyW')) { stop(); if (f && !overlayOpen()) wm.close(f); }
    else if (ctrl && e.shiftKey && (k === 'P' || k === 'p')) { stop(); commandPalette(); }
    else if (ctrl && !e.shiftKey && !e.altKey && (k === 'k' || k === 'K') && !(f && f.app.id === 'terminal')) { stop(); commandPalette(); }
    else if (ctrl && !e.shiftKey && !e.altKey && (k === 'p' || k === 'P')) { stop(); quickOpen(); }
    else if (ctrl && !e.shiftKey && (k === 'o' || k === 'O')) { stop(); pickProject(); }
    else if (ctrl && k === '`') { stop(); wm.open('terminal', { state: { cwd: project.root } }); }
    else if (ctrl && e.shiftKey && (k === 'E' || k === 'e')) { stop(); wm.open('explorer'); }
    else if (ctrl && e.shiftKey && (k === 'G' || k === 'g')) { stop(); wm.open('git'); }
    else if (ctrl && e.shiftKey && (k === 'L' || k === 'l')) { stop(); saveLayoutAs(); }
    else if (ctrl && e.shiftKey && (k === 'W' || k === 'w')) { stop(); if (f) wm.close(f); }
    else if (ctrl && k === ',') { stop(); wm.open('settings'); }
    else if (e.altKey && (k === '`' || e.code === 'Backquote')) { stop(); wm.cycle(e.shiftKey ? -1 : 1); }
    else if (k === 'F5') {
      if (ctrl && e.shiftKey) { stop(); run.restart(); }
      else if (e.shiftKey) { stop(); run.stop(); }
      else if (ctrl) { stop(); run.start({ debug: false }); }
      else if (!document.body.dataset.debugActive) { stop(); run.start({ debug: true }); }
      // with a live debug session, plain F5 falls through to the debugger (continue / pause)
    }
    else if (k === 'F11' && !document.body.dataset.debugPaused) { stop(); call('app:fullscreen'); }
    else if (ctrl && e.altKey && /^Digit[1-9]$/.test(e.code)) { stop(); const i = Number(e.code.slice(5)) - 1; if (e.shiftKey && f) wm.moveToWorkspace(f, i); else wm.switchWorkspace(i); }
    else if (ctrl && e.altKey && (k === 't' || k === 'T')) { stop(); wm.tile(); }
    else if (ctrl && e.altKey && (k === 'd' || k === 'D')) { stop(); wm.showDesktop(); }
    else if (ctrl && !e.shiftKey && f && k.startsWith('Arrow') && (e.altKey || (settings.ctrlArrowSnap && !overlayOpen() && !isFormField(e.target)))) {
      // Ctrl+arrows (like Win+arrows) and Ctrl+Alt+arrows: halves → quarters, ↑ maximize, ↓ restore / minimize.
      stop(); wm.arrowSnap(f, k);
    }
  }, true);
  document.addEventListener('keyup', (e) => { if (sw && (e.key === 'Control' || e.key === 'Meta')) switcherCommit(); }, true);
  addEventListener('blur', () => switcherCommit());
}
// Plain text boxes (filters, forms) keep Ctrl+arrow word jumps; Monaco and xterm don't count.
const isFormField = (t) => !!(t && t.matches && t.matches('input:not([type=checkbox]):not([type=range]), select, textarea.inp, textarea:not(.inputarea):not(.xterm-helper-textarea)'));

async function quit() {
  const dirty = dirtyDocs();
  if (dirty.length && !(await confirm('Unsaved changes', `${dirty.length} file(s) have unsaved changes:\n${dirty.map((d) => '  ' + d.name).join('\n')}\n\nQuit anyway?`, { danger: true, ok: 'QUIT' }))) return;
  bus.emit('wm:persist-now');
  setTimeout(() => call('app:close'), 120);
}

// ───────── boot ─────────
export async function boot() {
  const el = document.getElementById('boot');
  if (!settings.boot) return;
  el.classList.add('on');
  const pre = h('pre'); const logo = h('pre.logo');
  logo.textContent = [
    '██████╗ ██╗  ██╗ █████╗ ███╗   ██╗████████╗ ██████╗ ███╗   ███╗',
    '██╔══██╗██║  ██║██╔══██╗████╗  ██║╚══██╔══╝██╔═══██╗████╗ ████║',
    '██████╔╝███████║███████║██╔██╗ ██║   ██║   ██║   ██║██╔████╔██║',
    '██╔═══╝ ██╔══██║██╔══██║██║╚██╗██║   ██║   ██║   ██║██║╚██╔╝██║',
    '██║     ██║  ██║██║  ██║██║ ╚████║   ██║   ╚██████╔╝██║ ╚═╝ ██║',
    '╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝'
  ].join('\n');
  el.append(logo, pre, h('div.skip', 'press any key to skip'));
  let skip = false;
  const sk = () => { skip = true; };
  addEventListener('keydown', sk, { once: true }); el.addEventListener('click', sk, { once: true });
  const line = async (html, ms = 60) => { pre.innerHTML += html + '\n'; if (!skip) await new Promise((r) => setTimeout(r, ms)); };
  const [info, sys] = await Promise.all([call('app:info').catch(() => null), call('sys:static').catch(() => null)]);
  await line('<span class="dim">[ 0.000000]</span> phantom workstation kernel — interface layer v1.0');
  if (sys) {
    await line(`<span class="dim">[ 0.004113]</span> host      <span class="ok">${esc(sys.user)}@${esc(sys.hostname)}</span>  ${esc(sys.distro)}  ${esc(sys.kernel)} ${esc(sys.arch)}`);
    await line(`<span class="dim">[ 0.009260]</span> cpu       ${esc(sys.cpuModel)} × ${sys.cores}`);
    await line(`<span class="dim">[ 0.011507]</span> memory    ${bytes(sys.totalmem)}  telemetry:${esc(sys.backend)}`);
  }
  if (info) {
    const t = info.tools;
    const tag = (k, v) => `${k}:${v ? '<span class="ok">ok</span>' : '<span class="warn">--</span>'}`;
    await line(`<span class="dim">[ 0.020331]</span> toolchain ${tag('git', t.git)} ${tag('rg', t.rg)} ${tag('ssh', t.ssh)} ${tag('node', t.node)} ${tag('python', t.python)} ${tag('docker', t.docker)} ${tag('cargo', t.cargo)} ${tag('go', t.go)}`);
    await line(`<span class="dim">[ 0.024802]</span> runtime   electron ${esc(info.versions.electron || '-')} · chrome ${esc(info.versions.chrome || '-')} · node ${esc(info.versions.node)}`);
  }
  const pty = await call('pty:info').catch(() => null);
  if (pty) await line(`<span class="dim">[ 0.031177]</span> pty       ${pty.native ? '<span class="ok">node-pty native</span>' : '<span class="warn">bridge fallback</span> (' + esc(pty.error || '') + ')'}  shell ${esc(pty.defaultShell)}`);
  await line(`<span class="dim">[ 0.035000]</span> wm        ${wm.apps.size} tools registered · ${wm.workspaceCount()} workspaces · compositor online`);
  await line('<span class="ok">[  OK  ]</span> all systems nominal. welcome back.', 260);
  el.classList.add('out');
  setTimeout(() => el.remove(), 320);
}

let fsQueue = Promise.resolve(); let wasAppFullscreen = false;
bus.on('wm:fullscreen', (on) => {
  fsQueue = fsQueue.then(async () => {
    if (on) wasAppFullscreen = await call('app:fullscreen', true);
    else await call('app:fullscreen', !!wasAppFullscreen);
  }).catch(() => {});
});

export function initShell() {
  buildTopbar();
  buildDock();
  buildTaskbar();
  buildWallpaper();
  keybindings();
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input,textarea,.monaco-editor,.xterm,.sel-text')) return;
    e.preventDefault();
    if (e.target === document.getElementById('desktop') || e.target.id === 'wallpaper' || e.target.closest('#wallpaper')) {
      menu(e.clientX, e.clientY, [
        { header: 'DESKTOP' },
        { label: 'New terminal', key: 'Ctrl+`', action: () => wm.open('terminal', { state: { cwd: project.root } }) },
        { label: 'New editor', action: () => wm.open('editor') },
        { label: 'Command palette', key: 'Ctrl+Shift+P', action: commandPalette },
        '-',
        { label: 'Tile windows', action: () => wm.tile() },
        { label: 'Cascade windows', action: () => wm.cascade() },
        { label: 'Save layout…', action: saveLayoutAs },
        '-', { header: 'PRESETS' },
        ...Object.keys(PRESETS).map((n) => ({ label: n, action: () => applyPreset(n) }))
      ]);
    }
  });
}
