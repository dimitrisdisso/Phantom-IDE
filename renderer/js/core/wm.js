// PHANTOM window manager: floating, snapping, magnetic, multi-workspace windows.
import { h, icon, esc } from './dom.js';
import { bus } from './api.js';
import { settings } from './settings.js';
import { menu, prompt, toast } from './ui.js';

const TITLE_H = 24;
const DEFAULT_WORKSPACES = 4;
const MAX_WORKSPACES = 9;
const MIN_W = 140; const MIN_H = 80; // matches .pw min-width / min-height in wm.css
const EDGE = 8; // px from desktop edge that triggers snap zones
const CORNER = 48;

let nextId = 1;

class Win {
  constructor(wm, app, opts) {
    this.wm = wm; this.app = app; this.id = nextId++;
    this.ws = opts.workspace ?? wm.active;
    this.min = false; this.max = false; this.pinned = !!opts.pinned;
    this.snapZone = null; this.restoreRect = null;
    this.title = opts.title || app.title;
    this.rect = { x: 0, y: 0, w: app.size[0], h: app.size[1] };
    this.instance = null; this.resizeFns = new Set(); this.z = 0;
    this.build();
  }
  build() {
    const ctrl = h('div.pw-ctrl',
      this.pinBtn = h('button.pin', { title: 'Always on top', html: icon('pin'), on: { click: () => this.wm.setPinned(this, !this.pinned) } }),
      h('button.minb', { title: 'Minimize', html: icon('min'), on: { click: () => this.wm.minimize(this) } }),
      this.maxBtn = h('button.maxb', { title: 'Maximize', html: icon('max'), on: { click: () => this.wm.toggleMax(this) } }),
      h('button.close', { title: 'Close', html: icon('close'), on: { click: () => this.wm.close(this) } })
    );
    this.titleEl = h('div.pw-title',
      h('span.pw-icon', { html: icon(this.app.icon) }),
      this.nameEl = h('span.pw-name', this.title),
      this.subEl = h('span.pw-sub', h('span')),
      this.badgeEl = h('span.pw-badge'),
      ctrl
    );
    this.body = h('div.pw-body');
    this.sizeEl = h('div.pw-size');
    this.el = h('div.pw', { 'data-app': this.app.id }, this.titleEl, this.body, this.sizeEl,
      ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div.pw-rz.' + d, { 'data-dir': d })));
    this.el.addEventListener('pointerdown', () => this.wm.focus(this), true);
    this.titleEl.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('button')) this.wm.beginDrag(this, e); });
    this.titleEl.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) this.wm.toggleMax(this); });
    this.titleEl.addEventListener('contextmenu', (e) => { e.preventDefault(); this.wm.windowMenu(this, e.clientX, e.clientY); });
    this.titleEl.addEventListener('auxclick', (e) => { if (e.button === 1) this.wm.close(this); });
    for (const rz of this.el.querySelectorAll('.pw-rz')) rz.addEventListener('pointerdown', (e) => { if (e.button === 0) this.wm.beginResize(this, e, rz.dataset.dir); });
    let raf = 0;
    this.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { for (const f of this.resizeFns) { try { f(); } catch (err) { console.error(err); } } }); });
    this.ro.observe(this.body);
  }
  // ── API for apps ──
  setSub(text) { this.subEl.firstChild.textContent = text || ''; this.sub = text || ''; this.wm.changed('meta'); }
  setTitle(text) { this.title = text || this.app.title; this.nameEl.textContent = this.title; this.wm.changed('meta'); }
  setBadge(text) { this.badgeEl.textContent = text || ''; }
  onResize(fn) { this.resizeFns.add(fn); return () => this.resizeFns.delete(fn); }
  get visible() { return !this.min && this.ws === this.wm.active && !this.closed; }
  get focused() { return this.wm.focused === this; }
  close() { return this.wm.close(this); }
  focus() { this.wm.focus(this); }
  save() { this.wm.changed('state'); }
}

export class WindowManager {
  constructor() {
    this.apps = new Map(); this.windows = []; this.active = 0; this.focused = null; this.z = 10;
    this.history = []; // focus order (most recent last)
    this.count = DEFAULT_WORKSPACES;
    this.fsWin = null; // the window currently shown full screen
    this.label = (i) => `Workspace ${i + 1}`; // replaced by core/workspaces.js with the user's names
  }

