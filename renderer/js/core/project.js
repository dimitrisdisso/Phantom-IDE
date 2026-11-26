// Active project (workspace root) state: watcher, git root, recents.
import { call, on, bus } from './api.js';
import { prompt, toast, fail } from './ui.js';
import { basename } from './dom.js';

export const project = { root: null, name: null, gitRoot: null, branch: null, recent: [], home: null, files: null };

let filesPromise = null;

export async function initProject() {
  const info = await call('fs:home');
  project.home = info.home;
  project.recent = (await call('store:get', 'recent', [])) || [];
  on('fs:changed', (p) => {
    if (p.root !== project.root) return;
    if (p.paths.some((x) => /[\\/]\.git[\\/](HEAD|index)$/.test(x))) refreshGit();
    if (p.paths.some((x) => !/[\\/]\.git[\\/]/.test(x))) filesPromise = null;
    bus.emit('fs:changed', p.paths);
  });
}

export async function refreshGit() {
  if (!project.root) return;
  try {
    project.gitRoot = await call('git:root', project.root);
    project.branch = project.gitRoot ? (await call('git:status', project.gitRoot)).branch : null;
  } catch { project.gitRoot = null; project.branch = null; }
  bus.emit('git:changed');
  bus.emit('project:meta');
}

export async function openProject(root, { silent = false } = {}) {
  if (!root) return;
  try {
    const st = await call('fs:stat', root);
    if (!st.dir) throw new Error('Not a directory');
    root = st.path;
  } catch (e) { if (!silent) fail(e, 'OPEN PROJECT'); return; }
  if (project.root === root) return;
  if (project.root) call('watch:stop', project.root).catch(() => {});
  project.root = root; project.name = basename(root); filesPromise = null;
  call('watch:start', root).catch((e) => toast('file watching unavailable: ' + e.message, 'warn'));
  project.recent = [root, ...project.recent.filter((r) => r !== root)].slice(0, 12);
  call('store:set', 'recent', project.recent).catch(() => {});
  await refreshGit();
  bus.emit('project:changed', root);
  if (!silent) toast(root, 'info', 'PROJECT MOUNTED', 2200);
}

export async function pickProject() {
  let dir = null;
  try { dir = await call('fs:pickFolder', 'Open project folder'); }
  catch { dir = await prompt('Open project folder', project.root || project.home || '', { label: 'Absolute path to a directory', select: false }); }
  if (dir) await openProject(dir.trim());
}

/** Cached project file list (relative paths) for quick-open. */
export function projectFiles() {
  if (!project.root) return Promise.resolve([]);
  if (!filesPromise) filesPromise = call('fs:walk', project.root, 50000).catch(() => []);
  return filesPromise;
}
