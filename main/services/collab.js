'use strict';
// Real-time collaboration. One PHANTOM hosts a session; others join with just the session code.
// Two transports, tried in parallel, same protocol on top:
//   • internet (peer-to-peer): the code derives a 32-byte "topic"; the host announces it on the public
//     Hyperswarm DHT and guests look it up. The DHT hole-punches through both routers, so nobody needs
//     port forwarding, a VPN or a server of their own.
//   • direct TCP (port 7457) for an optional typed address on the same network.
// The session code is never sent: it derives an AES-256-GCM key (scrypt), so every frame is
// encrypted + authenticated and a wrong code simply cannot talk to the host. The topic uses a
// different salt, so seeing it on the DHT reveals nothing about the code or the key.
// The host is the authority for document state (operational transformation, see shared/ot.js).
const net = require('net');
let Hyperswarm = null;
try { Hyperswarm = require('hyperswarm'); } catch { /* optional: same-network only */ }
const P2P_ENABLED = () => !!Hyperswarm && process.env.PHANTOM_P2P !== '0';
const P2P_TIMEOUT = Number(process.env.PHANTOM_P2P_TIMEOUT) || 30000;
const dgram = require('dgram');
const { run } = require('../util');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { TextOperation, OTServer } = require(path.join(__dirname, '..', '..', 'renderer', 'js', 'shared', 'ot.js'));

const DEFAULT_PORT = 7457;
const DISCOVERY_PORT = 7458; // UDP: guests broadcast a probe, hosts answer with name + TCP port (never the code)
const PROBE = 'PHANTOM-DISCOVER-1';
const FAIL_LIMIT = 5; const FAIL_WINDOW = 60 * 1000;
const MAX_FRAME = 24 * 1024 * 1024;
const MAX_DOC = 10 * 1024 * 1024;
const MAX_PEERS = 8;
const PALETTE = 6;
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanName = (n, fb) => (String(n || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 32) || fb);

function newCode() {
  const b = crypto.randomBytes(16); let s = '';
  for (let i = 0; i < 16; i++) s += B32[b[i] % 32];
  return s.match(/.{4}/g).join('-'); // 80 bits
}
const deriveKey = (code) => crypto.scryptSync(normCode(code), 'phantom-collab-v1', 32, { N: 16384, r: 8, p: 1 });
const deriveTopic = (code) => crypto.scryptSync(normCode(code), 'phantom-collab-topic-v1', 32, { N: 16384, r: 8, p: 1 });

