// Live collaboration (renderer side): session state, document bindings (OT client ⇄ Monaco model),
// remote cursors and chat. Transport + authority live in main/services/collab.js.
import { call, on, bus } from './api.js';
import { docs, openDoc, releaseDoc, saveDoc, registerScheme, loadMonaco } from './docs.js';
import { toast, fail } from './ui.js';
import { basename } from './dom.js';

const { TextOperation, OTClient } = window.PhantomOT || {};

export const session = { role: null, me: null, peers: [], docs: [], code: null, port: null, addresses: [], host: null, hostName: null, chat: [], unread: 0 };
const bindings = new Map(); // docId -> binding
const pending = new Map(); // docId -> resolve(docMsg) for guest opens
const send = (msg) => call('collab:send', msg).catch((e) => fail(e, 'COLLAB'));
const changed = () => bus.emit('collab:changed', session);

export const COLLAB_SCHEME = 'collab://';
export const virtualPath = (id, name) => `${COLLAB_SCHEME}${id}/${name}`;
export const isCollabPath = (p) => typeof p === 'string' && p.startsWith(COLLAB_SCHEME);
/** Is this document path live-shared right now (either side)? */
export function liveDocFor(path) { for (const b of bindings.values()) if (b.doc.path === path && !b.detached) return b; return null; }
export const peerById = (id) => session.peers.find((p) => p.id === id);

// ───────── per-peer cursor label styles ─────────
const styleEl = document.createElement('style');
document.head.appendChild(styleEl);
function refreshPeerStyles() {
  styleEl.textContent = session.peers.map((p) => `.collab-n-${p.id}::after{content:${JSON.stringify(p.name)}}`).join('\n');
}

// ───────── bindings ─────────
function opFromMonacoEvent(model, e) {
  const changes = [...e.changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  let base = model.getValueLength();
  for (const c of changes) base += c.rangeLength - c.text.length;
  const op = new TextOperation(); let idx = 0;
  for (const c of changes) { op.retain(c.rangeOffset - idx); op.insert(c.text); op.delete(c.rangeLength); idx = c.rangeOffset + c.rangeLength; }
  op.retain(base - idx);
  return op;
}
function applyToMonaco(model, op) {
  const monaco = window.monaco; const edits = []; const ops = op.ops; let idx = 0;
  const range = (a, b) => { const p = model.getPositionAt(a); const q = model.getPositionAt(b); return new monaco.Range(p.lineNumber, p.column, q.lineNumber, q.column); };
  for (let i = 0; i < ops.length; i++) {
    const c = ops[i];
    if (typeof c === 'number' && c > 0) idx += c;
    else if (typeof c === 'string') {
      let del = 0;
      if (typeof ops[i + 1] === 'number' && ops[i + 1] < 0) { del = -ops[i + 1]; i++; }
      edits.push({ range: range(idx, idx + del), text: c });
      idx += del;
    } else { edits.push({ range: range(idx, idx - c), text: '' }); idx -= c; }
  }
  model.pushStackElement();
  model.pushEditOperations([], edits, () => null);
  model.pushStackElement();
}

function bind(id, doc, rev, { owner }) {
  const model = doc.model;
  const isMonaco = typeof model.getValueLength === 'function';
  const b = { id, doc, model, owner, applying: false, cursors: new Map(), deco: [], last: isMonaco ? null : model.getValue(), detached: false };
  b.ot = new OTClient(rev,
    (r, op) => send({ type: 'op', id, rev: r, op: op.toJSON() }),
    (op) => {
      b.applying = true;
      try {
        if (isMonaco) applyToMonaco(model, op);
        else { bus.emit('collab:remoteop', { model, op }); model.setValue(op.apply(model.getValue())); b.last = model.getValue(); }
      } finally { b.applying = false; }
      shiftCursors(b, op);
    });
  b.sub = model.onDidChangeContent((e) => {
    if (b.applying || b.detached) return;
    let op;
    if (isMonaco) op = opFromMonacoEvent(model, e);
    else { const cur = model.getValue(); op = TextOperation.fromDiff(b.last, cur); b.last = cur; }
    if (op.isNoop()) return;
    b.ot.applyClient(op);
    shiftCursors(b, op);
  });
  bindings.set(id, b);
  bus.emit('collab:bound', doc.path);
  return b;
}
function unbind(b, { release = true } = {}) {
  if (!b || b.detached) return;
  b.detached = true;
  try { b.sub.dispose(); } catch { /* disposed */ }
  try { if (b.deco.length) b.deco = b.model.deltaDecorations(b.deco, []); } catch { /* disposed */ }
  bindings.delete(b.id);
  if (release && b.owner) releaseDoc(b.doc);
  bus.emit('collab:bound', b.doc.path);
}

function shiftCursors(b, op) {
  if (!b.cursors.size) return;
  for (const c of b.cursors.values()) { c.anchor = op.transformIndex(c.anchor); c.head = op.transformIndex(c.head); }
  renderCursors(b);
}
function renderCursors(b) {
  const monaco = window.monaco;
  if (!monaco || typeof b.model.deltaDecorations !== 'function' || b.model.isDisposed()) return;
  const len = b.model.getValueLength(); const decos = [];
  for (const [peerId, c] of b.cursors) {
    const p = peerById(peerId); if (!p) continue;
    const clamp = (x) => Math.max(0, Math.min(len, x));
    const a = b.model.getPositionAt(clamp(c.anchor)); const hd = b.model.getPositionAt(clamp(c.head));
    if (c.anchor !== c.head) {
      const [s, e] = c.anchor < c.head ? [a, hd] : [hd, a];
      decos.push({ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), options: { className: `collab-sel c${p.color}`, stickiness: 1 } });
    }
    decos.push({ range: new monaco.Range(hd.lineNumber, hd.column, hd.lineNumber, hd.column), options: { beforeContentClassName: `collab-caret c${p.color} collab-n-${p.id}`, showIfCollapsed: true, stickiness: 1, hoverMessage: { value: p.name } } });
  }
  b.deco = b.model.deltaDecorations(b.deco, decos);
}

