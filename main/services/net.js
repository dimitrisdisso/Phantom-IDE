'use strict';
// Socket / port inspection. Linux reads /proc/net/* and maps socket inodes to pids;
// other platforms use systeminformation (ss/netstat/lsof under the hood).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const netmod = require('net');

let si = null;
try { si = require('systeminformation'); } catch { /* optional */ }

const TCP_STATES = { '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING' };

function hexIp4(h) { return [3, 2, 1, 0].map((i) => parseInt(h.substr(i * 2, 2), 16)).join('.'); }
function hexIp6(h) {
  const words = [];
  for (let i = 0; i < 4; i++) {
    const w = h.substr(i * 8, 8);
    const le = w.match(/../g).reverse().join('');
    words.push(le.substr(0, 4), le.substr(4, 4));
  }
  const ws = words.map((x) => x.replace(/^0+(?=.)/, '').toLowerCase());
  if (ws.slice(0, 5).every((w) => w === '0') && ws[5] === 'ffff') return hexIp4(h.substr(24, 8));
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (ws[i] === '0') { let j = i; while (j < 8 && ws[j] === '0') j++; if (j - i > bestLen) { best = i; bestLen = j - i; } i = j; } else i++;
  }
  if (bestLen < 2) return ws.join(':');
  return ws.slice(0, best).join(':') + '::' + ws.slice(best + bestLen).join(':');
}

module.exports = (core) => {
  let inodeCache = { ts: 0, map: new Map() };
  let cache = { ts: 0, data: null };

  async function inodeMap() {
    if (Date.now() - inodeCache.ts < 8000) return inodeCache.map;
    const map = new Map();
    const pids = (await fsp.readdir('/proc')).filter((d) => /^\d+$/.test(d));
    await Promise.all(pids.map(async (pid) => {
      let fds;
      try { fds = await fsp.readdir(`/proc/${pid}/fd`); } catch { return; }
      let name = null;
      for (const fd of fds) {
        const l = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
        const m = /^socket:\[(\d+)\]$/.exec(l);
        if (m) {
          if (name === null) name = (await fsp.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '?')).trim();
          map.set(m[1], { pid: Number(pid), process: name });
        }
      }
    }));
    inodeCache = { ts: Date.now(), map };
    return map;
  }

  async function linuxConnections() {
    const imap = await inodeMap();
    const out = [];
    for (const proto of ['tcp', 'tcp6', 'udp', 'udp6']) {
      let txt;
      try { txt = await fsp.readFile(`/proc/net/${proto}`, 'utf8'); } catch { continue; }
      const v6 = proto.endsWith('6');
      for (const line of txt.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/); if (f.length < 10) continue;
        const [lip, lport] = f[1].split(':'); const [rip, rport] = f[2].split(':');
        const owner = imap.get(f[9]) || {};
        const isUdp = proto.startsWith('udp');
        out.push({
          proto: proto.replace('6', '') + (v6 ? '6' : ''),
          local: v6 ? hexIp6(lip) : hexIp4(lip), lport: parseInt(lport, 16),
          remote: v6 ? hexIp6(rip) : hexIp4(rip), rport: parseInt(rport, 16),
          state: isUdp ? (parseInt(rport, 16) === 0 ? 'LISTEN' : 'ESTABLISHED') : (TCP_STATES[f[3]] || f[3]),
          pid: owner.pid || null, process: owner.process || null
        });
      }
    }
    return out;
  }

  async function siConnections() {
    if (!si) return [];
    const c = await si.networkConnections();
    return c.map((x) => ({ proto: x.protocol, local: x.localAddress, lport: Number(x.localPort) || 0, remote: x.peerAddress, rport: Number(x.peerPort) || 0, state: (x.state || '').toUpperCase() || (x.protocol && x.protocol.startsWith('udp') ? 'LISTEN' : ''), pid: x.pid || null, process: x.process || null }));
  }

  async function connections() {
    if (cache.data && Date.now() - cache.ts < 1500) return cache.data;
    const data = process.platform === 'linux' ? await linuxConnections() : await siConnections();
    cache = { ts: Date.now(), data };
    return data;
  }
  core.netConnections = connections;

  return {
    'net:connections': connections,
    'net:interfaces': async () => {
      const out = [];
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) out.push({ iface: name, family: a.family, address: a.address, netmask: a.netmask, mac: a.mac, internal: a.internal, cidr: a.cidr });
      }
      return out;
    },
    // TCP connect probe, restricted to loopback so it can't be used as a network scanner.
    'net:probe': async (port, host = '127.0.0.1') => {
      port = Number(port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Probes are limited to loopback');
      const t0 = Date.now();
      return new Promise((resolve) => {
        const s = netmod.connect({ port, host, timeout: 1500 });
        s.once('connect', () => { s.destroy(); resolve({ open: true, ms: Date.now() - t0 }); });
        s.once('timeout', () => { s.destroy(); resolve({ open: false, ms: Date.now() - t0, error: 'timeout' }); });
        s.once('error', (e) => resolve({ open: false, ms: Date.now() - t0, error: e.code }));
      });
    }
  };
};
