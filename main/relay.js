'use strict';
// Client for the PHANTOM relay (relay/ — a Cloudflare Worker). Used when a direct / peer-to-peer
// connection can't be made. Each relayed connection is exposed as a Duplex stream, so the
// collaboration code treats it exactly like a TCP socket. The relay only ever carries bytes that are
// already AES-256-GCM encrypted with the session code.
const { Duplex } = require('stream');
const WebSocket = require('ws');

const CHUNK = 512 * 1024; // Workers caps WebSocket messages at 1 MiB
const PING_MS = 25000;

/** A Duplex over a send function; incoming bytes are pushed with .feed(). */
class RelayStream extends Duplex {
  constructor(send, onClose, remote) {
    super({ allowHalfOpen: false });
    this._send = send; this._onClose = onClose; this.remoteAddress = remote || undefined; this.relayed = true;
  }
  _read() {}
  _write(chunk, _enc, cb) {
    try { for (let i = 0; i < chunk.length; i += CHUNK) this._send(chunk.subarray(i, i + CHUNK)); cb(); } catch (e) { cb(e); }
  }
  _final(cb) { this.push(null); cb(); }
  _destroy(err, cb) { const f = this._onClose; this._onClose = null; if (f) { try { f(); } catch { /* closing */ } } cb(err); }
  feed(buf) { if (!this.destroyed) this.push(buf); }
  remoteClosed() { if (!this.destroyed) { this._onClose = null; this.push(null); this.destroy(); } }
}

const roomUrl = (base, topic, role) => `${String(base).replace(/\/+$/, '')}/v1/${topic.toString('hex')}?role=${role}`;
const closeText = (code, reason) => ({ 4004: 'no session with this code is running', 4009: 'a session with this code is already being hosted', 4008: 'the session is full', 4001: 'the host left' }[code] || String(reason || '') || `closed (${code})`);
function keepAlive(ws) { const t = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, PING_MS); ws.on('close', () => clearInterval(t)); }

/**
 * Guest: connect to the host of `topic` through the relay. Resolves with a stream once the host has
 * been told about us; rejects with err.code 'NO_SESSION' if nobody is hosting that code.
 */
function relayConnect(base, topic, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false; let stream = null;
    const ws = new WebSocket(roomUrl(base, topic, 'guest'), { handshakeTimeout: timeoutMs, perMessageDeflate: false });
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); try { ws.terminate(); } catch { /* closed */ } reject(e); };
    const timer = setTimeout(() => fail(new Error('the relay did not answer')), timeoutMs);
    ws.on('error', (e) => { if (!done) fail(new Error(`relay unreachable (${e.message})`)); else if (stream) stream.destroy(); });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { if (stream) stream.feed(Buffer.from(data)); return; }
      const s = String(data);
      if (s === 'pong') return;
      let m; try { m = JSON.parse(s); } catch { return; }
      if (m.t === 'error' && !done) { const e = new Error(closeText(m.code, m.reason)); if (m.code === 4004) e.code = 'NO_SESSION'; fail(e); return; }
      if (m.t === 'ready' && !done) {
        done = true; clearTimeout(timer); keepAlive(ws);
        stream = new RelayStream((b) => ws.send(b, { binary: true }), () => { try { ws.close(1000); } catch { /* closed */ } }, 'relay');
        resolve({ socket: stream, host: 'relay', port: 0, via: 'relay' });
      }
    });
    ws.on('close', (code, reason) => {
      if (!done) { const e = new Error(closeText(code, reason)); if (code === 4004) e.code = 'NO_SESSION'; fail(e); return; }
      if (stream) stream.remoteClosed();
    });
  });
}

/**
 * Host: keep a relay connection for `topic` open (reconnecting with backoff) and hand each relayed
 * guest to onStream(stream). onState('connecting'|'online'|'error', message). Returns { close() }.
 */
function relayHost(base, topic, { onStream, onState }) {
  let ws = null; let closed = false; let retry = 0; let timer = null;
  const streams = new Map();
  const dropAll = () => { for (const st of streams.values()) st.remoteClosed(); streams.clear(); };
  function open() {
    if (closed) return;
    onState('connecting');
    ws = new WebSocket(roomUrl(base, topic, 'host'), { handshakeTimeout: 15000, perMessageDeflate: false });
    const sock = ws;
    sock.on('open', () => { retry = 0; keepAlive(sock); onState('online'); });
    sock.on('error', () => { /* close follows */ });
    sock.on('message', (data, isBinary) => {
      if (isBinary) {
        const b = Buffer.from(data); if (b.length < 4) return;
        const st = streams.get(b.readUInt32BE(0)); if (st) st.feed(b.subarray(4));
        return;
      }
      const s = String(data); if (s === 'pong') return;
      let m; try { m = JSON.parse(s); } catch { return; }
      if (m.t === 'error') { if (m.code === 4009) { closed = true; onState('error', closeText(m.code, m.reason)); } return; }
      if (m.t === 'open' && Number.isInteger(m.id)) {
        const id = m.id >>> 0;
        const hdr = Buffer.alloc(4); hdr.writeUInt32BE(id);
        const st = new RelayStream(
          (chunk) => { if (sock.readyState === WebSocket.OPEN) sock.send(Buffer.concat([hdr, chunk]), { binary: true }); },
          () => { streams.delete(id); if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'close', id })); },
          m.ip ? `relay:${m.ip}` : `relay:${id}`);
        streams.set(id, st);
        onStream(st);
      } else if (m.t === 'close') { const st = streams.get(m.id >>> 0); if (st) { streams.delete(m.id >>> 0); st.remoteClosed(); } }
    });
    sock.on('close', (code, reason) => {
      if (ws === sock) ws = null;
      dropAll();
      if (closed) return;
      if (code === 4009) { onState('error', closeText(code, reason)); return; }
      onState('error', 'relay connection lost, reconnecting…');
      const wait = Math.min(30000, 1000 * 2 ** retry++);
      timer = setTimeout(open, wait);
    });
  }
  open();
  return { close() { closed = true; clearTimeout(timer); dropAll(); if (ws) { try { ws.close(1000); } catch { /* closed */ } } } };
}

module.exports = { relayConnect, relayHost, RelayStream };
