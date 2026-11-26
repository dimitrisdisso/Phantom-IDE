// PHANTOM Live Session relay — a Cloudflare Worker + Durable Object.
//
// When two PHANTOMs can't connect directly (strict routers, mobile data, CGNAT), both connect OUT to
// this relay over a WebSocket and it forwards bytes between them. It is a blind pipe: everything is
// already encrypted end-to-end with the session code (AES-256-GCM), so the relay never sees the code,
// the key, file contents or chat. A session ("room") is addressed by a 32-byte topic derived from the
// code; the relay can't turn that back into the code.
//
//   wss://<relay>/v1/<64 hex topic>?role=host    one per room
//   wss://<relay>/v1/<64 hex topic>?role=guest   up to MAX_GUESTS per room
//
// Wire format
//   guest ⇄ relay : binary = raw stream bytes; text {"t":"ready"} once the host knows about you
//   host  ⇄ relay : binary = [uint32 BE guest id][stream bytes]
//                   text {"t":"open","id":n} / {"t":"close","id":n} (relay → host)
//                   text {"t":"close","id":n} (host → relay: drop that guest)
//   "ping" → "pong" is answered by the runtime without waking the object (keep-alive).

const MAX_GUESTS = 16;
const TOPIC_RE = /^\/v1\/([0-9a-f]{64})$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') return new Response('PHANTOM relay OK\n', { headers: { 'content-type': 'text/plain' } });
    const m = TOPIC_RE.exec(url.pathname);
    if (!m) return new Response('not found', { status: 404 });
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
    const role = url.searchParams.get('role');
    if (role !== 'host' && role !== 'guest') return new Response('bad role', { status: 400 });
    const room = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return room.fetch(req);
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    // Keep-alives never wake the object (it can hibernate between messages: no idle cost).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  host() { return this.ctx.getWebSockets('host')[0] || null; }
  guest(id) { return this.ctx.getWebSockets('g:' + id)[0] || null; }

  async fetch(req) {
    const role = new URL(req.url).searchParams.get('role');
    const pair = new WebSocketPair();
    const client = pair[0]; const server = pair[1];
    // Say why in a message first (clients act on it at once), then close.
    const reject = (code, reason) => {
      this.ctx.acceptWebSocket(server, ['dead']);
      server.send(JSON.stringify({ t: 'error', code, reason }));
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (role === 'host') {
      if (this.host()) return reject(4009, 'a session with this code is already being hosted');
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({ role: 'host' });
      return new Response(null, { status: 101, webSocket: client });
    }

    const host = this.host();
    if (!host) return reject(4004, 'no session with this code');
    const guests = this.ctx.getWebSockets('guest');
    if (guests.length >= MAX_GUESTS) return reject(4008, 'session is full');
    const used = new Set(guests.map((g) => (g.deserializeAttachment() || {}).id));
    let id; do { id = crypto.getRandomValues(new Uint32Array(1))[0]; } while (used.has(id));
    this.ctx.acceptWebSocket(server, ['guest', 'g:' + id]);
    server.serializeAttachment({ role: 'guest', id });
    host.send(JSON.stringify({ t: 'open', id, ip: req.headers.get('CF-Connecting-IP') || '' }));
    server.send(JSON.stringify({ t: 'ready' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'guest') {
      if (typeof msg === 'string') return; // guests only send stream bytes
      const host = this.host();
      if (!host) { safeClose(ws, 4001, 'the host left'); return; }
      const body = new Uint8Array(msg);
      const out = new Uint8Array(4 + body.byteLength);
      new DataView(out.buffer).setUint32(0, att.id);
      out.set(body, 4);
      host.send(out);
      return;
    }
    if (att.role === 'host') {
      if (typeof msg === 'string') {
        let c; try { c = JSON.parse(msg); } catch { return; }
        if (c && c.t === 'close') { const g = this.guest(c.id >>> 0); if (g) safeClose(g, 1000, 'closed by host'); }
        return;
      }
      if (msg.byteLength < 4) return;
      const id = new DataView(msg).getUint32(0);
      const g = this.guest(id);
      if (g) g.send(msg.slice(4));
      else this.host().send(JSON.stringify({ t: 'close', id }));
    }
  }

  async webSocketClose(ws, code, reason) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'host') {
      for (const g of this.ctx.getWebSockets('guest')) safeClose(g, 4001, 'the host left');
    } else if (att.role === 'guest') {
      const host = this.host();
      if (host) { try { host.send(JSON.stringify({ t: 'close', id: att.id })); } catch { /* gone */ } }
    }
    safeClose(ws, 1000, 'bye');
  }

  async webSocketError(ws) { await this.webSocketClose(ws, 1011, 'error'); }
}

function safeClose(ws, code, reason) { try { ws.close(code, reason); } catch { /* already closed */ } }