  init(desktop) {
    this.desk = desktop;
    this.preview = desktop.querySelector('#snap-preview');
    this.guides = desktop.querySelector('#guides');
    new ResizeObserver(() => this.onDesktopResize()).observe(desktop);
    this.lastDesk = { w: desktop.clientWidth, h: desktop.clientHeight };
  }

  register(app) {
    app.size = app.size || [720, 460];
    app.min = app.min || [260, 140];
    this.apps.set(app.id, app);
  }

  get W() { return this.desk.clientWidth; }
  get H() { return this.desk.clientHeight; }

  // ───────── lifecycle ─────────
  async open(appId, opts = {}) {
    const app = this.apps.get(appId);
    if (!app) { toast(`unknown tool: ${appId}`, 'error'); return null; }
    if (app.singleton) {
      const ex = this.windows.find((w) => w.app.id === appId);
      if (ex) { if (ex.ws !== this.active) this.moveToWorkspace(ex, this.active); this.restore(ex); this.focus(ex); if (opts.state && ex.instance && ex.instance.apply) ex.instance.apply(opts.state); return ex; }
    }
    const win = new Win(this, app, opts);
    win.ws = Math.max(0, Math.min(win.ws, this.count - 1));
    if (opts.rect) win.rect = { ...opts.rect };
    else win.rect = this.placeNew(app.size);
    if (opts.rect) this.fit(win);
    this.windows.push(win);
    this.desk.appendChild(win.el);
    win.el.classList.add('opening');
    setTimeout(() => win.el.classList.remove('opening'), 200);
    if (win.pinned) win.pinBtn.classList.add('on'), win.el.classList.add('pinned');
    this.render(win);
    if (opts.maximized) this.maximize(win, true);
    else if (opts.snap) this.snap(win, opts.snap, true);
    if (opts.focus !== false) this.focus(win); else { win.z = ++this.z; this.stack(win); }
    try {
      win.instance = (await app.create(win, opts.state || {})) || {};
    } catch (e) {
      console.error(e);
      win.body.innerHTML = `<div class="empty"><div><b>TOOL CRASHED</b>${esc(e.message)}</div></div>`;
      win.instance = {};
    }
    if (opts.minimized) this.minimize(win, true);
    this.sync(win);
    this.changed('open');
    bus.emit('wm:open', win);
    return win;
  }

  async close(win, force = false) {
    if (win.closed) return true;
    if (!force && win.instance && win.instance.canClose) {
      const ok = await win.instance.canClose();
      if (!ok) return false;
    }
    if (this.fsWin === win) this.exitFullscreen();
    win.closed = true;
    try { win.instance && win.instance.destroy && win.instance.destroy(); } catch (e) { console.error(e); }
    win.ro.disconnect();
    this.windows = this.windows.filter((w) => w !== win);
    this.history = this.history.filter((w) => w !== win);
    win.el.classList.add('closing');
    setTimeout(() => win.el.remove(), 130);
    if (this.focused === win) { this.focused = null; this.focusTop(); }
    this.changed('close');
    bus.emit('wm:close', win);
    return true;
  }

  async closeAll(ws = null) {
    for (const w of [...this.windows]) if (ws === null || w.ws === ws) if (!(await this.close(w))) return false;
    return true;
  }

