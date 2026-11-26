'use strict';
// Project file watcher. Uses native recursive watching on macOS/Windows; on Linux
// builds a per-directory inotify tree that skips heavy folders (node_modules, .git…).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { abs, IGNORE_DIRS } = require('../util');

const MAX_DIRS = 8000;

module.exports = (core) => {
  const roots = new Map(); // root -> { refs, close(), pending:Set, timer }

  function flush(root, st) {
    st.timer = null;
    const paths = [...st.pending];
    st.pending.clear();
    if (!paths.length) return;
    core.emit('fs:changed', { root, paths });
    core.bus.emit('fs:changed', { root, paths });
    const shown = paths.slice(0, 5);
    for (const p of shown) {
      const rel = path.relative(root, p);
      if (rel.startsWith('.git' + path.sep) || rel === '.git') core.event('GIT', `repository state changed: ${rel}`);
      else core.event('FS', `modified ${rel}`);
    }
    if (paths.length > shown.length) core.event('FS', `+${paths.length - shown.length} more changes`);
  }

  function queue(root, st, p) {
    st.pending.add(p);
    if (!st.timer) st.timer = setTimeout(() => flush(root, st), 150);
  }

  async function linuxTree(root, st) {
    const watchers = new Map();
    const addDir = async (dir) => {
      if (watchers.size >= MAX_DIRS || watchers.has(dir)) return;
      let w;
      try {
        w = fs.watch(dir, { persistent: false }, (_type, name) => {
          if (!name) return;
          const full = path.join(dir, name.toString());
          queue(root, st, full);
          // A new directory appeared: start watching it too.
          fsp.stat(full).then((s) => { if (s.isDirectory() && !IGNORE_DIRS.has(path.basename(full))) addDir(full); }).catch(() => {
            const old = watchers.get(full); if (old) { old.close(); watchers.delete(full); }
          });
        });
        w.on('error', () => { w.close(); watchers.delete(dir); });
      } catch { return; }
      watchers.set(dir, w);
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* gone */ }
      for (const e of ents) if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) await addDir(path.join(dir, e.name));
    };
    await addDir(root);
    if (watchers.size >= MAX_DIRS) core.log('warn', `watcher capped at ${MAX_DIRS} directories for ${root}`, 'FS');
    return () => { for (const w of watchers.values()) w.close(); watchers.clear(); };
  }

  function watchGitDir(root, st) {
    const g = path.join(root, '.git');
    try {
      const w = fs.watch(g, { persistent: false }, (_t, name) => {
        if (!name) return;
        const n = name.toString();
        if (n === 'HEAD' || n === 'index' || n === 'FETCH_HEAD' || n === 'ORIG_HEAD') queue(root, st, path.join(g, n));
      });
      w.on('error', () => w.close());
      return () => w.close();
    } catch { return () => {}; }
  }

  return {
    'watch:start': async (root) => {
      root = abs(root);
      const existing = roots.get(root);
      if (existing) { existing.refs++; return true; }
      const st = { refs: 1, pending: new Set(), timer: null, closers: [] };
      roots.set(root, st);
      if (process.platform === 'linux') {
        st.closers.push(await linuxTree(root, st));
      } else {
        try {
          const w = fs.watch(root, { recursive: true, persistent: false }, (_t, name) => {
            if (!name) return;
            const rel = name.toString();
            if (/(^|[\\/])node_modules([\\/]|$)/.test(rel)) return;
            if (/(^|[\\/])\.git[\\/]/.test(rel) && !/\.git[\\/](HEAD|index)$/.test(rel)) return;
            queue(root, st, path.join(root, rel));
          });
          w.on('error', (e) => core.log('warn', 'watch error: ' + e.message, 'FS'));
          st.closers.push(() => w.close());
        } catch (e) { core.log('warn', 'watch failed: ' + e.message, 'FS'); }
      }
      st.closers.push(watchGitDir(root, st));
      core.log('info', `watching ${root}`, 'FS');
      return true;
    },
    'watch:stop': async (root) => {
      root = abs(root);
      const st = roots.get(root);
      if (!st) return false;
      if (--st.refs > 0) return true;
      st.closers.forEach((c) => c());
      if (st.timer) clearTimeout(st.timer);
      roots.delete(root);
      return true;
    }
  };
};
