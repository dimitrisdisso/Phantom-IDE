'use strict';
// Relay fallback test: host + 2 guests talk ONLY through the PHANTOM relay (peer-to-peer and direct
// TCP are disabled). Run the relay first, locally (`cd relay && npx wrangler@4 dev`) or deployed.
// Usage: node tools/relay-test.js [ws://127.0.0.1:8787 | wss://phantom-relay.<you>.workers.dev]
process.env.PHANTOM_P2P = '0';
process.env.PHANTOM_RELAY = process.argv[2] || process.env.PHANTOM_RELAY || 'ws://127.0.0.1:8787';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createCore } = require('../main/registry');
const { TextOperation, OTClient } = require('../renderer/js/shared/ot.js');

const mk = (label) => {
  const listeners = [];
  const core = createCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-relay-' + label + '-')), emit: (ch, p) => { if (ch === 'collab:msg') listeners.forEach((f) => f(p)); } });
  const msgs = []; listeners.push((m) => msgs.push(m));
  return { core, msgs, call: (ch, ...a) => core.handlers.get(ch)(...a), on: (f) => listeners.push(f) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(30); } return false; };
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m', m); } else { fail++; console.log('  \x1b[31m✗\x1b[0m', m); } };

function participant(node) {
  const docs = new Map();
  node.on((m) => {
    const d = docs.get(m.id);
    if (m.type === 'doc') { const st = { text: m.text }; st.ot = new OTClient(m.rev, (rev, op) => node.call('collab:send', { type: 'op', id: m.id, rev, op: op.toJSON() }), (op) => { st.text = op.apply(st.text); }); docs.set(m.id, st); }
    else if (m.type === 'ack' && d) d.ot.serverAck();
    else if (m.type === 'op' && d) d.ot.applyServer(TextOperation.fromJSON(m.op));
  });
  return {
    docs,
    share(id, text) { const st = { text }; st.ot = new OTClient(0, (rev, op) => node.call('collab:send', { type: 'op', id, rev, op: op.toJSON() }), (op) => { st.text = op.apply(st.text); }); docs.set(id, st); return node.call('collab:send', { type: 'share', id, name: 'big.txt', text }); },
    edit(id, fn) { const st = docs.get(id); const next = fn(st.text); const op = TextOperation.fromDiff(st.text, next); st.text = next; if (!op.isNoop()) st.ot.applyClient(op); }
  };
}

(async () => {
  console.log(`\nrelay collaboration via ${process.env.PHANTOM_RELAY}`);
  const H = mk('host'); const G1 = mk('g1'); const G2 = mk('g2'); const BAD = mk('bad');
  const host = participant(H); const g1 = participant(G1); const g2 = participant(G2);
  const session = await H.call('collab:host', { name: 'elliot', port: 49000 + Math.floor(Math.random() * 900) });
  ok(session.relay === 'connecting', `host started (code ${session.code}), connecting to the relay`);
  ok(await waitFor(() => H.msgs.some((m) => m.type === 'relay' && m.state === 'online')), 'host is online through the relay');

  let t = Date.now();
  const w1 = await G1.call('collab:join', { code: session.code, name: 'darlene' });
  ok(w1.host === 'internet (relay)' && w1.peers.length === 2, `guest 1 joined with only the code via ${w1.host} (${Date.now() - t} ms)`);
  const w2 = await G2.call('collab:join', { code: session.code.toLowerCase(), name: 'angela' });
  ok(w2.peers.length === 3, `guest 2 joined: ${w2.peers.map((p) => p.name).join(', ')}`);

  const big = ('x'.repeat(99) + '\n').repeat(30000); // 3 MB: several relay messages
  await host.share('big', big);
  await G1.call('collab:send', { type: 'open', id: 'big' }); await G2.call('collab:send', { type: 'open', id: 'big' });
  ok(await waitFor(() => g1.docs.get('big') && g2.docs.get('big') && g1.docs.get('big').text === big && g2.docs.get('big').text === big, 20000), '3 MB file reaches both guests intact (chunked under the 1 MiB message limit)');

  const people = [host, g1, g2];
  for (let i = 0; i < 300; i++) {
    const p = people[i % 3];
    p.edit('big', (s) => { const at = Math.floor(Math.random() * 2000); return Math.random() < 0.7 ? s.slice(0, at) + 'abc'[i % 3] + s.slice(at) : s.slice(0, at) + s.slice(at + 1); });
    if (i % 25 === 0) await sleep(5);
  }
  const conv = await waitFor(() => host.docs.get('big').text === g1.docs.get('big').text && g1.docs.get('big').text === g2.docs.get('big').text && [host, g1, g2].every((p) => !p.docs.get('big').ot.outstanding), 20000);
  ok(conv, '300 concurrent edits from 3 people converged over the relay');

  await G2.call('collab:send', { type: 'chat', text: 'hi through cloudflare' });
  ok(await waitFor(() => G1.msgs.some((m) => m.type === 'chat' && m.text === 'hi through cloudflare') && H.msgs.some((m) => m.type === 'chat')), 'chat reaches everyone');

  let err = null; t = Date.now();
  try { await BAD.call('collab:join', { code: 'AAAA-BBBB-CCCC-DDDD', name: 'mallory' }); } catch (e) { err = e.message; }
  ok(err && /No session with this code/.test(err) && Date.now() - t < 5000, `wrong code answered fast (${Date.now() - t} ms): "${(err || '').slice(0, 55)}…"`);

  await G2.call('collab:leave');
  ok(await waitFor(() => H.msgs.some((m) => m.type === 'left' && m.peer.name === 'angela')), 'host notified when a guest leaves');
  await H.call('collab:leave');
  ok(await waitFor(() => G1.msgs.some((m) => m.type === 'ended' && !m.local)), 'guest notified when the host ends the session');
  await sleep(400);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
