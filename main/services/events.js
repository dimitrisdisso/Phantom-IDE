'use strict';
// Live system event stream. Aggregates events from other services (FS, GIT, PTY, TASK,
// DEBUG, SEC…) and, while at least one subscriber exists, actively monitors process
// spawn/exit, listening-port changes and resource pressure.
const os = require('os');

module.exports = (core) => {
  let subs = 0;
  let timers = [];
  let prevPids = null;
  let prevListen = null;
  let pressure = { cpu: 0, mem: false };
  let prevCpu = os.cpus();
  const ring = [];

  const push = (ev) => {
    const e = { ts: Date.now(), source: ev.source || 'SYS', level: ev.level || 'info', message: ev.message, data: ev.data };
    ring.push(e);
    if (ring.length > 1000) ring.shift();
    core.emit('events:event', e);
  };
  core.bus.on('event', push);

  async function procTick() {
    if (!core.procList) return;
    let procs; try { procs = await core.procList(); } catch { return; }
    const now = new Map(procs.map((p) => [p.pid, p]));
    if (prevPids) {
      let spawned = 0; let exited = 0;
      for (const [pid, p] of now) if (!prevPids.has(pid)) { if (++spawned <= 8) push({ source: 'PROC', message: `spawn  pid ${pid} ${p.name} (${p.user})`, data: { pid } }); }
      for (const [pid, p] of prevPids) if (!now.has(pid)) { if (++exited <= 8) push({ source: 'PROC', message: `exit   pid ${pid} ${p.name}`, data: { pid } }); }
      if (spawned > 8) push({ source: 'PROC', message: `+${spawned - 8} more processes spawned` });
      if (exited > 8) push({ source: 'PROC', message: `+${exited - 8} more processes exited` });
    }
    prevPids = now;
  }

  async function netTick() {
    if (!core.netConnections) return;
    let conns; try { conns = await core.netConnections(); } catch { return; }
    const listen = new Map();
    for (const c of conns) if (c.state === 'LISTEN') listen.set(`${c.proto}:${c.local}:${c.lport}`, c);
    if (prevListen) {
      for (const [k, c] of listen) if (!prevListen.has(k)) push({ source: 'NET', level: 'warn', message: `port opened  ${c.proto.toUpperCase()} ${c.local}:${c.lport}${c.process ? ` by ${c.process} (${c.pid})` : ''}` });
      for (const [k, c] of prevListen) if (!listen.has(k)) push({ source: 'NET', message: `port closed  ${c.proto.toUpperCase()} ${c.local}:${c.lport}` });
    }
    prevListen = listen;
  }

  function pressureTick() {
    const cpus = os.cpus();
    let idle = 0; let total = 0;
    cpus.forEach((c, i) => { const p = (prevCpu[i] || c).times; for (const k of Object.keys(c.times)) total += c.times[k] - p[k]; idle += c.times.idle - p.idle; });
    prevCpu = cpus;
    const load = total ? 100 * (1 - idle / total) : 0;
    pressure.cpu = load > 90 ? pressure.cpu + 1 : 0;
    if (pressure.cpu === 3) push({ source: 'SYS', level: 'warn', message: `CPU saturated: ${load.toFixed(0)}% for >15s` });
    const memUse = 1 - os.freemem() / os.totalmem();
    const high = process.platform === 'linux' ? false : memUse > 0.92; // Linux freemem excludes cache; sys service reports real pressure
    if (high && !pressure.mem) push({ source: 'SYS', level: 'warn', message: `memory pressure: ${(memUse * 100).toFixed(0)}% used` });
    pressure.mem = high;
  }

  function start() {
    prevPids = null; prevListen = null;
    timers = [setInterval(procTick, 3000), setInterval(netTick, 5000), setInterval(pressureTick, 5000)];
    procTick(); netTick();
    push({ source: 'SYS', message: 'event monitors armed: process, network, pressure' });
  }
  function stop() { timers.forEach(clearInterval); timers = []; }
  core.onShutdown(stop);

  return {
    'events:subscribe': async () => { if (subs++ === 0) start(); return ring.slice(-300); },
    'events:unsubscribe': async () => { subs = Math.max(0, subs - 1); if (subs === 0) stop(); return true; },
    'events:recent': async () => ring.slice(-300)
  };
};
