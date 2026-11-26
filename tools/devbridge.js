'use strict';
// Development/test harness: serves the real renderer over HTTP and exposes the real backend
// services through POST /invoke + Server-Sent Events, emulating the Electron preload bridge.
// This is NOT part of the shipped app. Usage: node tools/devbridge.js [port] [dataDir]
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../main/registry');

const PORT = Number(process.argv[2]) || 5199;
const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const ALT = '/opt/npm-tools/node_modules';
const pick = (...c) => c.find((p) => fs.existsSync(p)) || c[0];
const MOUNTS = [
  ['/vendor/monaco/', path.join(NM, 'monaco-editor', 'min')],
  ['/vendor/xterm/', path.join(NM, '@xterm', 'xterm')],
  ['/vendor/xterm-fit/', path.join(NM, '@xterm', 'addon-fit')],
  ['/vendor/xterm-search/', path.join(NM, '@xterm', 'addon-search')],
  ['/vendor/xterm-links/', path.join(NM, '@xterm', 'addon-web-links')],
  ['/vendor/marked/', pick(path.join(NM, 'marked'), path.join(ALT, 'marked'))],
  ['/vendor/dompurify/', pick(path.join(NM, 'dompurify'), path.join(ALT, 'dompurify'))],
  ['/', path.join(ROOT, 'renderer')]
];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

const clients = new Set();
const core = createCore({
  dataDir: process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-dev-')),
  emit: (channel, payload) => { const msg = `data: ${JSON.stringify([channel, payload])}\n\n`; for (const c of clients) c.write(msg); },
  platformHooks: { versions: { node: process.versions.node, electron: 'devbridge', chrome: 'headless' } }
});

const SHIM = `(() => {
  const listeners = new Map();
  const es = new EventSource('/events');
  es.onmessage = (m) => { const [ch, p] = JSON.parse(m.data); const s = listeners.get(ch); if (s) for (const f of s) { try { f(p); } catch (e) { console.error(e); } } };
  window.phantom = {
    platform: ${JSON.stringify(process.platform)},
    async invoke(channel, ...args) {
      const r = await fetch('/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, args }) }).then((x) => x.json());
      if (r.__ok) return r.v; throw new Error(r.__err);
    },
    on(channel, fn) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); return () => listeners.get(channel).delete(fn); }
  };
})();`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(':ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (u.pathname === '/invoke' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    const { channel, args } = JSON.parse(body);
    const fn = core.handlers.get(channel);
    let out;
    if (!fn) out = { __err: 'unknown channel ' + channel };
    else { try { out = { __ok: true, v: await fn(...(args || [])) }; } catch (e) { out = { __err: e.message }; } }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out === undefined ? { __ok: true } : out)); return;
  }
  if (u.pathname === '/__bridge.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(SHIM); return; }
  const p = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
  for (const [prefix, dir] of MOUNTS) {
    if (!p.startsWith(prefix)) continue;
    const file = path.normalize(path.join(dir, p.slice(prefix.length)));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) break;
    let data = fs.readFileSync(file);
    if (file.endsWith('index.html')) data = Buffer.from(data.toString().replace('<link rel="stylesheet" href="vendor/xterm', '<script src="__bridge.js"></script>\n  <link rel="stylesheet" href="vendor/xterm'));
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data); return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`devbridge on http://127.0.0.1:${PORT}`));
process.on('SIGTERM', async () => { await core.shutdown(); process.exit(0); });
