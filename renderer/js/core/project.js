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

const flat = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** A repository rooted at the home folder (or above) doesn't count for a project somewhere inside it:
 *  "git status" there walks the whole user profile, and it isn't the project's repository anyway. */
function isOuterRepo(gitRoot, root) {
  const g = flat(gitRoot); const r = flat(root); const home = flat(project.home);
  return !!home && r !== g && (g === home || home.startsWith(g + '/'));
}

export async function refreshGit() {
  const root = project.root;
  if (!root) return;
  let gitRoot = null; let branch = null;
  try {
    gitRoot = await call('git:root', root);
    if (gitRoot && isOuterRepo(gitRoot, root)) gitRoot = null;
    if (gitRoot) branch = (await call('git:status', gitRoot)).branch;
  } catch { gitRoot = null; branch = null; }
  if (project.root !== root) return; // switched project while Git was working
  project.gitRoot = gitRoot; project.branch = branch;
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
  project.gitRoot = null; project.branch = null;
  call('watch:start', root).catch((e) => toast('file watching unavailable: ' + e.message, 'warn'));
  project.recent = [root, ...project.recent.filter((r) => r !== root)].slice(0, 12);
  call('store:set', 'recent', project.recent).catch(() => {});
  bus.emit('project:changed', root);
  refreshGit(); // in the background: a slow repository must not delay opening the folder
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
