'use strict';
// End-to-end test of the collaboration backend: a host core and two guest cores talk over real TCP
// with encryption, three OT clients type concurrently, and all copies must converge.
// Usage: node tools/collab-test.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createCore } = require('../main/registry');
const { TextOperation, OTClient } = require('../renderer/js/shared/ot.js');

const mk = (label) => {
  const listeners = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-collab-' + label + '-'));
  const core = createCore({ dataDir, emit: (ch, p) => { if (ch === 'collab:msg') listeners.forEach((f) => f(p)); } });
  return { core, dataDir, call: (ch, ...a) => core.handlers.get(ch)(...a), on: (f) => listeners.push(f) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m', m); } else { fail++; console.log('  \x1b[31m✗\x1b[0m', m); } };

/** Minimal renderer-side binding: a text buffer + OT client, like core/collab.js does. */
function participant(node) {
  const docs = new Map();
  const events = [];
  node.on((m) => {
    events.push(m);
    const d = docs.get(m.id);
    if (m.type === 'doc') {
      const st = { text: m.text };
      st.ot = new OTClient(m.rev, (rev, op) => node.call('collab:send', { type: 'op', id: m.id, rev, op: op.toJSON() }), (op) => { st.text = op.apply(st.text); });
      docs.set(m.id, st);
    } else if (m.type === 'ack' && d) d.ot.serverAck();
    else if (m.type === 'op' && d) d.ot.applyServer(TextOperation.fromJSON(m.op));
    else if (m.type === 'resync' && d) { d.text = m.text; d.ot = new OTClient(m.rev, d.ot.send, d.ot.apply); }
  });
  return {
    docs, events,
    share(id, text) { const st = { text }; st.ot = new OTClient(0, (rev, op) => node.call('collab:send', { type: 'op', id, rev, op: op.toJSON() }), (op) => { st.text = op.apply(st.text); }); docs.set(id, st); return node.call('collab:send', { type: 'share', id, name: 'main.py', text }); },
    edit(id, fn) { const st = docs.get(id); const next = fn(st.text); const op = TextOperation.fromDiff(st.text, next); st.text = next; if (!op.isNoop()) st.ot.applyClient(op); }
  };
}

(async () => {
  console.log('\ncollaboration');
  const H = mk('host'); const G1 = mk('g1'); const G2 = mk('g2'); const BAD = mk('bad');
  const host = participant(H); const g1 = participant(G1); const g2 = participant(G2);
  const port = 47000 + Math.floor(Math.random() * 1000);
  const session = await H.call('collab:host', { name: 'elliot', port });
  ok(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(session.code), `host started on ${port}, code ${session.code}`);

  let err = null;
  try { await BAD.call('collab:join', { address: `127.0.0.1:${port}`, code: 'AAAA-BBBB-CCCC-DDDD', name: 'mallory' }); } catch (e) { err = e.message; }
  ok(err && /wrong/.test(err), `wrong code rejected: "${err}"`);

  const w1 = await G1.call('collab:join', { address: `127.0.0.1:${port}`, code: session.code.toLowerCase(), name: 'darlene' });
  const w2 = await G2.call('collab:join', { address: `127.0.0.1:${port}`, code: session.code, name: 'angela' });
  ok(w1.hostName === 'elliot' && w2.peers.length === 3, `two guests joined, peers: ${w2.peers.map((p) => p.name + '#' + p.color).join(', ')}`);

  const initial = 'def main():\n    print("hello")\n\nmain()\n';
  await host.share('doc1', initial);
  await sleep(100);
  ok(g1.events.some((e) => e.type === 'docs' && e.docs[0].name === 'main.py'), 'guests see the shared file list');
  await G1.call('collab:send', { type: 'open', id: 'doc1' });
  await G2.call('collab:send', { type: 'open', id: 'doc1' });
  await sleep(150);
  ok(g1.docs.get('doc1').text === initial && g2.docs.get('doc1').text === initial, 'guests received the document');

  // concurrent typing burst: everybody edits at random positions without waiting for acks
  const people = [host, g1, g2];
  for (let i = 0; i < 400; i++) {
    const p = people[i % 3];
    p.edit('doc1', (t) => {
      const pos = Math.floor(Math.random() * (t.length + 1));
      if (Math.random() < 0.3 && t.length > 2) return t.slice(0, pos) + t.slice(pos + 1 + Math.floor(Math.random() * 3));
      return t.slice(0, pos) + ['x', ' ', '\n', 'éé', '#', '()'][i % 6] + t.slice(pos);
    });
    if (i % 25 === 0) await sleep(5);
  }
  for (let i = 0; i < 100 && people.some((p) => !p.docs.get('doc1').ot.synced); i++) await sleep(50);
  await sleep(200);
  const [a, b, c] = people.map((p) => p.docs.get('doc1').text);
  ok(a === b && b === c, `400 concurrent edits from 3 people converged (${a.length} chars)`);

  // cursor + chat + save routing
  await G1.call('collab:send', { type: 'cursor', id: 'doc1', anchor: 3, head: 5 });
  await G2.call('collab:send', { type: 'chat', text: 'pushing the fix now' });
  await G1.call('collab:send', { type: 'save', id: 'doc1' });
  await sleep(150);
  ok(host.events.some((e) => e.type === 'cursor' && e.anchor === 3) && g2.events.some((e) => e.type === 'cursor'), 'cursors broadcast to others');
  ok([host, g1, g2].every((p) => p.events.some((e) => e.type === 'chat' && e.name === 'angela')), 'chat reaches everyone');
  ok(host.events.some((e) => e.type === 'save' && e.byName === 'darlene'), 'guest Ctrl+S is routed to the file owner');

  // stale revision → server transforms; garbage op → resync
  await G2.call('collab:send', { type: 'op', id: 'doc1', rev: 0, op: [999999] });
  await sleep(100);
  ok(g2.events.some((e) => e.type === 'resync'), 'invalid operation triggers a resync instead of corrupting the doc');

  const maxDoc = 10 * 1024 * 1024;
  await host.share('large', 'x'.repeat(maxDoc));
  await G1.call('collab:send', { type: 'op', id: 'large', rev: 0, op: [maxDoc, 'y'] });
  await G1.call('collab:send', { type: 'open', id: 'large' });
  for (let i = 0; i < 40 && !g1.events.some((e) => e.type === 'doc' && e.id === 'large'); i++) await sleep(50);
  const largeDoc = g1.events.filter((e) => e.type === 'doc' && e.id === 'large').at(-1);
  const oversizedError = g1.events.some((e) => e.type === 'error' && e.id === 'large');
  ok(oversizedError && largeDoc && largeDoc.text.length === maxDoc, `oversized edit is rejected without changing the shared document (error=${oversizedError}, length=${largeDoc ? largeDoc.text.length : 'missing'})`);

  await G1.call('collab:leave');
  await sleep(150);
  ok(host.events.some((e) => e.type === 'left' && e.peer.name === 'darlene'), 'host notified when a guest leaves');
  await H.call('collab:leave');
  await sleep(150);
  ok(g2.events.some((e) => e.type === 'ended'), 'guests notified when the host ends the session');

  for (const n of [H, G1, G2, BAD]) {
    await n.core.shutdown();
    fs.rmSync(n.dataDir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
