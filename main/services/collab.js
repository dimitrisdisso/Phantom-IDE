'use strict';
// Real-time collaboration. One PHANTOM hosts a session (TCP listener); others join with the host
// address + session code. The session code is never sent: it derives an AES-256-GCM key (scrypt),
// so every frame is encrypted + authenticated and a wrong code simply cannot talk to the host.
// The host is the authority for document state (operational transformation, see shared/ot.js).
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { TextOperation, OTServer } = require(path.join(__dirname, '..', '..', 'renderer', 'js', 'shared', 'ot.js'));

const DEFAULT_PORT = 7457;
const MAX_FRAME = 24 * 1024 * 1024;
const MAX_DOC = 10 * 1024 * 1024;
const MAX_PEERS = 8;
const PALETTE = 6;
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanName = (n, fb) => (String(n || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 32) || fb);
const frameSize = (msg) => Buffer.byteLength(JSON.stringify(msg), 'utf8') + 28;

function newCode() {
  const b = crypto.randomBytes(16); let s = '';
  for (let i = 0; i < 16; i++) s += B32[b[i] % 32];
  return s.match(/.{4}/g).join('-'); // 80 bits
}
const deriveKey = (code) => crypto.scryptSync(normCode(code), 'phantom-collab-v1', 32, { N: 16384, r: 8, p: 1 });

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify(obj);
  if (Buffer.byteLength(plain, 'utf8') + 28 > MAX_FRAME) throw new Error('Collaboration message is too large');
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
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
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address });
  return out;
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
        if (typeof msg.id !== 'string' || msg.id.length > 64 || typeof msg.text !== 'string' || msg.text.length > MAX_DOC) return deliver(from, { type: 'error', id: msg.id, message: 'invalid share' });
        if (s.docs.has(msg.id)) return deliver(from, { type: 'error', id: msg.id, message: 'that file is already shared' });
        const doc = { id: msg.id, name: cleanName(msg.name, 'untitled').slice(0, 200), owner: from, text: msg.text, rev: 0, eol: msg.eol === 'CRLF' ? 'CRLF' : 'LF' };
        if (frameSize({ type: 'doc', ...doc }) > MAX_FRAME) return deliver(from, { type: 'error', id: msg.id, message: 'document too large to share' });
        s.docs.set(msg.id, { id: doc.id, name: doc.name, owner: from, ot: new OTServer(doc.text), eol: doc.eol });
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
        if (!d) return deliver(from, { type: 'error', id: msg.id, message: 'that file is no longer shared' });
        return deliver(from, { type: 'doc', id: d.id, name: d.name, text: d.ot.text, rev: d.ot.revision, eol: d.eol, owner: d.owner });
      }
      case 'op': {
        if (!d) return;
        const previous = d.ot.text;
        let applied;
        try { applied = d.ot.receive(msg.rev, TextOperation.fromJSON(msg.op, MAX_DOC)); }
        catch (e) { return deliver(from, { type: 'resync', id: d.id, text: d.ot.text, rev: d.ot.revision, reason: e.message }); }
        if (d.ot.text.length > MAX_DOC || frameSize({ type: 'doc', id: d.id, name: d.name, text: d.ot.text, rev: d.ot.revision, eol: d.eol, owner: d.owner }) > MAX_FRAME) {
          d.ot.text = previous;
          d.ot.history.pop();
          return deliver(from, { type: 'error', id: d.id, message: 'document too large' });
        }
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
    const ip = socket.remoteAddress || '?';
    if ((s.fails.get(ip) || 0) >= 5) { socket.destroy(); return; }
    if (s.peers.size >= MAX_PEERS) { socket.destroy(); return; }
    socket.setNoDelay(true); socket.setKeepAlive(true, 15000);
    const peer = { id: crypto.randomBytes(4).toString('hex'), socket, ready: false, ip, name: '?', color: 1 };
    s.peers.set(peer.id, peer);
    const helloTimer = setTimeout(() => { if (!peer.ready) socket.destroy(); }, 10000);
    framer(socket, (body) => {
      let msg;
      try { msg = unseal(s.key, body); }
      catch {
        s.fails.set(ip, (s.fails.get(ip) || 0) + 1);
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
      try { cur.server.close(); } catch { /* closed */ }
    } else if (cur.socket) { cur.closing = true; cur.socket.end(); }
    toUI({ type: 'ended', reason, local: true });
    core.event('COLLAB', `session closed (${reason})`);
  }

  return {
    'collab:host': async ({ name, port } = {}) => {
      if (s) throw new Error('Already in a collaboration session');
      const code = newCode();
      const p = Number(port) || DEFAULT_PORT;
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port must be between 1024 and 65535');
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${p} is already in use — pick another` : e.message)));
        server.listen(p, '0.0.0.0', resolve);
      });
      s = { role: 'host', code, key: deriveKey(code), server, port: p, peers: new Map(), docs: new Map(), fails: new Map(), me: { id: 'host', name: cleanName(name, os.userInfo().username), color: 0 } };
      server.on('connection', acceptSocket);
      server.on('error', (e) => core.log('error', 'collab server: ' + e.message, 'COLLAB'));
      core.event('COLLAB', `hosting on port ${p}`);
      return { role: 'host', code, port: p, addresses: lanAddresses(), me: peerInfo(s.me), peers: peerList(), docs: [] };
    },

    'collab:join': async ({ address, code, name } = {}) => {
      if (s) throw new Error('Already in a collaboration session');
      const m = /^\s*(?:\[([^\]]+)\]|([^:\s]+))(?::(\d+))?\s*$/.exec(String(address || ''));
      if (!m) throw new Error('Address must look like 192.168.1.20 or 192.168.1.20:7457');
      const host = m[1] || m[2]; const port = Number(m[3]) || DEFAULT_PORT;
      if (normCode(code).length !== 16) throw new Error('Session code must be 16 characters (XXXX-XXXX-XXXX-XXXX)');
      const key = deriveKey(code);
      const socket = net.connect({ host, port });
      socket.setNoDelay(true); socket.setKeepAlive(true, 15000);
      const welcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error(`No answer from ${host}:${port} — check the address, that the host's session is running and that the firewall allows the port`)); }, 10000);
        socket.once('connect', () => socket.write(seal(key, { type: 'hello', name: cleanName(name, os.userInfo().username), v: 1 })));
        socket.once('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ECONNREFUSED' ? `Connection refused by ${host}:${port} — is the session running?` : e.message)); });
        socket.once('close', () => { clearTimeout(timer); reject(new Error('The host closed the connection — the session code is probably wrong')); });
        guestFrames(socket, key, (w) => { clearTimeout(timer); resolve(w); });
      });
      socket.removeAllListeners('close'); socket.removeAllListeners('error');
      s = { role: 'guest', key, socket, me: welcome.me, hostAddress: `${host}:${port}` };
      socket.on('error', () => {});
      socket.on('close', () => { if (s && s.socket === socket) { s = null; toUI({ type: 'ended', reason: 'connection to the host was lost' }); core.event('COLLAB', 'disconnected from host', 'warn'); } });
      core.event('COLLAB', `joined ${welcome.hostName}'s session at ${host}:${port}`);
      return { role: 'guest', host: s.hostAddress, hostName: welcome.hostName, me: welcome.me, peers: welcome.peers, docs: welcome.docs };
    },

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
      if (s.role === 'host') return { role: 'host', code: s.code, port: s.port, addresses: lanAddresses(), me: peerInfo(s.me), peers: peerList(), docs: docList() };
      return { role: 'guest', host: s.hostAddress, me: s.me };
    }
  };
};
