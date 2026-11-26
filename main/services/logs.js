'use strict';
// `tail -f` for arbitrary log files, handling truncation/rotation.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { abs, walk } = require('../util');

module.exports = (core) => {
  const tails = new Map();
  let next = 1;
  core.onShutdown(() => { for (const t of tails.values()) t.stop(); });

  return {
    'logs:tail': async (file, initialBytes = 65536) => {
      file = abs(file);
      const st = await fsp.stat(file);
      if (st.isDirectory()) throw new Error('Is a directory');
      const id = next++;
      let pos = Math.max(0, st.size - Math.min(Number(initialBytes) || 65536, 4 * 1024 * 1024));
      let reading = false; let again = false; let partial = '';
      const read = async () => {
        if (reading) { again = true; return; }
        reading = true;
        try {
          const s = await fsp.stat(file);
          if (s.size < pos) { pos = 0; core.emit('logs:lines', { id, lines: ['── file truncated / rotated ──'], reset: false }); }
          if (s.size > pos) {
            const fh = await fsp.open(file, 'r');
            try {
              const len = Math.min(s.size - pos, 8 * 1024 * 1024);
              const buf = Buffer.alloc(len);
              await fh.read(buf, 0, len, pos);
              pos += len;
              const text = partial + buf.toString('utf8');
              const lines = text.split(/\r?\n/);
              partial = lines.pop();
              if (lines.length) core.emit('logs:lines', { id, lines });
            } finally { await fh.close(); }
          }
        } catch (e) { core.emit('logs:lines', { id, lines: [`[phantom] ${e.message}`] }); }
        reading = false;
        if (again) { again = false; read(); }
      };
      let watcher = null;
      try { watcher = fs.watch(file, { persistent: false }, () => read()); } catch { /* fall back to polling */ }
      const poll = setInterval(read, watcher ? 2000 : 750);
      tails.set(id, { stop: () => { clearInterval(poll); if (watcher) watcher.close(); } });
      setImmediate(read);
      return { id, file, size: st.size };
    },
    'logs:untail': async (id) => { const t = tails.get(id); if (t) { t.stop(); tails.delete(id); } return true; },
    'logs:discover': async (root) => {
      root = abs(root);
      const files = await walk(root, { maxFiles: 20000, filter: (_f, n) => /\.log(\.\d+)?$|^npm-debug|^yarn-error/.test(n) });
      const sys = process.platform === 'linux' ? ['/var/log/syslog', '/var/log/messages', '/var/log/auth.log', '/var/log/kern.log'] : process.platform === 'darwin' ? ['/var/log/system.log', '/var/log/install.log'] : [];
      const avail = [];
      for (const f of sys) { try { await fsp.access(f, fs.constants.R_OK); avail.push(f); } catch { /* unreadable */ } }
      return { project: files.slice(0, 200).map((f) => ({ path: f, name: path.relative(root, f) })), system: avail };
    }
  };
};