// Local caret → peers (throttled)
let cursorTimer = 0; let cursorPending = null;
bus.on('editor:cursor', ({ model, anchor, head }) => {
  if (!session.role) return;
  for (const b of bindings.values()) {
    if (b.model !== model) continue;
    cursorPending = { type: 'cursor', id: b.id, anchor, head };
    if (!cursorTimer) cursorTimer = setTimeout(() => { cursorTimer = 0; if (cursorPending) send(cursorPending); cursorPending = null; }, 50);
  }
});

// ───────── virtual documents for guests (collab://id/name) ─────────
registerScheme('collab', {
  async open(path) {
    const id = path.slice(COLLAB_SCHEME.length).split('/')[0];
    if (!session.role) throw new Error('Not in a live session — this shared file is no longer available');
    const msg = await new Promise((resolve, reject) => {
      pending.set(id, resolve);
      send({ type: 'open', id });
      setTimeout(() => { if (pending.get(id) === resolve) { pending.delete(id); reject(new Error('The host did not send the file')); } }, 10000);
    });
    const monaco = await loadMonaco();
    let model;
    if (monaco) {
      const uri = monaco.Uri.parse(`collab://${id}/${encodeURIComponent(msg.name)}`);
      model = monaco.editor.getModel(uri) || monaco.editor.createModel(msg.text, undefined, uri);
      model.setEOL(msg.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      if (model.getValue() !== msg.text) model.setValue(msg.text);
    } else model = null;
    return { model, text: msg.text, eol: msg.eol, after: (doc) => bind(id, doc, msg.rev, { owner: false }) };
  },
  async save(doc) {
    const b = liveDocFor(doc.path);
    if (!b) { toast('this file is no longer shared — save a copy with Save As', 'warn'); return; }
    send({ type: 'save', id: b.id });
    toast(`asked the owner to save ${doc.name}`, 'info', 'LIVE', 1800);
  },
  release(doc) { const b = liveDocFor(doc.path); if (b) unbind(b, { release: false }); }
});

// ───────── public API ─────────
export async function host({ name, port }) {
  const r = await call('collab:host', { name, port });
  Object.assign(session, { role: 'host', me: r.me, peers: r.peers, docs: r.docs, code: r.code, port: r.port, addresses: r.addresses, firewall: r.firewall || null, p2p: r.p2p || 'off', p2pError: null, relay: r.relay || 'off', relayError: null, chat: [] });
  refreshPeerStyles(); changed();
  // Status updates can arrive before this call returns (a fast relay): re-read so none is lost.
  call('collab:status').then((st) => { if (session.role === 'host' && st.role === 'host') { session.p2p = st.p2p || session.p2p; session.relay = st.relay || session.relay; changed(); } }).catch(() => {});
  return r;
}
export async function join({ address, code, name }) {
  const r = await call('collab:join', { address, code, name });
  Object.assign(session, { role: 'guest', me: r.me, peers: r.peers, docs: r.docs, host: r.host, hostName: r.hostName, code: null, chat: [] });
  refreshPeerStyles(); changed();
  toast(`connected to ${r.hostName}'s session`, 'info', 'LIVE');
  return r;
}
export async function leave() { await call('collab:leave').catch(() => {}); }

export async function share(path) {
  if (!session.role) throw new Error('Start or join a live session first');
  if (isCollabPath(path)) throw new Error('That file is already a shared file');
  if (liveDocFor(path)) { toast(`${basename(path)} is already shared`, 'info'); return; }
  const doc = await openDoc(path);
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await send({ type: 'share', id, name: doc.name, text: doc.getValue(), eol: doc.eol || 'LF' });
  bind(id, doc, 0, { owner: true });
  toast(`${doc.name} is live — collaborators can open it now`, 'info', 'SHARED');
}
export function unshare(id) {
  const b = bindings.get(id);
  send({ type: 'unshare', id });
  if (b) unbind(b);
}
export function sendChat(text) { if (text.trim()) send({ type: 'chat', text }); }
export function editorsOf(docId) { return [...bindings.values()].filter((b) => b.id === docId).length; }
export function bindingFor(path) { return liveDocFor(path); }
export function pathOf(id) { const b = bindings.get(id); return b ? b.doc.path : null; }

// ───────── incoming messages ─────────
on('collab:msg', async (m) => {
  const b = m.id ? bindings.get(m.id) : null;
  switch (m.type) {
    case 'doc': { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } break; }
    case 'ack': if (b) b.ot.serverAck(); break;
    case 'op': if (b) { try { b.ot.applyServer(TextOperation.fromJSON(m.op)); } catch (e) { console.error(e); send({ type: 'open', id: m.id }); } } break;
    case 'resync':
      if (b) {
        b.applying = true;
        try {
          if (typeof b.model.getValueLength === 'function') b.model.pushEditOperations([], [{ range: b.model.getFullModelRange(), text: m.text }], () => null);
          else { b.model.setValue(m.text); b.last = m.text; }
        } finally { b.applying = false; }
        b.ot = new OTClient(m.rev, b.ot.send, b.ot.apply);
        toast(`${b.doc.name} was re-synchronised with the host`, 'warn', 'LIVE');
      }
      break;
    case 'cursor':
      if (b) { b.cursors.set(m.peer, { anchor: b.ot.transformRemoteIndex(m.anchor), head: b.ot.transformRemoteIndex(m.head) }); renderCursors(b); }
      break;
    case 'peers':
      session.peers = m.peers; refreshPeerStyles();
      for (const x of bindings.values()) { for (const id of [...x.cursors.keys()]) if (!peerById(id)) x.cursors.delete(id); renderCursors(x); }
      changed(); break;
    case 'joined': toast(`${m.peer.name} joined the session`, 'info', 'LIVE', 2500); break;
    case 'left': toast(`${m.peer.name} left the session`, 'info', 'LIVE', 2500); break;
    case 'docs': session.docs = m.docs; changed(); break;
    case 'p2p': session.p2p = m.state; session.p2pError = m.error || null; changed(); break;
    case 'relay': session.relay = m.state; session.relayError = m.error || null; changed(); break;
    case 'shared': break;
    case 'unshared':
      if (b && !b.owner) { unbind(b); toast(`${b.doc.name} is no longer shared — your copy is now local`, 'warn', 'LIVE'); }
      break;
    case 'chat':
      session.chat.push(m); if (session.chat.length > 500) session.chat.shift();
      session.unread++;
      bus.emit('collab:chat', m);
      changed(); break;
    case 'save':
      if (b && b.owner) { try { await saveDoc(b.doc); toast(`${m.byName} saved ${b.doc.name}`, 'info', 'LIVE', 2000); } catch (e) { fail(e, 'SAVE'); } }
      break;
    case 'error': toast(m.message, 'warn', 'LIVE'); break;
    case 'ended': {
      const wasGuest = session.role === 'guest';
      for (const x of [...bindings.values()]) unbind(x);
      Object.assign(session, { role: null, me: null, peers: [], docs: [], code: null, addresses: [], host: null, hostName: null });
      changed();
      if (!m.local) toast(`Live session ended: ${m.reason}.${wasGuest ? ' Open shared files stay as local copies.' : ''}`, 'warn', 'LIVE', 6000);
      break;
    }
    default:
  }
});

// If the interface reloads mid-session the editor bindings are gone, so end the session cleanly
// rather than leave collaborators editing a document nobody here is tracking.
call('collab:status').then((st) => { if (st.role) call('collab:leave').catch(() => {}); }).catch(() => {});
