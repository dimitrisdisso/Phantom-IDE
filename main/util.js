'use strict';
// Shared helpers for PHANTOM backend services. No Electron imports here so
// services can be exercised from plain Node (see tools/backend-test.js).
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  'target', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage', '.cache',
  '.turbo', '.svelte-kit', '.parcel-cache', 'bower_components', '.gradle', '.terraform',
  '.pytest_cache', '.mypy_cache', '.tox', 'Pods', 'DerivedData'
]);

function abs(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('Invalid path');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

/** execFile wrapper that never rejects. */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(opts.env || {}) };
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: opts.timeout || 0, ...opts, env }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : -1;
      resolve({
        code,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        missing: !!(err && err.code === 'ENOENT'),
        killed: !!(err && err.killed)
      });
    });
  });
}

const whichCache = new Map();
function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  let found = null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) { found = p; break; } } catch { /* not here */ }
    }
    if (found) break;
  }
  whichCache.set(cmd, found);
  return found;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Iterative directory walk that skips heavy/generated folders and symlinked dirs. */
async function walk(root, { maxFiles = 30000, maxDepth = 25, includeDirs = false, filter } = {}) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length && out.length < maxFiles) {
    const [dir, depth] = stack.pop();
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || depth >= maxDepth) continue;
        if (includeDirs) out.push({ path: full, dir: true });
        stack.push([full, depth + 1]);
      } else if (e.isFile()) {
        if (filter && !filter(full, e.name)) continue;
        out.push(includeDirs ? { path: full, dir: false } : full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function readJson(p, fallback = null) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
}

async function writeJsonAtomic(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p);
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}

module.exports = { IGNORE_DIRS, abs, run, which, isBinary, walk, exists, readJson, writeJsonAtomic, stripAnsi };