  placeNew([w, hgt]) {
    const W = this.W; const H = this.H;
    w = Math.min(w, W - 20); hgt = Math.min(hgt, H - 20);
    // Cascade from the focused window, otherwise centre-ish with jitter.
    const vis = this.windows.filter((x) => x.visible);
    let x; let y;
    if (this.focused && this.focused.visible && !this.focused.max) { x = this.focused.rect.x + 28; y = this.focused.rect.y + 28; }
    else { x = (W - w) / 2 + (vis.length % 5) * 24 - 48; y = (H - hgt) / 2.4 + (vis.length % 5) * 24 - 48; }
    if (x + w > W - 4 || y + hgt > H - 4) { x = 20 + (vis.length % 6) * 24; y = 16 + (vis.length % 6) * 24; }
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w: Math.round(w), h: Math.round(hgt) };
  }

  // ───────── rendering ─────────
  render(win) {
    const r = win.max ? { x: 0, y: 0, w: this.W, h: this.H } : win.rect;
    const s = win.el.style;
    s.left = r.x + 'px'; s.top = r.y + 'px'; s.width = r.w + 'px'; s.height = r.h + 'px';
  }
  stack(win) { win.el.style.zIndex = String((win.pinned ? 20000 : 0) + win.z); }
  sync(win) {
    const vis = win.visible;
    const was = win.el.style.display !== 'none';
    win.el.style.display = vis ? '' : 'none';
    win.el.classList.toggle('max', win.max);
    win.maxBtn.innerHTML = icon(win.max ? 'restore' : 'max');
    if (vis && !was && win.instance && win.instance.onShow) setTimeout(() => win.instance.onShow(), 0);
    if (!vis && was && win.instance && win.instance.onHide) win.instance.onHide();
  }

  focus(win) {
    if (!win || win.closed) return;
    if (this.fsWin && this.fsWin !== win) this.exitFullscreen();
    if (this.focused !== win) {
      if (this.focused) this.focused.el.classList.remove('focus');
      this.focused = win;
      win.el.classList.add('focus');
      this.history = this.history.filter((w) => w !== win); this.history.push(win);
      if (win.instance && win.instance.onFocus) win.instance.onFocus();
      bus.emit('wm:focus', win);
    }
    if (win.z !== this.z) { win.z = ++this.z; this.stack(win); }
    if (this.z > 15000) this.normalizeZ();
    this.changed('focus', true);
  }
  normalizeZ() {
    const sorted = [...this.windows].sort((a, b) => a.z - b.z);
    sorted.forEach((w, i) => { w.z = 10 + i; this.stack(w); });
    this.z = 10 + sorted.length;
  }
  focusTop() {
    let cands = this.history.filter((w) => w.visible);
    if (!cands.length) cands = this.windows.filter((w) => w.visible).sort((a, b) => (a.pinned - b.pinned) || a.z - b.z);
    const top = cands[cands.length - 1];
    if (top) this.focus(top); else if (this.focused) { this.focused.el.classList.remove('focus'); this.focused = null; this.changed('focus', true); }
  }
  /** Most recently focused window of an app on the current workspace (null if it has none). */
  recent(appId) {
    const list = this.history.filter((w) => w.app.id === appId && !w.closed).reverse();
    const rest = this.windows.filter((w) => w.app.id === appId && !list.includes(w)).sort((a, b) => b.z - a.z);
    const all = [...list, ...rest];
    return all.find((w) => w.ws === this.active && !w.min) || all.find((w) => w.ws === this.active) || null;
  }
  ofApp(appId) { return this.windows.filter((w) => w.app.id === appId); }

  // ───────── state changes ─────────
  minimize(win, instant = false) {
    if (win.min) return;
    if (this.fsWin === win) this.exitFullscreen();
    const btn = document.querySelector(`#taskbar .task[data-win="${win.id}"]`);
    if (!instant && btn && !settings.reduceMotion) {
      const a = win.el.getBoundingClientRect(); const b = btn.getBoundingClientRect();
      win.el.classList.add('minimizing');
      win.el.style.transformOrigin = '0 0';
      win.el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width}, ${b.height / a.height})`;
      setTimeout(() => { win.el.classList.remove('minimizing'); win.el.style.transform = ''; win.min = true; this.sync(win); }, 180);
    } else { win.min = true; this.sync(win); }
    win.min = true;
    if (this.focused === win) { win.el.classList.remove('focus'); this.focused = null; this.history = this.history.filter((w) => w !== win); this.history.unshift(win); this.focusTop(); }
    this.changed('min');
  }
  restore(win) {
    if (!win.min) return;
    win.min = false;
    win.el.classList.add('opening');
    setTimeout(() => win.el.classList.remove('opening'), 200);
    this.sync(win); this.changed('restore');
  }
  // ───────── full screen (one window covers the whole screen; the chrome is hidden) ─────────
  toggleFullscreen(win) { if (this.fsWin === win) this.exitFullscreen(); else this.enterFullscreen(win); }
  enterFullscreen(win) {
    if (!win || win.closed) return;
    this.exitFullscreen();
    this.restore(win);
    this.fsWin = win;
    win.el.classList.add('fullscreen'); document.body.classList.add('win-full');
    this.focus(win);
    bus.emit('wm:fullscreen', true);
  }
  exitFullscreen() {
    const win = this.fsWin; if (!win) return;
    this.fsWin = null;
    win.el.classList.remove('fullscreen'); document.body.classList.remove('win-full');
    this.render(win);
    bus.emit('wm:fullscreen', false);
  }

  maximize(win, quiet) {
    if (this.fsWin === win) this.exitFullscreen();
    if (!win.max) { win.max = true; win.snapZone = null; this.animate(win); this.render(win); this.sync(win); if (!quiet) this.changed('max'); }
  }
  unmaximize(win) {
    if (this.fsWin === win) this.exitFullscreen();
    if (win.max) { win.max = false; this.animate(win); this.render(win); this.sync(win); this.changed('max'); }
  }
  toggleMax(win) { win.max ? this.unmaximize(win) : this.maximize(win); }
  setPinned(win, v) {
    win.pinned = v;
    win.pinBtn.classList.toggle('on', v); win.el.classList.toggle('pinned', v);
    this.stack(win); this.changed('pin');
    toast(v ? `${win.title}: always on top` : `${win.title}: normal stacking`, 'info', 'WINDOW', 1500);
  }
  animate(win) {
    if (settings.reduceMotion) return;
    win.el.classList.add('animate-rect');
    clearTimeout(win.animT); win.animT = setTimeout(() => win.el.classList.remove('animate-rect'), 200);
  }

  zoneRect(zone) {
    const W = this.W; const H = this.H; const hw = Math.round(W / 2); const hh = Math.round(H / 2);
    const t3 = Math.round(W / 3);
    return {
      left: { x: 0, y: 0, w: hw, h: H }, right: { x: hw, y: 0, w: W - hw, h: H },
      top: { x: 0, y: 0, w: W, h: hh }, bottom: { x: 0, y: hh, w: W, h: H - hh },
      tl: { x: 0, y: 0, w: hw, h: hh }, tr: { x: hw, y: 0, w: W - hw, h: hh },
      bl: { x: 0, y: hh, w: hw, h: H - hh }, br: { x: hw, y: hh, w: W - hw, h: H - hh },
      l3: { x: 0, y: 0, w: t3, h: H }, c3: { x: t3, y: 0, w: t3, h: H }, r3: { x: 2 * t3, y: 0, w: W - 2 * t3, h: H },
      center: { x: Math.round(W * 0.15), y: Math.round(H * 0.1), w: Math.round(W * 0.7), h: Math.round(H * 0.8) },
      max: { x: 0, y: 0, w: W, h: H }
    }[zone];
  }
  snap(win, zone, quiet) {
    if (this.fsWin === win) this.exitFullscreen();
    if (zone === 'max') return this.maximize(win, quiet);
    const r = this.zoneRect(zone); if (!r) return;
    if (!win.snapZone && !win.max) win.restoreRect = { ...win.rect };
    win.max = false; win.snapZone = zone; win.rect = { ...r };
    this.animate(win); this.render(win); this.sync(win);
    if (!quiet) this.changed('snap');
  }

  /** Leave a snapped / maximized state and return to the size the window had before it was snapped. */
  unsnap(win) {
    if (win.max) { this.unmaximize(win); return; }
    if (!win.snapZone) return;
    const r = win.restoreRect || this.zoneRect('center');
    win.snapZone = null; win.restoreRect = null;
    win.rect = { x: Math.max(0, Math.min(r.x, this.W - 80)), y: Math.max(0, Math.min(r.y, this.H - TITLE_H)), w: Math.min(r.w, this.W), h: Math.min(r.h, this.H) };
    this.animate(win); this.render(win); this.sync(win); this.changed('snap');
  }
  /** Win+arrow style arrangement of one window (bound to Ctrl+arrows and Ctrl+Alt+arrows). */
  arrowSnap(win, key) {
    if (!win || win.closed || win.min) return;
    if (this.fsWin === win) { this.exitFullscreen(); if (key === 'ArrowDown') return; }
    const z = win.max ? 'max' : win.snapZone;
    const go = (zone) => (zone === 'restore' ? this.unsnap(win) : zone === 'min' ? this.minimize(win) : this.snap(win, zone));
    const table = {
      ArrowLeft: { right: 'restore', tr: 'tl', br: 'bl', tl: 'tl', bl: 'bl', left: 'left', r3: 'c3', c3: 'l3', l3: 'l3' },
      ArrowRight: { left: 'restore', tl: 'tr', bl: 'br', tr: 'tr', br: 'br', right: 'right', l3: 'c3', c3: 'r3', r3: 'r3' },
      ArrowUp: { left: 'tl', right: 'tr', bl: 'left', br: 'right', bottom: 'restore', tl: 'tl', tr: 'tr', max: 'max' },
      ArrowDown: { max: 'restore', left: 'bl', right: 'br', tl: 'left', tr: 'right', top: 'restore', bl: 'bl', br: 'br' }
    }[key];
    if (!table) return;
    const fallback = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'max', ArrowDown: z ? 'restore' : 'min' }[key];
    go(table[z] || fallback);
  }

  // ───────── workspaces ─────────
  switchWorkspace(i) {
    if (i === this.active || i < 0 || i >= this.count) return;
    this.exitFullscreen();
    this.active = i;
    for (const w of this.windows) this.sync(w);
    this.focusTop();
    this.changed('workspace');
    bus.emit('wm:workspace', i);
  }
  moveToWorkspace(win, i) { if (i < 0 || i >= this.count) return; if (this.fsWin === win) this.exitFullscreen(); win.ws = i; this.sync(win); if (this.focused === win && i !== this.active) this.focusTop(); this.changed('workspace'); }
  workspaceCount() { return this.count; }
  maxWorkspaces() { return MAX_WORKSPACES; }
  setWorkspaceCount(n) { this.count = Math.max(1, Math.min(MAX_WORKSPACES, n | 0)); }
  /** Close a workspace's windows (each may veto) and renumber the ones after it. */
  async removeWorkspace(i) {
    if (this.count <= 1 || i < 0 || i >= this.count) return false;
    for (const w of [...this.windows]) if (w.ws === i && !(await this.close(w))) return false;
    this.exitFullscreen();
    for (const w of this.windows) if (w.ws > i) w.ws--;
    this.count--;
    if (this.active > i || this.active >= this.count) this.active = Math.max(0, this.active - 1);
    for (const w of this.windows) this.sync(w);
    this.focusTop();
    this.changed('workspace');
    return true;
  }

  // ───────── arrangement ─────────
  tile() {
    this.exitFullscreen();
    const vis = this.windows.filter((w) => w.visible);
    if (!vis.length) return;
    const n = vis.length; const cols = Math.ceil(Math.sqrt(n * (this.W / this.H) / 1.4)); const rows = Math.ceil(n / cols);
    const gap = 6;
    vis.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).forEach((w, i) => {
      const c = i % cols; const r = Math.floor(i / cols);
      const colsInRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
      const cw = (this.W - gap * (colsInRow + 1)) / colsInRow; const rh = (this.H - gap * (rows + 1)) / rows;
      w.max = false; w.snapZone = null;
      w.rect = { x: Math.round(gap + c * (cw + gap)), y: Math.round(gap + r * (rh + gap)), w: Math.round(cw), h: Math.round(rh) };
      this.animate(w); this.render(w); this.sync(w);
    });
    this.changed('tile');
  }
  cascade() {
    this.exitFullscreen();
    const vis = this.windows.filter((w) => w.visible).sort((a, b) => a.z - b.z);
    vis.forEach((w, i) => {
      w.max = false; w.snapZone = null;
      const ww = Math.min(w.app.size[0], this.W - 200); const hh = Math.min(w.app.size[1], this.H - 160);
      w.rect = { x: 24 + (i % 10) * 30, y: 16 + (i % 10) * 28, w: ww, h: hh };
      this.animate(w); this.render(w); this.sync(w);
    });
    this.changed('cascade');
  }
  showDesktop() {
    const vis = this.windows.filter((w) => w.visible);
    if (vis.length) { this._shown = vis; vis.forEach((w) => this.minimize(w, true)); }
    else if (this._shown) { this._shown.forEach((w) => this.restore(w)); this._shown = null; this.focusTop(); }
  }
  cycle(dir = 1) {
    const vis = this.windows.filter((w) => w.ws === this.active && !w.closed).sort((a, b) => a.id - b.id);
    if (!vis.length) return;
    const i = vis.indexOf(this.focused);
    const next = vis[(i + dir + vis.length) % vis.length];
    this.restore(next); this.focus(next);
  }

  // ───────── drag & resize ─────────
  magnetEdges(win) {
    const xs = [0, this.W]; const ys = [0, this.H];
    for (const w of this.windows) {
      if (w === win || !w.visible || w.max) continue;
      xs.push(w.rect.x, w.rect.x + w.rect.w); ys.push(w.rect.y, w.rect.y + w.rect.h);
    }
    return { xs, ys };
  }
  snapAxis(a, b, cands, t) {
    // a, b: the two edges of the moving rect on this axis. Returns {delta, at} or null.
    let best = null;
    for (const c of cands) {
      for (const e of [a, b]) {
        const d = c - e;
        if (Math.abs(d) <= t && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: c };
      }
    }
    return best;
  }
  showGuides(gx, gy) {
    this.guides.innerHTML = '';
    if (gx !== null && gx !== undefined) this.guides.appendChild(h('i.v', { style: { left: gx + 'px' } }));
    if (gy !== null && gy !== undefined) this.guides.appendChild(h('i.h', { style: { top: gy + 'px' } }));
  }
  detectZone(px, py) {
    if (!settings.snap) return null;
    const W = this.W; const H = this.H;
    const L = px <= EDGE; const R = px >= W - EDGE; const T = py <= EDGE; const B = py >= H - EDGE;
    if ((L && py < CORNER) || (T && px < CORNER)) return 'tl';
    if ((R && py < CORNER) || (T && px > W - CORNER)) return 'tr';
    if ((L && py > H - CORNER) || (B && px < CORNER)) return 'bl';
    if ((R && py > H - CORNER) || (B && px > W - CORNER)) return 'br';
    if (T) return 'max';
    if (L) return 'left';
    if (R) return 'right';
    if (B) return 'bottom';
    return null;
  }
  showPreview(zone) {
    const p = this.preview;
    if (!zone) { p.classList.remove('on'); return; }
    const r = this.zoneRect(zone);
    Object.assign(p.style, { left: r.x + 4 + 'px', top: r.y + 4 + 'px', width: r.w - 8 + 'px', height: r.h - 8 + 'px' });
    p.dataset.label = { max: 'MAXIMIZE', left: 'LEFT HALF', right: 'RIGHT HALF', bottom: 'BOTTOM HALF', tl: 'TOP LEFT', tr: 'TOP RIGHT', bl: 'BOTTOM LEFT', br: 'BOTTOM RIGHT' }[zone] || zone.toUpperCase();
    p.classList.add('on');
  }

  beginDrag(win, e) {
    if (this.fsWin === win) return;
    e.preventDefault();
    const deskR = this.desk.getBoundingClientRect();
    const sx = e.clientX; const sy = e.clientY;
    let r0 = { ...(win.max ? { x: 0, y: 0, w: this.W, h: this.H } : win.rect) };
    let moved = false; let zone = null;
    const target = e.currentTarget; target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - sx; const dy = ev.clientY - sy;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return;
        moved = true;
        document.body.classList.add('wm-busy'); win.el.classList.add('dragging');
        if (win.max || win.snapZone) {
          // Tear out of maximized/snapped state, keeping the grab point proportional.
          const rr = win.restoreRect || { w: win.app.size[0], h: win.app.size[1] };
          const ratio = (sx - deskR.left - r0.x) / r0.w;
          r0 = { x: Math.round(sx - deskR.left - ratio * rr.w), y: r0.y, w: rr.w, h: rr.h };
          win.max = false; win.snapZone = null; win.restoreRect = null;
          this.sync(win);
        }
      }
      let x = r0.x + dx; let y = r0.y + dy;
      let gx = null; let gy = null;
      if (settings.magnet > 0 && !ev.altKey) {
        const { xs, ys } = this.magnetEdges(win);
        const mx = this.snapAxis(x, x + r0.w, xs, settings.magnet); if (mx) { x += mx.delta; gx = mx.at; }
        const my = this.snapAxis(y, y + r0.h, ys, settings.magnet); if (my) { y += my.delta; gy = my.at; }
      }
      y = Math.max(0, Math.min(y, this.H - TITLE_H));
      x = Math.max(-r0.w + 80, Math.min(x, this.W - 80));
      win.rect = { x: Math.round(x), y: Math.round(y), w: r0.w, h: r0.h };
      this.render(win);
      this.showGuides(gx, gy);
      zone = ev.altKey ? null : this.detectZone(ev.clientX - deskR.left, ev.clientY - deskR.top);
      this.showPreview(zone);
    };
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
      document.body.classList.remove('wm-busy'); win.el.classList.remove('dragging');
      this.showPreview(null); this.showGuides();
      if (moved) {
        if (zone) { win.restoreRect = { ...r0, x: win.rect.x, y: win.rect.y }; this.snap(win, zone); if (zone === 'max') win.restoreRect = { ...r0 }; }
        this.changed('move');
      }
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }

  beginResize(win, e, dir) {
    e.preventDefault(); e.stopPropagation();
    if (win.max || this.fsWin === win) return;
    this.focus(win);
    const target = e.currentTarget; target.setPointerCapture(e.pointerId);
    const sx = e.clientX; const sy = e.clientY; const r0 = { ...win.rect };
    const [minW, minH] = win.app.min;
    const edges = this.magnetEdges(win);
    document.body.classList.add('wm-busy'); win.el.classList.add('resizing');
    win.snapZone = null;
    const move = (ev) => {
      const dx = ev.clientX - sx; const dy = ev.clientY - sy;
      let { x, y, w, h: hh } = r0; let gx = null; let gy = null;
      const t = ev.altKey ? 0 : settings.magnet;
      const near = (v, cands) => { for (const c of cands) if (Math.abs(c - v) <= t) return c; return null; };
      if (dir.includes('e')) { let right = r0.x + r0.w + dx; const c = near(right, edges.xs); if (c !== null) { right = c; gx = c; } w = Math.max(minW, right - x); }
      if (dir.includes('s')) { let bottom = r0.y + r0.h + dy; const c = near(bottom, edges.ys); if (c !== null) { bottom = c; gy = c; } hh = Math.max(minH, Math.min(bottom, this.H) - y); }
      if (dir.includes('w')) { let left = r0.x + dx; const c = near(left, edges.xs); if (c !== null) { left = c; gx = c; } left = Math.min(left, r0.x + r0.w - minW); w = r0.x + r0.w - left; x = left; }
      if (dir.includes('n')) { let top = Math.max(0, r0.y + dy); const c = near(top, edges.ys); if (c !== null) { top = c; gy = c; } top = Math.min(top, r0.y + r0.h - minH); hh = r0.y + r0.h - top; y = top; }
      win.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
      this.render(win);
      this.showGuides(gx, gy);
      win.sizeEl.textContent = `${win.rect.w}×${win.rect.h}`;
    };
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
      document.body.classList.remove('wm-busy'); win.el.classList.remove('resizing');
      this.showGuides();
      this.changed('resize');
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }

  /** Keep a window entirely on the desktop (shrinking it if it is bigger than the desktop). */
  fit(win) {
    const W = this.W; const H = this.H; const r = win.rect;
    if (!W || !H) return;
    // Never narrower/shorter than the CSS minimum, or the window would hang off the edge on tiny screens.
    r.w = Math.min(Math.max(r.w, MIN_W), W); r.h = Math.min(Math.max(r.h, MIN_H), H);
    r.x = Math.max(0, Math.min(r.x, W - r.w)); r.y = Math.max(0, Math.min(r.y, H - r.h));
  }
  onDesktopResize() {
    const W = this.W; const H = this.H;
    if (!W || !H) return;
    // Scale floating windows with the desktop so an arrangement keeps its shape on any screen size.
    const last = this.lastDesk; const sx = last && last.w ? W / last.w : 1; const sy = last && last.h ? H / last.h : 1;
    for (const w of this.windows) {
      if (w.snapZone) w.rect = this.zoneRect(w.snapZone);
      else { w.rect = { x: w.rect.x * sx, y: w.rect.y * sy, w: w.rect.w * sx, h: w.rect.h * sy }; this.fit(w); }
      this.render(w);
    }
    this.lastDesk = { w: W, h: H };
  }

  // ───────── menus ─────────
  windowMenu(win, x, y) {
    const wsItems = [];
    for (let i = 0; i < this.count; i++) wsItems.push({ label: `Move to ${this.label(i)}`, check: win.ws === i, action: () => this.moveToWorkspace(win, i), key: `⇧⌥${i + 1}` });
    menu(x, y, [
      { header: win.title },
      { label: 'Always on top', check: win.pinned, action: () => this.setPinned(win, !win.pinned) },
      { label: this.fsWin === win ? 'Exit full screen' : 'Full screen', action: () => this.toggleFullscreen(win), key: '⌃⇧F' },
      { label: win.max ? 'Restore' : 'Maximize', action: () => this.toggleMax(win), key: '⌃↑' },
      { label: 'Minimize', action: () => this.minimize(win), key: '⌃↓' },
      '-',
      { label: 'Snap left half', action: () => this.snap(win, 'left'), key: '⌃←' },
      { label: 'Snap right half', action: () => this.snap(win, 'right'), key: '⌃→' },
      { label: 'Snap top / bottom', action: () => this.snap(win, win.snapZone === 'top' ? 'bottom' : 'top') },
      { label: 'Snap quarter', action: () => this.snap(win, ['tl', 'tr', 'br', 'bl'][(['tl', 'tr', 'br', 'bl'].indexOf(win.snapZone) + 1) % 4]) },
      { label: 'Snap thirds', action: () => this.snap(win, ['l3', 'c3', 'r3'][(['l3', 'c3', 'r3'].indexOf(win.snapZone) + 1) % 3]) },
      { label: 'Center', action: () => this.snap(win, 'center') },
      '-',
      ...wsItems,
      '-',
      { label: 'Duplicate window', action: () => this.duplicate(win), disabled: !!win.app.singleton, key: '⌃⇧D' },
      { label: 'Rename…', action: async () => { const t = await prompt('Rename window', win.title); if (t !== null) win.setTitle(t.trim()); } },
      '-',
      { label: 'Close', danger: true, action: () => this.close(win), key: '⌃W' }
    ]);
  }
  duplicate(win) {
    const state = win.instance && win.instance.serialize ? win.instance.serialize() : {};
    return this.open(win.app.id, { state, rect: { ...win.rect, x: win.rect.x + 28, y: win.rect.y + 28 } });
  }

  // ───────── persistence ─────────
  serialize() {
    return {
      v: 1, active: this.active, desk: { w: this.W, h: this.H },
      windows: [...this.windows].sort((a, b) => a.z - b.z).map((w) => {
        let state = {};
        try { state = w.instance && w.instance.serialize ? w.instance.serialize() : {}; } catch (e) { console.error(e); }
        return { app: w.app.id, ws: w.ws, rect: w.rect, restoreRect: w.restoreRect, min: w.min, max: w.max, pinned: w.pinned, snap: w.snapZone, title: w.title !== w.app.title ? w.title : undefined, state, focused: w === this.focused };
      })
    };
  }
  async restoreLayout(layout, { replace = true } = {}) {
    if (!layout || !Array.isArray(layout.windows)) return;
    if (replace && !(await this.closeAll())) return;
    const sx = layout.desk && layout.desk.w ? this.W / layout.desk.w : 1;
    const sy = layout.desk && layout.desk.h ? this.H / layout.desk.h : 1;
    const scale = (r) => r && ({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) });
    this.restoring = true;
    let focusWin = null;
    this.active = Math.max(0, Math.min(this.count - 1, layout.active || 0));
    for (const w of layout.windows) {
      if (!this.apps.has(w.app)) continue;
      const win = await this.open(w.app, { rect: scale(w.rect), workspace: w.ws, pinned: w.pinned, maximized: w.max, snap: w.snap, minimized: w.min, title: w.title, state: w.state, focus: false });
      if (win) { if (w.restoreRect) win.restoreRect = scale(w.restoreRect); if (w.focused) focusWin = win; }
    }
    this.restoring = false;
    for (const w of this.windows) this.sync(w);
    if (focusWin && focusWin.visible) this.focus(focusWin); else this.focusTop();
    this.changed('restore');
  }

  changed(kind, light = false) {
    bus.emit('wm:changed', kind);
    if (!light && !this.restoring) bus.emit('wm:persist');
  }
}

export const wm = new WindowManager();
