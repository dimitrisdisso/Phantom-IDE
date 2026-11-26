// Named workspaces, each with its own folder. Switching workspace shows its windows AND mounts its
// folder as the project, so the explorer, Ctrl+F (new file), new terminals, search and Git all work
// inside that folder. The list is saved in the store; the folders are ordinary folders on disk.
import { call, bus } from './api.js';
import { wm } from './wm.js';
import { project, openProject } from './project.js';
import { prompt, confirm, choice, toast, fail } from './ui.js';
import { basename, join } from './dom.js';

export const spaces = []; // [{ name, folder }]  (index = the window manager's workspace number)

let queue = Promise.resolve();
let applying = false; // true while a switch is mounting a folder (not a user "Open folder")
let started = false;

const defaultName = (i) => `Workspace ${i + 1}`;
const save = () => call('store:set', 'workspaces', spaces).catch(() => {});
const changed = () => bus.emit('ws:changed');
export const nameOf = (i) => (spaces[i] && spaces[i].name) || defaultName(i);

/** Load the saved list. Must run before windows are restored (it sets how many workspaces exist). */
export async function initWorkspaces() {
  const saved = await call('store:get', 'workspaces', null).catch(() => null);
  const list = Array.isArray(saved) && saved.length
    ? saved.slice(0, wm.maxWorkspaces()).map((s, i) => ({ name: String((s && s.name) || defaultName(i)).slice(0, 40), folder: (s && s.folder) || null }))
    : [0, 1, 2, 3].map((i) => ({ name: defaultName(i), folder: null }));
  spaces.splice(0, spaces.length, ...list);
  wm.setWorkspaceCount(spaces.length);
  wm.label = nameOf;
  changed();
}

/** Mount the active workspace's folder (or give a folder-less workspace the current one). */
export function syncWorkspace({ announce = false } = {}) {
  queue = queue.then(async () => {
    const i = wm.active; const sp = spaces[i];
    if (!sp) return;
    if (!sp.folder) { if (project.root) { sp.folder = project.root; save(); } }
    else if (sp.folder !== project.root) {
      if (!(await call('fs:exists', sp.folder).catch(() => false))) {
        toast(`The folder of "${sp.name}" is missing:\n${sp.folder}\nRight-click its number in the top bar to choose another.`, 'warn', 'WORKSPACE');
      } else {
        applying = true;
        try { await openProject(sp.folder, { silent: true }); } finally { applying = false; }
      }
    }
    changed();
    if (announce && i === wm.active) toast(sp.folder ? `${sp.name}  ·  ${sp.folder}` : sp.name, 'info', `WORKSPACE ${i + 1}`, 1800);
  }).catch((e) => fail(e, 'WORKSPACE'));
  return queue;
}

/** Start following switches and folder changes (call once the session has been restored). */
export async function startWorkspaces() {
  if (started) return;
  started = true;
  bus.on('wm:workspace', () => syncWorkspace({ announce: true }));
  // "Open folder" while on a workspace makes that folder the workspace's folder.
  bus.on('project:changed', (root) => {
    const sp = spaces[wm.active];
    if (!applying && sp && sp.folder !== root) { sp.folder = root; save(); changed(); }
  });
  // Workspaces without a folder start on the project that's open now, so visiting one later never
  // makes it silently adopt another workspace's folder.
  if (project.root) { for (const sp of spaces) if (!sp.folder) sp.folder = project.root; save(); }
  await syncWorkspace();
}

const safeFolderName = (n) => n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim() || 'workspace';

async function pickFolder(title, fallback) {
  try { return await call('fs:pickFolder', title); }
  catch { return prompt(title, fallback || project.home || '', { label: 'Absolute path to a folder', select: false }); }
}

/** Ask for a name and a folder (new or existing), add the workspace and switch to it. Returns its index or null. */
export async function newWorkspace() {
  if (spaces.length >= wm.maxWorkspaces()) { toast(`You can have up to ${wm.maxWorkspaces()} workspaces. Delete one first (right-click its number).`, 'warn', 'WORKSPACE'); return null; }
  const typed = await prompt('New workspace', defaultName(spaces.length), { label: 'Name it, e.g. "School", "Website" or "Game". It gets its own folder for its files.' });
  if (typed === null) return null;
  const name = typed.trim().slice(0, 40) || defaultName(spaces.length);
  const base = join(project.home, 'PHANTOM Workspaces');
  const fresh = join(base, safeFolderName(name));
  const how = await choice(`Folder for "${name}"`, `CREATE NEW FOLDER makes:\n${fresh}\n\nOr use a folder you already have.`, [
    { label: 'CANCEL', value: null }, { label: 'USE EXISTING FOLDER', value: 'pick' }, { label: 'CREATE NEW FOLDER', value: 'new', cls: 'primary' }
  ]);
  if (!how) return null;
  let folder = fresh;
  try {
    if (how === 'pick') { folder = await pickFolder(`Folder for "${name}"`); if (!folder) return null; folder = folder.trim(); }
    else await call('fs:mkdir', fresh);
    folder = (await call('fs:stat', folder)).path;
  } catch (e) { fail(e, 'WORKSPACE'); return null; }
  spaces.push({ name, folder });
  wm.setWorkspaceCount(spaces.length);
  save(); changed();
  const i = spaces.length - 1;
  wm.switchWorkspace(i);
  await queue;
  return i;
}

export async function renameWorkspace(i) {
  const sp = spaces[i]; if (!sp) return;
  const n = await prompt('Rename workspace', sp.name, { label: sp.folder ? `Folder stays: ${sp.folder}` : '' });
  if (n === null || !n.trim()) return;
  sp.name = n.trim().slice(0, 40); save(); changed(); wm.changed('meta');
}

export async function setWorkspaceFolder(i) {
  const sp = spaces[i]; if (!sp) return;
  const dir = await pickFolder(`Folder for "${sp.name}"`, sp.folder);
  if (!dir) return;
  try { sp.folder = (await call('fs:stat', dir.trim())).path; } catch (e) { fail(e, 'WORKSPACE'); return; }
  save(); changed();
  if (i === wm.active) await syncWorkspace({ announce: true });
}

export async function deleteWorkspace(i) {
  const sp = spaces[i]; if (!sp) return;
  if (spaces.length <= 1) { toast('The last workspace can\'t be deleted', 'warn', 'WORKSPACE'); return; }
  const n = wm.windows.filter((w) => w.ws === i).length;
  if (!(await confirm('Delete workspace', `Delete "${sp.name}"?${n ? ` Its ${n} window${n > 1 ? 's' : ''} will close.` : ''}\n\n${sp.folder ? `The folder and its files stay on disk:\n${basename(sp.folder)}  (${sp.folder})` : 'No files are deleted.'}`, { danger: true, ok: 'DELETE' }))) return;
  if (!(await wm.removeWorkspace(i))) return;
  spaces.splice(i, 1);
  // Names that were never customised follow their new number.
  spaces.forEach((s, k) => { if (/^Workspace \d+$/.test(s.name)) s.name = defaultName(k); });
  save(); changed(); wm.changed('meta');
  await syncWorkspace({ announce: true });
}
