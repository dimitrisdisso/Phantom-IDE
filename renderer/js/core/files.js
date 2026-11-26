// File helpers shared by the shell (Ctrl+F) and the editor: create a named file, rename an open file.
import { call, bus } from './api.js';
import { project } from './project.js';
import { prompt, toast, fail } from './ui.js';
import { basename, dirname, join } from './dom.js';
import * as run from './run.js';
import * as live from './collab.js';

const isAbs = (p) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
const BAD = /[<>:"|?*\x00-\x1f]/;

function checkName(name) {
  if (!name) return 'Type a file name, e.g. main.py';
  const parts = name.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (!last || /[\\/]$/.test(name)) return 'The name ends with a slash — add a file name after it';
  for (const p of isAbs(name) ? parts.slice(1) : parts) if (BAD.test(p)) return `"${p}" contains a character that file names can't use ( < > : " | ? * )`;
  if (/[. ]$/.test(last) && window.phantom && window.phantom.platform === 'win32') return 'Windows file names can\'t end with a dot or a space';
  return null;
}

async function uniqueUntitled(base) {
  for (let i = 0; i < 200; i++) {
    const n = i ? `untitled-${i}.txt` : 'untitled.txt';
    if (!(await call('fs:exists', join(base, n)).catch(() => false))) return n;
  }
  return `untitled-${Date.now()}.txt`;
}

/** Where a new file goes: the project, else the active file's folder, else ask. */
async function targetFolder() {
  if (project.root) return project.root;
  const f = run.activeFile();
  if (f && !live.isCollabPath(f)) return dirname(f);
  try { return await call('fs:pickFolder', 'Choose a folder for the new file'); } catch { return null; }
}

/** Ctrl+F: ask for a name (with any extension), create the empty file and open it in the editor. */
export async function newFile() {
  const base = await targetFolder();
  if (!base) return null;
  let name = await uniqueUntitled(base);
  for (;;) {
    const n = await prompt('New file', name, { label: `Type the name and extension (main.py, index.html, notes.md…). Created in ${base} — use / for subfolders.`, placeholder: 'name.ext' });
    if (n === null) return null;
    name = n.trim();
    const bad = checkName(name);
    if (bad) { toast(bad, 'warn', 'NEW FILE'); if (!name) return null; continue; }
    const p = isAbs(name) ? name : join(base, name);
    try { await call('fs:createFile', p); }
    catch (e) {
      if (/EEXIST|exists/i.test(e.message)) { toast(`${basename(p)} already exists — pick another name`, 'warn', 'NEW FILE'); continue; }
      fail(e, 'NEW FILE'); return null;
    }
    bus.emit('open-file', p, {});
    toast(`created ${basename(p)}`, 'info', 'NEW FILE', 1600);
    return p;
  }
}

/** Ask for a new name/extension for a file on disk; returns the new path or null. */
export async function askRename(p) {
  if (live.isCollabPath(p)) { toast('a file shared by someone else can\'t be renamed', 'warn'); return null; }
  if (live.liveDocFor(p)) { toast('stop sharing the file before renaming it', 'warn'); return null; }
  for (;;) {
    const n = await prompt('Rename file', basename(p), { label: `Change the name and/or the extension. In ${dirname(p)}` });
    if (n === null) return null;
    const name = n.trim();
    if (!name || name === basename(p)) return null;
    const bad = checkName(name) || (/[\\/]/.test(name) ? 'Use a plain file name here (no slashes)' : null);
    if (bad) { toast(bad, 'warn', 'RENAME'); continue; }
    return join(dirname(p), name);
  }
}
