'use strict';
// Internet (peer-to-peer) collaboration test: a host and a guest find each other on the public
// Hyperswarm DHT using ONLY the session code (no address), then edit and chat. Needs internet.
// Usage: node tools/p2p-test.js
process.env.PHANTOM_P2P_TIMEOUT = process.env.PHANTOM_P2P_TIMEOUT || '20000';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createCore } = require('../main/registry');

const mk = (label) => {
  const listeners = [];
  const core = createCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-p2p-' + label + '-')), emit: (ch, p) => { if (ch === 'collab:msg') listeners.forEach((f) => f(p)); } });
  return { core, call: (ch, ...a) => core.handlers.get(ch)(...a), on: (f) => listeners.push(f) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return false; };
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m', m); } else { fail++; console.log('  \x1b[31m✗\x1b[0m', m); } };

(async () => {
  console.log('\ninternet collaboration (peer-to-peer, code only)');
  const H = mk('host'); const G = mk('guest'); const BAD = mk('bad');
  const hostMsgs = []; const guestMsgs = [];
  H.on((m) => hostMsgs.push(m)); G.on((m) => guestMsgs.push(m));
  const port = 48000 + Math.floor(Math.random() * 1000);
  const t0 = Date.now();
  const session = await H.call('collab:host', { name: 'elliot', port });
  ok(session.p2p === 'connecting', `host started, announcing code ${session.code} on the DHT`);
  ok(await waitFor(() => hostMsgs.some((m) => m.type === 'p2p' && m.state === 'online'), 30000), `host is reachable over the internet (${Date.now() - t0} ms)`);

  const t1 = Date.now();
  const w = await G.call('collab:join', { code: session.code, name: 'darlene' });
  ok(w.hostName === 'elliot' && w.peers.length === 2, `guest joined with only the code via ${w.host} (${Date.now() - t1} ms)`);

  await H.call('collab:send', { type: 'share', id: 'd1', name: 'main.py', text: 'print(1)\n' });
  await G.call('collab:send', { type: 'open', id: 'd1' });
  ok(await waitFor(() => guestMsgs.some((m) => m.type === 'doc' && m.text === 'print(1)\n')), 'guest received the shared file over the internet link');
  await G.call('collab:send', { type: 'op', id: 'd1', rev: 0, op: [9, 'print(2)\n'] });
  ok(await waitFor(() => hostMsgs.some((m) => m.type === 'op' && m.id === 'd1')), 'guest edit reached the host');
  await H.call('collab:send', { type: 'chat', text: 'hello over p2p' });
  ok(await waitFor(() => guestMsgs.some((m) => m.type === 'chat' && m.text === 'hello over p2p')), 'chat reaches the guest');

  let err = null; const t2 = Date.now();
  try { await BAD.call('collab:join', { code: 'AAAA-BBBB-CCCC-DDDD', name: 'mallory' }); } catch (e) { err = e.message; }
  ok(err && /No session found/.test(err), `a wrong code finds no session (${Date.now() - t2} ms): "${(err || '').slice(0, 60)}…"`);

  await H.call('collab:leave');
  ok(await waitFor(() => guestMsgs.some((m) => m.type === 'ended')), 'guest notified when the host ends the session');
  await sleep(500);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
