'use strict';
// Live CPU / memory / disk / network telemetry. Uses `systeminformation` when present
// and falls back to os + /proc on Linux. Snapshots are cached & de-duplicated so many
// monitor windows can poll without multiplying cost.
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;

let si = null;
try { si = require('systeminformation'); } catch { /* optional */ }

module.exports = (core) => {
  let prevCpu = os.cpus();
  let prevNet = null; // {ts, map: iface -> {rx, tx}}
  let prevDisk = null; // {ts, read, write} (bytes)
  let fsCache = { ts: 0, data: [] };
  let tempCache = { ts: 0, data: null };
  let inflight = null;
  let last = null;

  function cpuLoad() {
    const now = os.cpus();
    const cores = now.map((c, i) => {
      const p = (prevCpu[i] || c).times; const t = c.times;
      const total = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
      const idle = t.idle - p.idle;
      return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
    });
    prevCpu = now;
    const load = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0;
    return { load, cores, speed: now[0] ? now[0].speed : 0 };
  }

  async function memInfo() {
    if (process.platform === 'linux') {
      try {
        const txt = await fsp.readFile('/proc/meminfo', 'utf8');
        const m = {};
        for (const line of txt.split('\n')) { const r = /^(\w+):\s+(\d+)/.exec(line); if (r) m[r[1]] = Number(r[2]) * 1024; }
        const total = m.MemTotal; const available = m.MemAvailable ?? m.MemFree;
        return { total, available, used: total - available, cached: (m.Cached || 0) + (m.Buffers || 0), swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) };
      } catch { /* fall through */ }
    }
    if (si) {
      const m = await si.mem();
      return { total: m.total, available: m.available, used: m.active, cached: m.buffcache, swapTotal: m.swaptotal, swapUsed: m.swapused };
    }
    const total = os.totalmem(); const free = os.freemem();
    return { total, available: free, used: total - free, cached: 0, swapTotal: 0, swapUsed: 0 };
  }

  async function netStats() {
    const now = Date.now();
    let map = null;
    if (process.platform === 'linux') {
      try {
        const txt = await fsp.readFile('/proc/net/dev', 'utf8');
        map = {};
        for (const line of txt.split('\n').slice(2)) {
          const m = /^\s*([^:]+):\s*(.*)$/.exec(line); if (!m) continue;
          const f = m[2].trim().split(/\s+/).map(Number);
          map[m[1]] = { rx: f[0], tx: f[8] };
        }
      } catch { map = null; }
    }
    if (!map && si) {
      try {
        const st = await si.networkStats('*');
        return st.map((s) => ({ iface: s.iface, rx_sec: Math.max(0, s.rx_sec || 0), tx_sec: Math.max(0, s.tx_sec || 0), rx_bytes: s.rx_bytes, tx_bytes: s.tx_bytes, state: s.operstate }));
      } catch { return []; }
    }
    if (!map) return [];
    const out = [];
    const dt = prevNet ? (now - prevNet.ts) / 1000 : 0;
    for (const [iface, v] of Object.entries(map)) {
      const p = prevNet && prevNet.map[iface];
      out.push({ iface, rx_bytes: v.rx, tx_bytes: v.tx, rx_sec: p && dt > 0 ? Math.max(0, (v.rx - p.rx) / dt) : 0, tx_sec: p && dt > 0 ? Math.max(0, (v.tx - p.tx) / dt) : 0, state: null });
    }
    prevNet = { ts: now, map };
    return out;
  }

  async function diskIO() {
    const now = Date.now();
    let read = null; let write = null;
    if (process.platform === 'linux') {
      try {
        const txt = await fsp.readFile('/proc/diskstats', 'utf8');
        read = 0; write = 0;
        for (const line of txt.split('\n')) {
          const f = line.trim().split(/\s+/); if (f.length < 14) continue;
          const name = f[2];
          // whole devices only (skip partitions, loop, ram)
          if (/^(loop|ram|zram|dm-|sr)/.test(name)) continue;
          if (/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)\d+$/.test(name) || /^nvme\d+n\d+p\d+$/.test(name) || /^mmcblk\d+p\d+$/.test(name)) continue;
          read += Number(f[5]) * 512; write += Number(f[9]) * 512;
        }
      } catch { read = null; }
    } else if (si) {
      try { const s = await si.fsStats(); if (s) return { rx_sec: Math.max(0, s.rx_sec || 0), wx_sec: Math.max(0, s.wx_sec || 0) }; } catch { /* ignore */ }
    }
    if (read === null) return { rx_sec: 0, wx_sec: 0 };
    const p = prevDisk; prevDisk = { ts: now, read, write };
    if (!p) return { rx_sec: 0, wx_sec: 0 };
    const dt = (now - p.ts) / 1000 || 1;
    return { rx_sec: Math.max(0, (read - p.read) / dt), wx_sec: Math.max(0, (write - p.write) / dt) };
  }

  async function fsSize() {
    if (Date.now() - fsCache.ts < 10000) return fsCache.data;
    let data = [];
    if (si) {
      try { data = (await si.fsSize()).map((d) => ({ mount: d.mount, fs: d.fs, type: d.type, size: d.size, used: d.used, use: d.use })); } catch { data = []; }
    }
    if (!data.length && fsp.statfs) {
      const mounts = new Set([process.platform === 'win32' ? 'C:\\' : '/', os.homedir()]);
      if (process.platform === 'linux') {
        try {
          const txt = await fsp.readFile('/proc/mounts', 'utf8');
          for (const l of txt.split('\n')) { const f = l.split(' '); if (f[0] && f[0].startsWith('/dev/') && !f[1].startsWith('/snap')) mounts.add(f[1].replace(/\\040/g, ' ')); }
        } catch { /* ignore */ }
      }
      const seen = new Set();
      for (const m of mounts) {
        try {
          const s = await fsp.statfs(m);
          const size = s.blocks * s.bsize; const free = s.bavail * s.bsize;
          const key = `${s.blocks}:${s.bfree}`; if (seen.has(key)) continue; seen.add(key);
          if (size > 0) data.push({ mount: m, fs: '', type: '', size, used: size - free, use: 100 * (size - free) / size });
        } catch { /* ignore */ }
      }
    }
    fsCache = { ts: Date.now(), data };
    return data;
  }

  async function temps() {
    if (!si || Date.now() - tempCache.ts < 5000) return tempCache.data;
    try { const t = await si.cpuTemperature(); tempCache = { ts: Date.now(), data: t && t.main > 0 ? { main: t.main, max: t.max } : null }; } catch { tempCache = { ts: Date.now(), data: null }; }
    return tempCache.data;
  }

  async function snapshot() {
    const [mem, net, disk, fsz, temp] = await Promise.all([memInfo(), netStats(), diskIO(), fsSize(), temps()]);
    const cpu = cpuLoad();
    const physical = net.filter((n) => n.iface !== 'lo' && !/^(lo\d*|Loopback)/i.test(n.iface));
    return {
      ts: Date.now(),
      cpu,
      mem,
      load: os.loadavg(),
      uptime: os.uptime(),
      net: { ifaces: net, rx_sec: physical.reduce((a, n) => a + n.rx_sec, 0), tx_sec: physical.reduce((a, n) => a + n.tx_sec, 0) },
      disk,
      fs: fsz,
      temp
    };
  }

  async function osRelease() {
    if (si) { try { const o = await si.osInfo(); return `${o.distro} ${o.release}`.trim(); } catch { /* ignore */ } }
    try {
      const txt = await fsp.readFile('/etc/os-release', 'utf8');
      const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(txt); if (m) return m[1];
    } catch { /* ignore */ }
    return `${os.type()} ${os.release()}`;
  }

  return {
    'sys:static': async () => {
      const cpus = os.cpus();
      return {
        hostname: os.hostname(), user: os.userInfo().username, platform: process.platform, arch: os.arch(),
        kernel: os.release(), distro: await osRelease(), cpuModel: cpus[0] ? cpus[0].model.trim() : 'unknown',
        cores: cpus.length, totalmem: os.totalmem(), backend: si ? 'systeminformation' : 'native'
      };
    },
    'sys:snapshot': async () => {
      // De-dupe: concurrent callers share one sample; samples younger than 800ms are reused.
      if (last && Date.now() - last.ts < 800) return last;
      if (!inflight) inflight = snapshot().then((s) => { last = s; return s; }).finally(() => { inflight = null; });
      return inflight;
    }
  };
};
