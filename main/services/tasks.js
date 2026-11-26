'use strict';
// Build/test task detection and execution with streamed output.
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { abs, run, exists, which } = require('../util');

module.exports = (core) => {
  const runs = new Map();
  let next = 1;
  core.onShutdown(() => { for (const r of runs.values()) killTree(r.child); });

  function killTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') run('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } } }
  }

  async function detect(root) {
    root = abs(root);
    const tasks = [];
    const pj = path.join(root, 'package.json');
    if (await exists(pj)) {
      try {
        const j = JSON.parse(await fsp.readFile(pj, 'utf8'));
        const pm = (await exists(path.join(root, 'pnpm-lock.yaml'))) ? 'pnpm' : (await exists(path.join(root, 'yarn.lock'))) ? 'yarn' : (await exists(path.join(root, 'bun.lockb'))) ? 'bun' : 'npm';
        for (const [name, cmd] of Object.entries(j.scripts || {})) tasks.push({ group: pm, name, command: `${pm} run ${name}`, detail: cmd, kind: /test|spec|e2e/i.test(name) ? 'test' : /build|compile|bundle|tsc/i.test(name) ? 'build' : /lint|format|check/i.test(name) ? 'lint' : 'run' });
        if (!j.scripts || !j.scripts.install) tasks.push({ group: pm, name: 'install', command: `${pm} install`, detail: 'install dependencies', kind: 'setup' });
      } catch { /* bad json */ }
    }
    const mk = ['Makefile', 'makefile', 'GNUmakefile'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
    if (mk) {
      const txt = await fsp.readFile(mk, 'utf8');
      const seen = new Set();
      for (const m of txt.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)) if (!seen.has(m[1]) && !m[1].startsWith('.')) { seen.add(m[1]); tasks.push({ group: 'make', name: m[1], command: `make ${m[1]}`, kind: /test/.test(m[1]) ? 'test' : /build|all/.test(m[1]) ? 'build' : 'run' }); }
    }
    if (await exists(path.join(root, 'Cargo.toml'))) for (const n of ['build', 'test', 'run', 'clippy', 'check']) tasks.push({ group: 'cargo', name: n, command: `cargo ${n}`, kind: n === 'test' ? 'test' : n === 'build' ? 'build' : 'run' });
    if (await exists(path.join(root, 'go.mod'))) { tasks.push({ group: 'go', name: 'build', command: 'go build ./...', kind: 'build' }, { group: 'go', name: 'test', command: 'go test ./...', kind: 'test' }, { group: 'go', name: 'vet', command: 'go vet ./...', kind: 'lint' }); }
    if (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'requirements.txt')) || await exists(path.join(root, 'setup.py'))) {
      const py = which('python3') ? 'python3' : 'python';
      tasks.push({ group: 'python', name: 'pytest', command: `${py} -m pytest`, kind: 'test' }, { group: 'python', name: 'unittest', command: `${py} -m unittest discover`, kind: 'test' });
    }
    if (await exists(path.join(root, 'docker-compose.yml')) || await exists(path.join(root, 'compose.yaml'))) tasks.push({ group: 'docker', name: 'compose up', command: 'docker compose up --build', kind: 'run' }, { group: 'docker', name: 'compose down', command: 'docker compose down', kind: 'run' });
    if (await exists(path.join(root, 'Dockerfile'))) tasks.push({ group: 'docker', name: 'build image', command: `docker build -t ${path.basename(root).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')} .`, kind: 'build' });
    return tasks;
  }

  async function detectTests(root) {
    root = abs(root);
    const pj = path.join(root, 'package.json');
    if (await exists(pj)) {
      try {
        const j = JSON.parse(await fsp.readFile(pj, 'utf8'));
        const deps = { ...j.dependencies, ...j.devDependencies };
        const fw = deps.vitest ? 'vitest' : deps.jest ? 'jest' : deps.mocha ? 'mocha' : deps.ava ? 'ava' : (j.scripts && /node --test/.test(j.scripts.test || '')) ? 'node:test' : 'npm';
        const pm = (await exists(path.join(root, 'pnpm-lock.yaml'))) ? 'pnpm' : (await exists(path.join(root, 'yarn.lock'))) ? 'yarn' : 'npm';
        if (j.scripts && j.scripts.test && !/no test specified/.test(j.scripts.test)) return { framework: fw, command: fw === 'vitest' ? `${pm === 'npm' ? 'npx' : pm} vitest run` : `${pm} test` };
        if (fw === 'vitest') return { framework: fw, command: 'npx vitest run' };
        if (fw === 'jest') return { framework: fw, command: 'npx jest' };
      } catch { /* ignore */ }
    }
    if (await exists(path.join(root, 'Cargo.toml'))) return { framework: 'cargo', command: 'cargo test' };
    if (await exists(path.join(root, 'go.mod'))) return { framework: 'go', command: 'go test ./...' };
    if (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'pytest.ini')) || await exists(path.join(root, 'tests')) || await exists(path.join(root, 'setup.py'))) return { framework: 'pytest', command: `${which('python3') ? 'python3' : 'python'} -m pytest -q` };
    return { framework: null, command: '' };
  }

  return {
    'tasks:detect': detect,
    'tasks:detectTests': detectTests,
    'tasks:run': async ({ root, command, label, env } = {}) => {
      if (typeof command !== 'string' || !command.trim()) throw new Error('Command required');
      const cwd = abs(root);
      const runId = next++;
      const e = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(env || {}) };
      delete e.ELECTRON_RUN_AS_NODE;
      // shell:true is deliberate — this is a user-authored command from their own project, like a terminal.
      const child = spawn(command, { cwd, env: e, shell: true, detached: process.platform !== 'win32', windowsHide: true });
      const r = { runId, child, command, label: label || command, started: Date.now() };
      runs.set(runId, r);
      const out = (stream) => (d) => core.emit('tasks:output', { runId, stream, data: d.toString('utf8') });
      child.stdout.on('data', out('stdout'));
      child.stderr.on('data', out('stderr'));
      child.on('error', (err) => core.emit('tasks:output', { runId, stream: 'stderr', data: `\n[phantom] ${err.message}\n` }));
      child.on('close', (code, signal) => {
        runs.delete(runId);
        const ms = Date.now() - r.started;
        core.emit('tasks:exit', { runId, code, signal, ms });
        core.event('TASK', `${r.label} ${code === 0 ? 'succeeded' : `failed (${signal || code})`} in ${(ms / 1000).toFixed(1)}s`, code === 0 ? 'info' : 'error');
      });
      core.event('TASK', `started: ${r.label} (pid ${child.pid})`);
      return { runId, pid: child.pid, started: r.started };
    },
    'tasks:kill': async (runId) => { const r = runs.get(runId); if (r) killTree(r.child); return !!r; },
    'tasks:running': async () => [...runs.values()].map((r) => ({ runId: r.runId, label: r.label, command: r.command, started: r.started }))
  };
};
