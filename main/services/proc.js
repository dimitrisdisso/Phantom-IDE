'use strict';
// Process inspection & control. Linux: reads /proc directly and computes *current* CPU%
// from tick deltas. macOS/BSD: `ps`. Windows: systeminformation.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { run } = require('../util');

let si = null;
try { si = require('systeminformation'); } catch { /* optional */ }

const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGSTOP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2']);
const HZ = 100; // USER_HZ is 100 on all mainstream Linux builds
const PAGE = 4096;

module.exports = (core) => {
  let users = null;
  let prev = new Map(); // pid -> ticks
  let prevTs = 0;
  let cache = { ts: 0, data: null };
  let inflight = null;
  const ncpu = os.cpus().length || 1;

  async function userMap() {
    if (users) return users;
    users = new Map();
    try {
      for (const l of (await fsp.readFile('/etc/passwd', 'utf8')).split('\n')) { const f = l.split(':'); if (f.length > 2) users.set(f[2], f[0]); }
    } catch { /* ignore */ }
    return users;
  }

  async function linuxList() {
    const umap = await userMap();
    const now = Date.now();
    const dt = prevTs ? (now - prevTs) / 1000 : 0;
    const memTotal = os.totalmem();
    const pids = (await fsp.readdir('/proc')).filter((d) => /^\d+$/.test(d));
    const next = new Map();
    const procs = [];
    await Promise.all(pids.map(async (pid) => {
      try {
        const [stat, status, cmdline] = await Promise.all([
          fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
          fsp.readFile(`/proc/${pid}/status`, 'utf8'),
          fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
        ]);
        const r = stat.lastIndexOf(')');
        const name = stat.slice(stat.indexOf('(') + 1, r);
        const f = stat.slice(r + 2).split(' ');
        const ticks = Number(f[11]) + Number(f[12]);
        const rss = Number(f[21]) * PAGE;
        const uid = (/^Uid:\s+(\d+)/m.exec(status) || [])[1];
        const threads = Number((/^Threads:\s+(\d+)/m.exec(status) || [])[1] || 1);
        const p = prev.get(pid);
        next.set(pid, ticks);
        procs.push({
          pid: Number(pid), ppid: Number(f[1]), name, state: f[0], threads,
          user: umap.get(uid) || uid || '?',
          cpu: p !== undefined && dt > 0 ? Math.max(0, ((ticks - p) / HZ / dt) * 100) : 0,
          mem: memTotal ? (rss / memTotal) * 100 : 0,
          rss,
          command: cmdline.replace(/\0+$/, '').replace(/\0/g, ' ') || `[${name}]`
        });
      } catch { /* process exited mid-read */ }
    }));
    prev = next; prevTs = now;
    return procs;
  }

  async function psList() {
    const [a, b] = await Promise.all([
      run('ps', ['-axo', 'pid=,ppid=,user=,pcpu=,pmem=,rss=,stat=,args=']),
      run('ps', ['-axo', 'pid=,comm='])
    ]);
    const names = new Map();
    for (const l of b.stdout.split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (m) names.set(m[1], m[2].split('/').pop()); }
    const out = [];
    for (const l of a.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      if (!m) continue;
      out.push({ pid: +m[1], ppid: +m[2], user: m[3], cpu: +m[4], mem: +m[5], rss: +m[6] * 1024, state: m[7], name: names.get(m[1]) || m[8].split(' ')[0].split('/').pop(), command: m[8], threads: null });
    }
    return out;
  }

  async function siList() {
    const r = await si.processes();
    return r.list.map((p) => ({ pid: p.pid, ppid: p.parentPid, user: p.user, cpu: p.cpu, mem: p.mem, rss: (p.memRss || 0) * 1024, state: p.state, name: p.name, command: [p.path, p.command, p.params].filter(Boolean).join(' ') || p.name, threads: null }));
  }

  async function list() {
    if (process.platform === 'linux') return linuxList();
    if (process.platform === 'win32' && si) return siList();
    return psList();
  }

  // Lets the event stream detect process spawn/exit.
  core.procList = async () => (await getList()).procs;

  async function getList() {
    if (cache.data && Date.now() - cache.ts < 1200) return cache.data;
    if (!inflight) {
      inflight = list().then((procs) => {
        const data = { ts: Date.now(), procs, total: procs.length, running: procs.filter((p) => /^R/.test(p.state || '')).length, self: process.pid };
        cache = { ts: Date.now(), data };
        return data;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  const friendly = (e, pid) => {
    if (e && e.code === 'EPERM') return new Error(`Access denied for pid ${pid}: it belongs to another user or to the system. Run PHANTOM as administrator to end it.`);
    if (e && e.code === 'ESRCH') return new Error(`Process ${pid} has already exited`);
    return e;
  };
  // PHANTOM's own process and everything above it (killing an ancestor's tree would take PHANTOM down).
  async function protectedPids(procs) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out = new Set([process.pid]);
    let cur = byPid.get(process.pid); let guard = 0;
    while (cur && cur.ppid && guard++ < 64) { out.add(cur.ppid); cur = byPid.get(cur.ppid); }
    if (process.ppid) out.add(process.ppid);
    return out;
  }
  function descendants(procs, root) {
    const kids = new Map();
    for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
    const out = []; const seen = new Set([root]); const stack = [root];
    while (stack.length) { const x = stack.pop(); for (const c of kids.get(x) || []) if (!seen.has(c)) { seen.add(c); out.push(c); stack.push(c); } }
    return out;
  }

  return {
    'proc:list': getList,
    'proc:kill': async (pid, signal = 'SIGTERM') => {
      pid = Number(pid);
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid pid');
      if (pid === process.pid) throw new Error('Refusing to signal PHANTOM itself');
      if (!SIGNALS.has(signal)) throw new Error('Unsupported signal');
      if (process.platform === 'win32' && !['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal)) throw new Error(`${signal} is not available on Windows — use End process`);
      try { process.kill(pid, signal); } catch (e) { throw friendly(e, pid); }
      cache.ts = 0;
      core.event('PROC', `sent ${signal} to pid ${pid}`, 'warn');
      return true;
    },
    // End a process together with every process it started.
    'proc:killTree': async (pid) => {
      pid = Number(pid);
      if (!Number.isInteger(pid) || pid <= 4) throw new Error('Invalid pid');
      const procs = (await getList()).procs;
      const prot = await protectedPids(procs);
      if (prot.has(pid)) throw new Error('Refusing: PHANTOM itself runs inside this process tree');
      const kids = descendants(procs, pid);
      if (kids.some((k) => prot.has(k))) throw new Error('Refusing: PHANTOM itself runs inside this process tree');
      if (process.platform === 'win32') {
        const r = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 });
        if (r.code !== 0) {
          const msg = (r.stderr || r.stdout).trim();
          if (/access is denied/i.test(msg)) throw new Error(`Access denied for pid ${pid}: it belongs to another user or to the system. Run PHANTOM as administrator to end it.`);
          if (/not found/i.test(msg)) throw new Error(`Process ${pid} has already exited`);
          throw new Error(msg || `taskkill failed (${r.code})`);
        }
      } else {
        for (const k of [...kids].reverse()) { try { process.kill(k, 'SIGTERM'); } catch { /* gone */ } }
        try { process.kill(pid, 'SIGTERM'); } catch (e) { throw friendly(e, pid); }
      }
      cache.ts = 0;
      core.event('PROC', `ended process tree of pid ${pid} (${kids.length + 1} processes)`, 'warn');
      return kids.length + 1;
    },
    'proc:details': async (pid) => {
      pid = Number(pid);
      if (!Number.isInteger(pid)) throw new Error('Invalid pid');
      const d = { pid };
      if (process.platform === 'linux') {
        d.cwd = await fsp.readlink(`/proc/${pid}/cwd`).catch(() => null);
        d.exe = await fsp.readlink(`/proc/${pid}/exe`).catch(() => null);
        d.fds = await fsp.readdir(`/proc/${pid}/fd`).then((x) => x.length).catch(() => null);
        try {
          const st = (await fsp.readFile(`/proc/${pid}/stat`, 'utf8'));
          const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
          const uptime = Number((await fsp.readFile('/proc/uptime', 'utf8')).split(' ')[0]);
          d.started = Date.now() - (uptime - Number(f[19]) / HZ) * 1000;
        } catch { /* ignore */ }
        try {
          const io = await fsp.readFile(`/proc/${pid}/io`, 'utf8');
          d.readBytes = Number((/read_bytes:\s+(\d+)/.exec(io) || [])[1]);
          d.writeBytes = Number((/^write_bytes:\s+(\d+)/m.exec(io) || [])[1]);
        } catch { /* permission */ }
      } else if (process.platform !== 'win32') {
        const r = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: 2000 });
        const l = r.stdout.split('\n').find((x) => x.startsWith('n')); d.cwd = l ? l.slice(1) : null;
      }
      return d;
    }
  };
};