/** Guest side: find the host of `topic` on the DHT. Resolves with the first connection. */
function p2pConnect(swarm, topic, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (done) return; done = true; reject(new Error('No session found on the internet for this code. Check the code, and that the host has START SESSION running and is online.')); }, ms);
    swarm.on('connection', (conn) => {
      conn.on('error', () => {});
      if (done) { conn.destroy(); return; } // only one host per code
      done = true; clearTimeout(timer);
      swarm.leave(topic).catch(() => {});
      resolve({ socket: conn, host: 'internet', port: 0, via: 'p2p' });
    });
    try { swarm.join(topic, { server: false, client: true }); swarm.flush().catch(() => {}); }
    catch (e) { done = true; clearTimeout(timer); reject(e); }
  });
}
/** First attempt to succeed wins; any later winner is closed. Rejects with the most useful error. */
function firstOf(attempts) {
  return new Promise((resolve, reject) => {
    let settled = false; let left = attempts.length; const errs = [];
    attempts.forEach((p, i) => p.then((r) => {
      if (settled) { try { r.socket.destroy(); } catch { /* gone */ } return; }
      settled = true; resolve(r);
    }, (e) => {
      errs[i] = e;
      if (--left === 0 && !settled) { settled = true; reject(errs.length > 1 ? new Error(errs.map((x) => x.message).join('\n\n')) : errs[0]); }
    }));
  });
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const body = Buffer.concat([iv, c.getAuthTag(), ct]);
  const hdr = Buffer.alloc(4); hdr.writeUInt32BE(body.length);
  return Buffer.concat([hdr, body]);
}
function unseal(key, body) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, 12));
  d.setAuthTag(body.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(body.subarray(28)), d.final()]).toString('utf8'));
}
function framer(socket, onFrame) {
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (n > MAX_FRAME || n < 29) { socket.destroy(); return; }
      if (buf.length < 4 + n) break;
      const body = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n);
      onFrame(body);
    }
  });
}
// Rank this computer's addresses so the one a collaborator can actually reach comes first.
// 169.254.x.x (link-local / "no DHCP") addresses are never reachable from another computer, so they
// are dropped; virtual adapters (Hyper-V, WSL, VirtualBox, Wi-Fi Direct…) go last.
function classify(iface, ip) {
  if (/^169\.254\./.test(ip)) return null;
  const n = iface.toLowerCase();
  const vpn = /tailscale|zerotier|hamachi|wireguard|nordlynx|radmin|openvpn|\bwg\d|\btun\d|utun/.test(n) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  const virtual = !vpn && /vethernet|virtualbox|vbox|vmware|vmnet|hyper-v|wsl|docker|loopback|bluetooth|local area connection\*|isatap|teredo|npcap|virbr|^veth|^br-|^lxc|^lxd/.test(n);
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const kind = vpn ? 'vpn' : virtual ? 'virtual' : priv ? 'lan' : 'public';
  const phys = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/.test(n) ? 0 : 1;
  return { kind, rank: { lan: 0, vpn: 2, public: 3, virtual: 5 }[kind] + (kind === 'lan' ? phys : 0) };
}
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const c = classify(name, a.address); if (!c) continue;
      out.push({ iface: name, address: a.address, kind: c.kind, rank: c.rank, netmask: a.netmask });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map(({ rank, ...r }) => r);
}
function broadcastTargets() {
  const out = new Set(['255.255.255.255', '127.0.0.1']);
  for (const a of lanAddresses()) {
    if (a.kind !== 'lan' || !a.netmask) continue;
    const ip = a.address.split('.').map(Number); const m = a.netmask.split('.').map(Number);
    out.add(ip.map((b, i) => (b & m[i]) | (~m[i] & 255)).join('.'));
  }
  return [...out];
}
/** Parse "1.2.3.4:7457, host2 or [::1]:9000" into [{host, port}]. */
function parseTargets(text) {
  const out = []; const seen = new Set();
  for (const raw of String(text || '').split(/\s*(?:,|;|\s+or\s+|\s+)\s*/i)) {
    if (!raw) continue;
    const m = /^(?:\[([^\]]+)\]|([^:\s[\]]+))(?::(\d+))?$/.exec(raw.trim());
    if (!m) throw new Error(`"${raw}" is not an address. It should look like 192.168.1.20 or 192.168.1.20:7457`);
    const host = m[1] || m[2]; const port = Number(m[3]) || DEFAULT_PORT;
    if (port < 1 || port > 65535) throw new Error(`Bad port in "${raw}"`);
    if (/^169\.254\./.test(host)) continue; // link-local: can never work, skip it
    const k = host + ':' + port; if (!seen.has(k)) { seen.add(k); out.push({ host, port }); }
  }
  if (!out.length) throw new Error("Type the host's address, e.g. 192.168.1.20 (the host can copy it from their Live Session window), or use FIND SESSIONS");
  return out.slice(0, 8);
}
/** Connect to every candidate at once; the first that answers wins and the rest are dropped. */
function connectFirst(targets, timeoutMs) {
  return new Promise((resolve, reject) => {
    const results = new Map(); let done = false; const socks = [];
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(win) {
      if (done) return; done = true; clearTimeout(timer);
      for (const x of socks) if (!win || x !== win.socket) { x.removeAllListeners(); x.on('error', () => {}); x.destroy(); }
      if (win) { win.socket.removeAllListeners('error'); return resolve(win); }
      const parts = targets.map((t) => `${t.host}:${t.port} ${results.get(t) || 'no answer'}`);
      const refused = targets.some((t) => results.get(t) === 'refused the connection');
      const silent = targets.every((t) => !results.get(t) || results.get(t) === 'no answer');
      const hint = refused ? 'That computer answered but no session is running on that port. Check that the host pressed START SESSION and that the port matches.'
        : silent ? "Nothing answered. This is almost always the host's firewall: on the HOST computer open Live Session and click ALLOW THROUGH FIREWALL. Also check that both computers are on the same Wi-Fi/network (or the same Tailscale/ZeroTier network), then try FIND SESSIONS."
          : 'Check the address and that both computers are on the same network.';
      reject(new Error(`Could not reach the host (${parts.join('; ')}). ${hint}`));
    }
    for (const t of targets) {
      const sock = net.connect({ host: t.host, port: t.port });
      socks.push(sock);
      sock.once('connect', () => { results.set(t, 'ok'); finish({ socket: sock, host: t.host, port: t.port }); });
      sock.once('error', (e) => {
        results.set(t, e.code === 'ECONNREFUSED' ? 'refused the connection' : e.code === 'ENOTFOUND' ? 'unknown host name' : (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') ? 'unreachable from this network' : e.code === 'ETIMEDOUT' ? 'no answer' : e.message);
        if (targets.every((x) => results.has(x))) finish(null);
      });
    }
  });
}

// ───────── Windows firewall ─────────
// Windows blocks inbound connections to a program until it is allowed. If the "allow access" prompt
// was missed or cancelled, Windows silently adds a BLOCK rule, so guests just time out. We add an
// explicit allow rule for this executable (TCP + UDP, every network profile) behind a UAC prompt.
const FW_NAME = () => 'PHANTOM Live Session ' + crypto.createHash('sha1').update(process.execPath.toLowerCase()).digest('hex').slice(0, 8);
const b64ps = (script) => Buffer.from(script, 'utf16le').toString('base64');
const psq = (v) => "'" + String(v).replace(/'/g, "''") + "'";
async function firewallStatus() {
  if (process.platform !== 'win32') return { supported: false };
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FW_NAME()}`], { timeout: 10000 });
  return { supported: true, allowed: r.code === 0 };
}
async function allowFirewall() {
  if (process.platform !== 'win32') throw new Error('Only needed on Windows');
  const inner = [
    "$ErrorActionPreference = 'Stop'",
    `$p = ${psq(process.execPath)}`,
    `$n = ${psq(FW_NAME())}`,
    'try {',
    "  Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue",
    '  Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue',
    "  New-NetFirewallRule -DisplayName $n -Direction Inbound -Program $p -Action Allow -Profile Any -Description 'Lets other computers join PHANTOM live sessions (TCP 7457 and LAN discovery UDP 7458).' | Out-Null",
    '  exit 0',
    '} catch { exit 2 }'
  ].join('\n');
  const outer = `try { $pr = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${b64ps(inner)}'; exit $pr.ExitCode } catch { exit 1223 }`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64ps(outer)], { timeout: 120000 });
  if (r.code === 1223) throw new Error('Windows did not get permission (the administrator prompt was cancelled)');
  if (r.code !== 0) throw new Error(`Could not add the firewall rule (code ${r.code}). ${(r.stderr || '').trim().slice(0, 300)}`);
  const st = await firewallStatus();
  if (!st.allowed) throw new Error('The firewall rule was not created');
  return st;
}

module.exports = (core) => {
  let s = null; // active session
  const toUI = (msg) => core.emit('collab:msg', msg);
  core.onShutdown(() => leave('PHANTOM closed'));

  // ───────── host side ─────────
  const peerInfo = (p) => ({ id: p.id, name: p.name, color: p.color, host: p.id === 'host' });
  const peerList = () => [peerInfo(s.me), ...[...s.peers.values()].filter((p) => p.ready).map(peerInfo)];
  const docList = () => [...s.docs.values()].map((d) => ({ id: d.id, name: d.name, owner: d.owner, ownerName: d.owner === s.me.id ? s.me.name : (s.peers.get(d.owner) || {}).name || '?' }));
  function deliver(peerId, msg) {
    if (peerId === s.me.id) return toUI(msg);
    const p = s.peers.get(peerId);
    if (p && p.ready && !p.socket.destroyed) p.socket.write(seal(s.key, msg));
  }
  function broadcast(msg, except) {
    if (except !== s.me.id) toUI(msg);
    for (const p of s.peers.values()) if (p.id !== except && p.ready && !p.socket.destroyed) p.socket.write(seal(s.key, msg));
  }
  function nameOf(id) { return id === s.me.id ? s.me.name : (s.peers.get(id) || {}).name || '?'; }

  function handle(from, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    const d = typeof msg.id === 'string' ? s.docs.get(msg.id) : null;
    switch (msg.type) {
      case 'share': {
        if (typeof msg.id !== 'string' || msg.id.length > 64 || typeof msg.text !== 'string' || msg.text.length > MAX_DOC) return deliver(from, { type: 'error', message: 'invalid share' });
        if (s.docs.has(msg.id)) return;
        s.docs.set(msg.id, { id: msg.id, name: cleanName(msg.name, 'untitled').slice(0, 200), owner: from, ot: new OTServer(msg.text), eol: msg.eol === 'CRLF' ? 'CRLF' : 'LF' });
        deliver(from, { type: 'shared', id: msg.id, rev: 0 });
        broadcast({ type: 'docs', docs: docList() });
        core.event('COLLAB', `${nameOf(from)} shared ${msg.name}`);
        return;
      }
      case 'unshare': {
        if (!d || (d.owner !== from && from !== s.me.id)) return;
        s.docs.delete(d.id);
        broadcast({ type: 'unshared', id: d.id });
        broadcast({ type: 'docs', docs: docList() });
        return;
      }
      case 'open': {
        if (!d) return deliver(from, { type: 'error', message: 'that file is no longer shared' });
        return deliver(from, { type: 'doc', id: d.id, name: d.name, text: d.ot.text, rev: d.ot.revision, eol: d.eol, owner: d.owner });
      }
      case 'op': {
        if (!d) return;
        let applied;
        try { applied = d.ot.receive(msg.rev, TextOperation.fromJSON(msg.op, MAX_DOC)); }
        catch (e) { return deliver(from, { type: 'resync', id: d.id, text: d.ot.text, rev: d.ot.revision, reason: e.message }); }
        if (d.ot.text.length > MAX_DOC) { d.ot.history.pop(); return deliver(from, { type: 'error', message: 'document too large' }); }
        deliver(from, { type: 'ack', id: d.id });
        broadcast({ type: 'op', id: d.id, op: applied.toJSON(), author: from }, from);
        return;
      }
      case 'cursor': {
        if (!d || !Number.isInteger(msg.anchor) || !Number.isInteger(msg.head)) return;
        broadcast({ type: 'cursor', id: d.id, peer: from, anchor: msg.anchor, head: msg.head }, from);
        return;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 2000).trim();
        if (text) broadcast({ type: 'chat', peer: from, name: nameOf(from), text, ts: Date.now() });
        return;
      }
      case 'save': {
        if (d) deliver(d.owner, { type: 'save', id: d.id, by: from, byName: nameOf(from) });
        return;
      }
      default:
    }
  }

  function acceptSocket(socket) {
    // TCP sockets have remoteAddress; peer-to-peer streams expose the UDP endpoint on rawStream.
    const ip = socket.remoteAddress || (socket.rawStream && socket.rawStream.remoteHost) || 'p2p';
    socket.on('error', () => {});
    const f0 = s.fails.get(ip);
    if (f0 && f0.n >= FAIL_LIMIT && Date.now() - f0.t < FAIL_WINDOW) { socket.destroy(); return; }
    if (s.peers.size >= MAX_PEERS) { socket.destroy(); return; }
    if (socket.setNoDelay) { socket.setNoDelay(true); socket.setKeepAlive(true, 15000); }
    const peer = { id: crypto.randomBytes(4).toString('hex'), socket, ready: false, ip, name: '?', color: 1 };
    s.peers.set(peer.id, peer);
    const helloTimer = setTimeout(() => { if (!peer.ready) socket.destroy(); }, 10000);
    framer(socket, (body) => {
      let msg;
      try { msg = unseal(s.key, body); }
      catch {
        const f = s.fails.get(ip); const fresh = !f || Date.now() - f.t > FAIL_WINDOW;
        s.fails.set(ip, { n: fresh ? 1 : f.n + 1, t: Date.now() });
        core.event('SEC', `collab: rejected connection from ${ip} (wrong session code)`, 'warn');
        socket.destroy(); return;
      }
      if (!peer.ready) {
        if (msg.type !== 'hello') { socket.destroy(); return; }
        clearTimeout(helloTimer);
        const used = new Set([s.me.color, ...[...s.peers.values()].filter((p) => p.ready).map((p) => p.color)]);
        peer.color = [...Array(PALETTE).keys()].find((c) => !used.has(c)) ?? (s.peers.size % PALETTE);
        peer.name = cleanName(msg.name, 'guest-' + peer.id.slice(0, 3));
        peer.ready = true;
        socket.write(seal(s.key, { type: 'welcome', me: peerInfo(peer), peers: peerList(), docs: docList(), hostName: s.me.name }));
        broadcast({ type: 'peers', peers: peerList() }, peer.id);
        broadcast({ type: 'joined', peer: peerInfo(peer) }, peer.id);
        core.event('COLLAB', `${peer.name} joined from ${ip}`);
        return;
      }
      handle(peer.id, msg);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (!s || !s.peers.has(peer.id)) return;
      s.peers.delete(peer.id);
      if (peer.ready) {
        broadcast({ type: 'peers', peers: peerList() });
        broadcast({ type: 'left', peer: peerInfo(peer) });
        core.event('COLLAB', `${peer.name} left`);
      }
    });
  }

  // Announce the session on the internet DHT under the code's topic; guests who know the code find us.
  function startSwarmHost(sess, code) {
    const setState = (st, error) => { if (s !== sess || sess.p2p === st) return; sess.p2p = st; toUI({ type: 'p2p', state: st, error }); };
    try {
      const swarm = new Hyperswarm();
      sess.swarm = swarm;
      swarm.on('connection', (conn) => { if (s !== sess) { conn.on('error', () => {}); conn.destroy(); return; } acceptSocket(conn); });
      const slow = setTimeout(() => setState('error', 'Could not reach the peer-to-peer network yet (no internet, or UDP is blocked). Still trying; same-network joining works meanwhile.'), 25000);
      swarm.join(deriveTopic(code), { server: true, client: false }).flushed()
        .then(() => { clearTimeout(slow); setState('online'); core.event('COLLAB', 'session reachable over the internet'); },
          (e) => { clearTimeout(slow); setState('error', e.message); });
    } catch (e) { setState('error', e.message); }
  }

  // Answer LAN discovery probes so guests can find this session without typing an address.
  function startResponder(sess) {
    try {
      const u = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      u.on('error', (e) => { core.log('warn', 'collab discovery: ' + e.message, 'COLLAB'); try { u.close(); } catch { /* closed */ } });
      u.on('message', (msg, rinfo) => {
        if (s !== sess || msg.toString('utf8') !== PROBE) return;
        const reply = Buffer.from(JSON.stringify({ t: 'phantom-session', v: 1, name: sess.me.name, host: os.hostname(), port: sess.port, peers: [...sess.peers.values()].filter((x) => x.ready).length + 1 }));
        u.send(reply, rinfo.port, rinfo.address, () => {});
      });
      u.bind(DISCOVERY_PORT);
      return u;
    } catch (e) { core.log('warn', 'collab discovery: ' + e.message, 'COLLAB'); return null; }
  }

  // ───────── guest side ─────────
  function guestFrames(socket, key, onWelcome) {
    framer(socket, (body) => {
      let msg;
      try { msg = unseal(key, body); } catch { socket.destroy(); return; }
      if (msg.type === 'welcome' && onWelcome) { const f = onWelcome; onWelcome = null; f(msg); return; }
      toUI(msg);
    });
  }

  function leave(reason = 'left the session') {
    if (!s) return;
    const cur = s; s = null;
    if (cur.role === 'host') {
      for (const p of cur.peers.values()) { try { if (p.ready) p.socket.write(seal(cur.key, { type: 'ended', reason: 'the host ended the session' })); p.socket.end(); } catch { /* gone */ } }
      try { if (cur.server) cur.server.close(); } catch { /* closed */ }
      try { if (cur.udp) cur.udp.close(); } catch { /* closed */ }
    } else if (cur.socket) { cur.closing = true; cur.socket.end(); }
    // Give the goodbye frames a moment to flush before tearing the DHT node down.
    if (cur.swarm) setTimeout(() => cur.swarm.destroy().catch(() => {}), 300);
    toUI({ type: 'ended', reason, local: true });
    core.event('COLLAB', `session closed (${reason})`);
  }

  return {
    'collab:host': async ({ name, port, p2p = true } = {}) => {
      if (s) throw new Error('Already in a collaboration session');
      const code = newCode();
      const p = Number(port) || DEFAULT_PORT;
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port must be between 1024 and 65535');
      const useP2P = p2p && P2P_ENABLED();
      // Direct TCP is only for same-network joins; if the port is taken, internet joining still works.
      let server = net.createServer();
      try {
        await new Promise((resolve, reject) => {
          server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${p} is already in use — pick another` : e.message)));
          server.listen(p, '0.0.0.0', resolve);
        });
      } catch (e) {
        if (!useP2P) throw e;
        core.log('warn', `collab: direct port unavailable (${e.message}); internet joining only`, 'COLLAB');
        server = null;
      }
      s = { role: 'host', code, key: deriveKey(code), server, port: server ? p : null, peers: new Map(), docs: new Map(), fails: new Map(), me: { id: 'host', name: cleanName(name, os.userInfo().username), color: 0 }, p2p: useP2P ? 'connecting' : 'off' };
      if (server) {
        server.on('connection', acceptSocket);
        server.on('error', (e) => core.log('error', 'collab server: ' + e.message, 'COLLAB'));
        s.udp = startResponder(s);
      }
      if (useP2P) startSwarmHost(s, code);
      core.event('COLLAB', `hosting${server ? ` on port ${p}` : ''}${useP2P ? ' + internet' : ''}`);
      return { role: 'host', code, port: s.port, p2p: s.p2p, addresses: lanAddresses(), me: peerInfo(s.me), peers: peerList(), docs: [], firewall: await firewallStatus().catch(() => ({ supported: false })) };
    },

    'collab:join': async ({ address, code, name, p2p = true } = {}) => {
      if (s) throw new Error('Already in a collaboration session');
      if (normCode(code).length !== 16) throw new Error('Session code must be 16 characters (XXXX-XXXX-XXXX-XXXX)');
      // The address is optional: without one we find the host over the internet by the code alone.
      const targets = String(address || '').trim() ? parseTargets(address) : [];
      const useP2P = p2p && P2P_ENABLED();
      if (!targets.length && !useP2P) throw new Error('Internet joining is unavailable in this build — type the host\'s address');
      const key = deriveKey(code);
      const attempts = [];
      let swarm = null;
      if (targets.length) attempts.push(connectFirst(targets, 8000).then((r) => ({ ...r, via: 'lan' })));
      if (useP2P) { swarm = new Hyperswarm(); attempts.push(p2pConnect(swarm, deriveTopic(code), P2P_TIMEOUT)); }
      let picked;
      try { picked = await firstOf(attempts); } catch (e) { if (swarm) swarm.destroy().catch(() => {}); throw e; }
      const { socket, host, port, via } = picked;
      if (swarm && via !== 'p2p') { swarm.destroy().catch(() => {}); swarm = null; }
      if (socket.setNoDelay) { socket.setNoDelay(true); socket.setKeepAlive(true, 15000); }
      const where = via === 'p2p' ? 'the host' : `${host}:${port}`;
      const welcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${where} accepted the connection but never answered. Is it a PHANTOM session?`)); }, 10000);
        socket.once('error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
        socket.once('close', () => { clearTimeout(timer); reject(new Error('The host closed the connection: the session code is probably wrong (check it, or ask the host to copy the invite again)')); });
        guestFrames(socket, key, (w) => { clearTimeout(timer); resolve(w); });
        socket.write(seal(key, { type: 'hello', name: cleanName(name, os.userInfo().username), v: 1 }));
      }).catch((e) => { if (swarm) swarm.destroy().catch(() => {}); throw e; });
      socket.removeAllListeners('close'); socket.removeAllListeners('error');
      const hostStr = via === 'p2p' ? 'internet (peer-to-peer)' : host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
      s = { role: 'guest', key, socket, swarm, via, me: welcome.me, hostAddress: hostStr };
      socket.on('error', () => {});
      socket.on('close', () => {
        if (s && s.socket === socket) {
          const cur = s; s = null;
          if (cur.swarm) cur.swarm.destroy().catch(() => {});
          toUI({ type: 'ended', reason: 'connection to the host was lost' }); core.event('COLLAB', 'disconnected from host', 'warn');
        }
      });
      core.event('COLLAB', `joined ${welcome.hostName}'s session at ${hostStr}`);
      return { role: 'guest', host: s.hostAddress, hostName: welcome.hostName, me: welcome.me, peers: welcome.peers, docs: welcome.docs };
    },

    // Find sessions on the local network (UDP broadcast). Returns [{name, host, address, port, peers}].
    'collab:discover': async ({ ms = 1500 } = {}) => {
      const u = dgram.createSocket({ type: 'udp4' });
      const found = new Map();
      const mine = new Set(lanAddresses().map((a) => a.address));
      await new Promise((resolve, reject) => { u.once('error', reject); u.bind(0, () => { u.removeListener('error', reject); resolve(); }); });
      u.setBroadcast(true);
      u.on('error', () => {});
      u.on('message', (buf, rinfo) => {
        let m; try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
        if (!m || m.t !== 'phantom-session' || !Number.isInteger(m.port)) return;
        const k = `${rinfo.address}:${m.port}`;
        if (!found.has(k)) found.set(k, { name: cleanName(m.name, '?'), host: cleanName(m.host, ''), address: rinfo.address, port: m.port, peers: Number(m.peers) || 1, local: mine.has(rinfo.address) || rinfo.address === '127.0.0.1' });
      });
      const probe = Buffer.from(PROBE);
      const send = () => { for (const t of broadcastTargets()) u.send(probe, DISCOVERY_PORT, t, () => {}); };
      send(); setTimeout(send, 400);
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(ms) || 1500, 300), 5000)));
      try { u.close(); } catch { /* closed */ }
      // A session on this computer answers on loopback and on its LAN address: keep one entry.
      const list = [...found.values()];
      return list.filter((x) => !(x.address === '127.0.0.1' && list.some((y) => y !== x && y.local && y.port === x.port)));
    },

    'collab:firewall': async () => firewallStatus(),
    'collab:allowFirewall': async () => allowFirewall(),
    'collab:addresses': async () => lanAddresses(),

    'collab:send': async (msg) => {
      if (!s) throw new Error('Not in a collaboration session');
      if (!msg || typeof msg !== 'object') throw new Error('bad message');
      if (s.role === 'host') handle(s.me.id, msg);
      else s.socket.write(seal(s.key, msg));
      return true;
    },

    'collab:leave': async () => { leave(); return true; },

    'collab:status': async () => {
      if (!s) return { role: null };
      if (s.role === 'host') return { role: 'host', code: s.code, port: s.port, p2p: s.p2p, addresses: lanAddresses(), me: peerInfo(s.me), peers: peerList(), docs: docList(), firewall: await firewallStatus().catch(() => ({ supported: false })) };
      return { role: 'guest', host: s.hostAddress, me: s.me };
    }
  };
};
