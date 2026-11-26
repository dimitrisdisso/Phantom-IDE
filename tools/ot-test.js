'use strict';
// Randomised tests for the OT engine: transform/compose laws and a full multi-client simulation
// with arbitrary network delays. Usage: node tools/ot-test.js
const { TextOperation, OTClient, OTServer } = require('../renderer/js/shared/ot.js');
let seed = Number(process.argv[2]) || 1234;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n) => Math.floor(rnd() * n);
const ALPH = 'abcdefgh \nαβ😀';
const rstr = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ALPH[ri(ALPH.length)]; return s; };
function randomOp(str) {
  const op = new TextOperation(); let left = str.length;
  while (left > 0) {
    const n = 1 + ri(Math.min(left, 20)); const r = rnd();
    if (r < 0.2) op.insert(rstr(1 + ri(10)));
    else if (r < 0.4) { op.delete(n); left -= n; }
    else { op.retain(n); left -= n; }
  }
  if (rnd() < 0.3) op.insert(rstr(1 + ri(10)));
  return op;
}
let fails = 0;
const check = (c, m) => { if (!c) { fails++; if (fails < 10) console.log('FAIL', m); } };

// laws
for (let i = 0; i < 3000; i++) {
  const s = rstr(ri(60));
  const a = randomOp(s); const b = randomOp(s);
  const [a1, b1] = TextOperation.transform(a, b);
  check(b1.apply(a.apply(s)) === a1.apply(b.apply(s)), 'transform convergence');
  const c = randomOp(a.apply(s));
  check(a.compose(c).apply(s) === c.apply(a.apply(s)), 'compose');
  check(TextOperation.fromJSON(JSON.parse(JSON.stringify(a))).apply(s) === a.apply(s), 'json roundtrip');
  const t = rstr(ri(60));
  check(TextOperation.fromDiff(s, t).apply(s) === t, 'fromDiff');
}

// simulation: server + N clients with random message delays (FIFO per link, like TCP)
for (let round = 0; round < 300; round++) {
  const start = rstr(ri(40));
  const server = new OTServer(start);
  const N = 2 + ri(3);
  const clients = [];
  const toServer = []; // [clientIdx, rev, op]
  const toClient = Array.from({ length: N }, () => []);
  for (let k = 0; k < N; k++) {
    const c = { doc: start };
    c.ot = new OTClient(0, (rev, op) => toServer.push([k, rev, TextOperation.fromJSON(JSON.parse(JSON.stringify(op)))]), (op) => { c.doc = op.apply(c.doc); });
    clients.push(c);
  }
  for (let step = 0; step < 200; step++) {
    const r = rnd();
    if (r < 0.4) { const k = ri(N); const c = clients[k]; const op = randomOp(c.doc); c.doc = op.apply(c.doc); c.ot.applyClient(op); }
    else if (r < 0.7 && toServer.length) {
      const [k, rev, op] = toServer.shift();
      const applied = server.receive(rev, op);
      for (let j = 0; j < N; j++) toClient[j].push(j === k ? { ack: true } : { op: TextOperation.fromJSON(JSON.parse(JSON.stringify(applied))) });
    } else { const j = ri(N); const m = toClient[j].shift(); if (m) m.ack ? clients[j].ot.serverAck() : clients[j].ot.applyServer(m.op); }
  }
  // drain
  for (let guard = 0; guard < 100000 && (toServer.length || toClient.some((q) => q.length)); guard++) {
    if (toServer.length) { const [k, rev, op] = toServer.shift(); const applied = server.receive(rev, op); for (let j = 0; j < N; j++) toClient[j].push(j === k ? { ack: true } : { op: applied }); }
    for (let j = 0; j < N; j++) { const m = toClient[j].shift(); if (m) m.ack ? clients[j].ot.serverAck() : clients[j].ot.applyServer(m.op); }
  }
  for (const c of clients) check(c.doc === server.text, `round ${round}: client diverged`);
}
console.log(fails ? `${fails} failures` : 'OT engine: 3000 law checks + 300 multi-client simulations converged');
process.exit(fails ? 1 : 0);
