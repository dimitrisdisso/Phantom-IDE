'use strict';
// Node.js debugger: launches the program with --inspect-brk and drives it over the
// Chrome DevTools Protocol (the same protocol VS Code / Chrome DevTools use).
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { abs, which } = require('../util');

let WS = globalThis.WebSocket;
if (!WS) { try { WS = require('ws'); } catch { /* resolved at start() */ } }

function urlToPath(u) {
  if (!u) return null;
  if (u.startsWith('file://')) { try { return fileURLToPath(u); } catch { return null; } }
  if (path.isAbsolute(u)) return u;
  return null;
}

module.exports = (core) => {
  const sessions = new Map();
  const breakpoints = new Map(); // abs file -> Set(line 1-based)
  let next = 1;
  core.onShutdown(() => { for (const s of sessions.values()) s.kill(); });

  class Session {
    constructor(id, child) {
      this.id = id; this.child = child; this.ws = null; this.seq = 1; this.pending = new Map();
      this.bpIds = new Map(); // file -> [breakpointId]
      this.scripts = new Map();
      this.paused = null; this.firstPause = true;
    }
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Debugger not connected'));
        const id = this.seq++;
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ id, method, params }));
      });
    }
    kill() { try { this.ws && this.ws.close(); } catch { /* */ } try { this.child.kill('SIGKILL'); } catch { /* */ } }
  }

  async function applyBreakpoints(s, file) {
    const old = s.bpIds.get(file) || [];
    for (const bid of old) await s.send('Debugger.removeBreakpoint', { breakpointId: bid }).catch(() => {});
    const ids = [];
    for (const line of breakpoints.get(file) || []) {
      const urlRegex = pathToFileURL(file).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$|^' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
      try {
        const r = await s.send('Debugger.setBreakpointByUrl', { lineNumber: line - 1, urlRegex });
        ids.push(r.breakpointId);
      } catch (e) { core.emit('debug:output', { id: s.id, stream: 'err', data: `[phantom] breakpoint ${path.basename(file)}:${line} failed: ${e.message}\n` }); }
    }
    s.bpIds.set(file, ids);
  }

  function onMessage(s, raw) {
    let msg; try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    if (msg.id && s.pending.has(msg.id)) {
      const p = s.pending.get(msg.id); s.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    const { method, params } = msg;
    if (method === 'Debugger.scriptParsed') { s.scripts.set(params.scriptId, params.url); return; }
    if (method === 'Debugger.paused') {
      if (s.firstPause && params.reason === 'Break on start' && !s.stopOnEntry) { s.firstPause = false; s.send('Debugger.resume').catch(() => {}); return; }
      s.firstPause = false;
      s.paused = params;
      const frames = params.callFrames.map((f) => ({
        id: f.callFrameId, fn: f.functionName || '(anonymous)', url: f.url || s.scripts.get(f.location.scriptId) || '',
        file: urlToPath(f.url || s.scripts.get(f.location.scriptId)), line: f.location.lineNumber + 1, column: f.location.columnNumber + 1,
        scopes: f.scopeChain.map((sc) => ({ type: sc.type, name: sc.name, objectId: sc.object.objectId }))
      }));
      core.emit('debug:paused', { id: s.id, reason: params.reason, frames, hit: params.hitBreakpoints || [] });
      return;
    }
    if (method === 'Debugger.resumed') { s.paused = null; core.emit('debug:resumed', { id: s.id }); return; }
    if (method === 'Runtime.consoleAPICalled') {
      const text = params.args.map((a) => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description || a.unserializableValue || a.type)).join(' ');
      core.emit('debug:output', { id: s.id, stream: params.type === 'error' || params.type === 'warning' ? 'err' : 'console', data: text + '\n' });
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') { setTimeout(() => { try { s.ws && s.ws.close(); } catch { /* */ } }, 50); return; }
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      core.emit('debug:output', { id: s.id, stream: 'err', data: (d.exception && d.exception.description || d.text) + '\n' });
    }
  }

  function preview(o) {
    if (!o) return 'undefined';
    if (o.type === 'string') return JSON.stringify(o.value);
    if (o.type === 'undefined') return 'undefined';
    if (o.value !== undefined) return String(o.value);
    if (o.unserializableValue) return o.unserializableValue;
    if (o.preview && o.preview.properties) {
      const inner = o.preview.properties.slice(0, 5).map((p) => (o.subtype === 'array' ? '' : p.name + ': ') + (p.type === 'string' ? JSON.stringify(p.value) : p.value)).join(', ');
      return o.subtype === 'array' ? `[${inner}${o.preview.overflow ? ', …' : ''}]` : `${o.className && o.className !== 'Object' ? o.className + ' ' : ''}{${inner}${o.preview.overflow ? ', …' : ''}}`;
    }
    return o.description || o.type;
  }

  const get = (id) => { const s = sessions.get(id); if (!s) throw new Error('No such debug session'); return s; };

  return {
    'debug:setBreakpoints': async (file, lines) => {
      file = abs(file);
      const set = new Set((lines || []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
      if (set.size) breakpoints.set(file, set); else breakpoints.delete(file);
      for (const s of sessions.values()) await applyBreakpoints(s, file);
      return [...set];
    },
    'debug:start': async ({ program, cwd, args = [], runtime, stopOnEntry = false } = {}) => {
      if (!WS) throw new Error('No WebSocket implementation available');
      program = abs(program);
      const node = runtime || (core.hooks.window ? which('node') : process.execPath) || which('node');
      if (!node) throw new Error('Node.js not found on PATH — install Node to debug JavaScript');
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      const child = spawn(node, ['--inspect-brk=127.0.0.1:0', program, ...args.map(String)], { cwd: cwd ? abs(cwd) : path.dirname(program), env });
      const id = next++;
      const s = new Session(id, child);
      s.stopOnEntry = !!stopOnEntry;
      sessions.set(id, s);
      child.stdout.on('data', (d) => core.emit('debug:output', { id, stream: 'out', data: d.toString() }));
      let errBuf = '';
      const wsUrl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for the inspector')), 10000);
        child.stderr.on('data', (d) => {
          const t = d.toString();
          if (!s.ws) {
            errBuf += t;
            const m = /Debugger listening on (ws:\/\/\S+)/.exec(errBuf);
            if (m) { clearTimeout(timer); resolve(m[1]); }
            return;
          }
          if (/Waiting for the debugger to disconnect/.test(t)) { try { s.ws && s.ws.close(); } catch { /* */ } }
          if (/^(Debugger attached\.|Waiting for the debugger to disconnect\.\.\.|For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector)\s*$/m.test(t.trim())) return;
          core.emit('debug:output', { id, stream: 'err', data: t });
        });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Program exited (${code}) before the debugger attached:\n${errBuf}`)); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
      }).catch((e) => { sessions.delete(id); throw e; });

      child.removeAllListeners('exit');
      child.on('exit', (code, signal) => {
        sessions.delete(id);
        core.emit('debug:ended', { id, code, signal });
        core.event('DEBUG', `session #${id} ended (${signal || code})`);
      });

      await new Promise((resolve, reject) => {
        const ws = new WS(wsUrl);
        s.ws = ws;
        const onOpen = () => resolve();
        const onErr = (e) => reject(new Error('Inspector connection failed: ' + (e.message || e.type || 'error')));
        if (ws.addEventListener) {
          ws.addEventListener('open', onOpen, { once: true });
          ws.addEventListener('error', onErr, { once: true });
          ws.addEventListener('message', (ev) => onMessage(s, ev.data));
          ws.addEventListener('close', () => { s.ws = null; });
        } else {
          ws.once('open', onOpen); ws.once('error', onErr);
          ws.on('message', (d) => onMessage(s, d)); ws.on('close', () => { s.ws = null; });
        }
      });

      await s.send('Runtime.enable');
      await s.send('Debugger.enable');
      await s.send('Debugger.setPauseOnExceptions', { state: 'uncaught' });
      for (const file of breakpoints.keys()) await applyBreakpoints(s, file);
      await s.send('Runtime.runIfWaitingForDebugger');
      core.event('DEBUG', `session #${id} attached: ${path.basename(program)} (pid ${child.pid})`);
      return { id, pid: child.pid };
    },
    'debug:resume': async (id) => { await get(id).send('Debugger.resume'); return true; },
    'debug:pause': async (id) => { await get(id).send('Debugger.pause'); return true; },
    'debug:stepOver': async (id) => { await get(id).send('Debugger.stepOver'); return true; },
    'debug:stepInto': async (id) => { await get(id).send('Debugger.stepInto'); return true; },
    'debug:stepOut': async (id) => { await get(id).send('Debugger.stepOut'); return true; },
    'debug:pauseOnExceptions': async (id, state) => { await get(id).send('Debugger.setPauseOnExceptions', { state: ['none', 'uncaught', 'all'].includes(state) ? state : 'uncaught' }); return true; },
    'debug:stop': async (id) => { const s = sessions.get(id); if (s) s.kill(); return true; },
    'debug:properties': async (id, objectId) => {
      const r = await get(id).send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
      return (r.result || []).filter((p) => p.value || p.get).slice(0, 500).map((p) => ({
        name: p.name, type: p.value ? (p.value.subtype || p.value.type) : 'accessor',
        value: p.value ? preview(p.value) : '(getter)', objectId: p.value && p.value.type === 'object' && p.value.subtype !== 'null' ? p.value.objectId : null
      }));
    },
    'debug:evaluate': async (id, callFrameId, expression) => {
      const s = get(id);
      const r = callFrameId && s.paused
        ? await s.send('Debugger.evaluateOnCallFrame', { callFrameId, expression: String(expression), generatePreview: true })
        : await s.send('Runtime.evaluate', { expression: String(expression), generatePreview: true, replMode: true });
      if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
      return { value: preview(r.result), type: r.result.subtype || r.result.type, objectId: r.result.type === 'object' ? r.result.objectId : null };
    },
    'debug:sessions': async () => [...sessions.keys()]
  };
};
