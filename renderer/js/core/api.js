// Thin client over the preload bridge plus an in-renderer event bus.
const bridge = window.phantom;
if (!bridge) document.body.innerHTML = '<pre style="color:#ff3b5c;padding:30px">PHANTOM bridge missing — the renderer must be loaded by the Electron main process.</pre>';

export const platform = bridge ? bridge.platform : 'linux';

export function call(channel, ...args) { return bridge.invoke(channel, ...args); }
export function on(channel, fn) { return bridge.on(channel, fn); }

class Bus {
  constructor() { this.map = new Map(); }
  on(ev, fn) { if (!this.map.has(ev)) this.map.set(ev, new Set()); this.map.get(ev).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { const s = this.map.get(ev); if (s) s.delete(fn); }
  emit(ev, ...a) { const s = this.map.get(ev); if (s) for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error(`[bus:${ev}]`, e); } } }
}
export const bus = new Bus();

/** Shared pollers: one backend request per interval no matter how many windows listen. */
const pollers = new Map();
export function poll(channel, ms, fn, ...args) {
  const key = channel + JSON.stringify(args) + ':' + ms;
  let p = pollers.get(key);
  if (!p) {
    p = { subs: new Set(), timer: null, last: null, busy: false };
    const tick = async () => {
      if (p.busy || document.hidden) return;
      const active = [...p.subs].filter((s) => s.active());
      if (!active.length) return;
      p.busy = true;
      try { p.last = await call(channel, ...args); for (const s of active) s.fn(p.last); } catch (e) { for (const s of active) s.err && s.err(e); }
      p.busy = false;
    };
    p.tick = tick;
    p.timer = setInterval(tick, ms);
    pollers.set(key, p);
  }
  const sub = { fn, active: () => true, err: null };
  p.subs.add(sub);
  if (p.last) setTimeout(() => fn(p.last), 0);
  setTimeout(p.tick, 0);
  const handle = {
    when(pred) { sub.active = pred; return handle; },
    onError(f) { sub.err = f; return handle; },
    now() { p.tick(); },
    stop() { p.subs.delete(sub); if (!p.subs.size) { clearInterval(p.timer); pollers.delete(key); } }
  };
  return handle;
}

/** Rolling telemetry history shared by monitors and the top bar. */
export const telemetry = { history: [], max: 180, listeners: new Set(), static: null };
let telemetryHandle = null;
export function startTelemetry() {
  if (telemetryHandle) return;
  telemetryHandle = poll('sys:snapshot', 1000, (s) => {
    const h = telemetry.history;
    if (h.length && h[h.length - 1].ts === s.ts) return;
    h.push(s);
    if (h.length > telemetry.max) h.shift();
    for (const l of telemetry.listeners) l(s, h);
  });
  call('sys:static').then((s) => { telemetry.static = s; }).catch(() => {});
}
export function onTelemetry(fn) { telemetry.listeners.add(fn); if (telemetry.history.length) fn(telemetry.history[telemetry.history.length - 1], telemetry.history); return () => telemetry.listeners.delete(fn); }
