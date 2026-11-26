// Interactive architecture map: force-directed module dependency graph with cycle detection.
import { h, esc, basename } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { cssVar } from '../core/graph.js';
import { fail } from '../core/ui.js';

export default {
  id: 'arch', title: 'Architecture', icon: 'arch', desc: 'Module dependency graph & cycles', size: [900, 620], min: [420, 300],
  async create(win, state) {
    let graph = null; let nodes = []; let edges = []; let byId = new Map();
    let externals = !!state.externals; let labels = state.labels !== false; let cluster = state.cluster !== false;
    let view = { x: 0, y: 0, k: 1 }; let hover = null; let selected = null; let query = ''; let hiCycle = null;
    let running = true; let alpha = 1; let raf = 0;
    const canvas = h('canvas.arch-canvas');
    const tip = h('div.arch-tip');
    const qInp = h('input.inp', { placeholder: 'highlight files…', style: { width: '180px' } });
    const extBtn = h('button.btn' + (externals ? '.on' : ''), { on: { click: () => { externals = !externals; extBtn.classList.toggle('on', externals); load(); win.save(); } } }, 'PACKAGES');
    const lblBtn = h('button.btn' + (labels ? '.on' : ''), { on: { click: () => { labels = !labels; lblBtn.classList.toggle('on', labels); kick(0.05); win.save(); } } }, 'LABELS');
    const cluBtn = h('button.btn' + (cluster ? '.on' : ''), { on: { click: () => { cluster = !cluster; cluBtn.classList.toggle('on', cluster); kick(0.8); win.save(); } } }, 'CLUSTER BY DIR');
    const stats = h('span.c-dim');
    const legend = h('div.arch-legend');
    const cyclesEl = h('div.arch-cycles.scroll');
    const stage = h('div.arch-stage.fill', canvas, tip, legend);
    win.body.append(h('div.toolbar', qInp, extBtn, lblBtn, cluBtn, h('button.btn.ghost', { on: { click: () => fitView() } }, 'FIT'), h('button.btn.ghost', { on: { click: () => load() } }, 'RESCAN'), h('span.sp'), stats), h('div.split-h.fill', stage, cyclesEl));

    const palette = () => [cssVar('--accent'), cssVar('--cyan'), cssVar('--amber'), cssVar('--violet'), cssVar('--red'), '#5aa8ff', '#ff8fd0', '#9dff6b', '#ffd36b', '#6bffe0'];
    let dirColor = new Map();

    async function load() {
      if (!project.root) { stats.textContent = 'open a project first'; return; }
      stats.innerHTML = '<span class="spin"></span> parsing imports…';
      try { graph = await call('arch:graph', project.root, { externals }); } catch (e) { fail(e); return; }
      const old = new Map(nodes.map((n) => [n.id, n]));
      const dirs = [...new Set(graph.nodes.map((n) => n.dir))];
      const pal = palette();
      dirColor = new Map(dirs.map((d, i) => [d, d === '(external)' ? cssVar('--mute') : pal[i % pal.length]]));
      const dirAngle = new Map(dirs.map((d, i) => [d, (i / dirs.length) * Math.PI * 2]));
      nodes = graph.nodes.map((n) => {
        const o = old.get(n.id); const a = dirAngle.get(n.dir) + Math.random() * 0.6; const r = 120 + Math.random() * 200;
        return { ...n, x: o ? o.x : Math.cos(a) * r, y: o ? o.y : Math.sin(a) * r, vx: 0, vy: 0, r: n.external ? 4 : 3 + Math.min(14, Math.sqrt(n.lines || 1) / 2.2), fixed: false };
      });
      byId = new Map(nodes.map((n) => [n.id, n]));
      edges = graph.edges.map(([a, b]) => [byId.get(a), byId.get(b)]).filter(([a, b]) => a && b);
      for (const n of nodes) { n.nb = new Set(); }
      for (const [a, b] of edges) { a.nb.add(b); b.nb.add(a); }
      const cyc = new Set(graph.cycles.flat());
      for (const n of nodes) n.inCycle = cyc.has(n.id);
      stats.textContent = `${nodes.length} modules · ${edges.length} imports · ${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'}${graph.truncated ? ' · truncated' : ''}`;
      legend.innerHTML = dirs.slice(0, 14).map((d) => `<span><i style="background:${dirColor.get(d)}"></i>${esc(d)}</span>`).join('');
      cyclesEl.innerHTML = `<div class="hdr">CIRCULAR DEPENDENCIES</div>` + (graph.cycles.length ? graph.cycles.map((c, i) => `<div class="arch-cyc" data-i="${i}"><b class="c-red">↻ ${c.length}</b> ${c.map((x) => esc(basename(x))).join(' → ')}</div>`).join('') : '<div class="c-acc" style="padding:6px 8px">none detected ✓</div>') +
        `<div class="hdr">MOST IMPORTED</div>` + [...nodes].filter((n) => !n.external || externals).sort((a, b) => b.in - a.in).slice(0, 12).map((n) => `<div class="arch-cyc" data-id="${esc(n.id)}"><b class="c-cyan">${n.in}</b> ${esc(n.id)}</div>`).join('') +
        `<div class="hdr">MOST DEPENDENCIES</div>` + [...nodes].sort((a, b) => b.out - a.out).slice(0, 8).map((n) => `<div class="arch-cyc" data-id="${esc(n.id)}"><b class="c-amber">${n.out}</b> ${esc(n.id)}</div>`).join('');
      win.setSub(`${project.name} · ${nodes.length} modules`);
      kick(1);
      if (!old.size) setTimeout(fitView, 900);
    }
    cyclesEl.addEventListener('click', (e) => {
      const c = e.target.closest('.arch-cyc'); if (!c) return;
      if (c.dataset.i !== undefined) { hiCycle = hiCycle === Number(c.dataset.i) ? null : Number(c.dataset.i); selected = null; }
      else { selected = byId.get(c.dataset.id) || null; hiCycle = null; if (selected) centerOn(selected); }
      draw();
    });

    function kick(a) { alpha = Math.max(alpha, a); if (!raf) loop(); }
    function loop() {
      raf = requestAnimationFrame(() => { raf = 0; if (win.visible && alpha > 0.005) { tick(); draw(); loop(); } else draw(); });
    }

    function tick() {
      const N = nodes.length; if (!N) return;
      const cell = 70; const grid = new Map();
      for (const n of nodes) { const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`; let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(n); }
      const rep = 900 * alpha;
      for (const n of nodes) {
        const cx = Math.floor(n.x / cell); const cy = Math.floor(n.y / cell);
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
          const b = grid.get(`${cx + dx},${cy + dy}`); if (!b) continue;
          for (const m of b) {
            if (m === n) continue;
            let x = n.x - m.x; let y = n.y - m.y; let d2 = x * x + y * y;
            if (d2 < 0.01) { x = Math.random() - 0.5; y = Math.random() - 0.5; d2 = 0.25; }
            if (d2 > 40000) continue;
            const f = rep / d2; n.vx += x * f * 0.05; n.vy += y * f * 0.05;
          }
        }
      }
      for (const [a, b] of edges) {
        const x = b.x - a.x; const y = b.y - a.y; const d = Math.sqrt(x * x + y * y) || 1;
        const f = (d - 60) * 0.004 * alpha;
        a.vx += (x / d) * f * d * 0.1; a.vy += (y / d) * f * d * 0.1; b.vx -= (x / d) * f * d * 0.1; b.vy -= (y / d) * f * d * 0.1;
      }
      if (cluster) {
        const cent = new Map();
        for (const n of nodes) { const c = cent.get(n.dir) || { x: 0, y: 0, n: 0 }; c.x += n.x; c.y += n.y; c.n++; cent.set(n.dir, c); }
        for (const n of nodes) { const c = cent.get(n.dir); n.vx += (c.x / c.n - n.x) * 0.012 * alpha; n.vy += (c.y / c.n - n.y) * 0.012 * alpha; }
      }
      for (const n of nodes) {
        n.vx -= n.x * 0.0018 * alpha; n.vy -= n.y * 0.0018 * alpha;
        if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += Math.max(-30, Math.min(30, n.vx)); n.y += Math.max(-30, Math.min(30, n.vy));
      }
      alpha *= 0.985;
    }

    function draw() {
      const dpr = devicePixelRatio || 1; const W = stage.clientWidth; const H = stage.clientHeight;
      if (!W || !H) return;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.save(); ctx.translate(W / 2 + view.x, H / 2 + view.y); ctx.scale(view.k, view.k);
      const focus = hover || selected;
      const cycleSet = hiCycle !== null && graph ? new Set(graph.cycles[hiCycle]) : null;
      const q = query.toLowerCase();
      const dimmed = (n) => (focus && n !== focus && !focus.nb.has(n)) || (cycleSet && !cycleSet.has(n.id)) || (q && !n.id.toLowerCase().includes(q));
      const acc = cssVar('--accent'); const red = cssVar('--red'); const line = cssVar('--line3');
      ctx.lineWidth = 1 / view.k;
      for (const [a, b] of edges) {
        const hot = focus && (a === focus || b === focus);
        const cyc = cycleSet ? cycleSet.has(a.id) && cycleSet.has(b.id) : a.inCycle && b.inCycle && a.nb.has(b);
        if (!hot && (dimmed(a) || dimmed(b)) && (focus || cycleSet || q)) { ctx.globalAlpha = 0.06; } else ctx.globalAlpha = hot ? 0.95 : 0.35;
        ctx.strokeStyle = hot ? (a === focus ? acc : cssVar('--cyan')) : cyc ? red : line;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        if (hot || view.k > 1.4) { // arrow head
          const ang = Math.atan2(b.y - a.y, b.x - a.x); const ex = b.x - Math.cos(ang) * (b.r + 2); const ey = b.y - Math.sin(ang) * (b.r + 2); const s = 5 / view.k;
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.cos(ang - 0.4) * s, ey - Math.sin(ang - 0.4) * s); ctx.lineTo(ex - Math.cos(ang + 0.4) * s, ey - Math.sin(ang + 0.4) * s); ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      const fontPx = 10 / view.k;
      ctx.font = `${fontPx}px ${cssVar('--font')}`;
      for (const n of nodes) {
        const dim = dimmed(n) && (focus || cycleSet || q);
        ctx.globalAlpha = dim ? 0.15 : 1;
        const col = dirColor.get(n.dir) || acc;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.external ? 'transparent' : col + '33'; ctx.fill();
        ctx.strokeStyle = n.inCycle ? red : col; ctx.lineWidth = (n === focus ? 2.4 : 1.2) / view.k; ctx.stroke();
        if (n === focus) { ctx.shadowColor = col; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0; }
        if ((labels && (view.k > 0.9 || n.r > 9)) || n === focus || (focus && focus.nb.has(n)) || (q && !dim)) {
          ctx.fillStyle = n === focus ? cssVar('--fg-hi') : cssVar('--dim');
          ctx.fillText(n.external ? n.id.slice(4) : basename(n.id), n.x + n.r + 3 / view.k, n.y + fontPx / 3);
        }
      }
      ctx.restore();
    }

    const toWorld = (cx, cy) => { const r = canvas.getBoundingClientRect(); return { x: (cx - r.left - r.width / 2 - view.x) / view.k, y: (cy - r.top - r.height / 2 - view.y) / view.k }; };
    const pick = (cx, cy) => { const p = toWorld(cx, cy); let best = null; let bd = Infinity; for (const n of nodes) { const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2; if (d < (n.r + 4 / view.k) ** 2 && d < bd) { best = n; bd = d; } } return best; };
    function centerOn(n) { view.x = -n.x * view.k; view.y = -n.y * view.k; draw(); }
    function fitView() {
      if (!nodes.length) return;
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
      const W = stage.clientWidth; const H = stage.clientHeight;
      view.k = Math.max(0.1, Math.min(2.5, Math.min(W / (x1 - x0 + 80), H / (y1 - y0 + 80))));
      view.x = -((x0 + x1) / 2) * view.k; view.y = -((y0 + y1) / 2) * view.k; draw();
    }

    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const n = pick(e.clientX, e.clientY);
      drag = { n, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
      if (n) n.fixed = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) drag.moved = true;
        if (drag.n) { const p = toWorld(e.clientX, e.clientY); drag.n.x = p.x; drag.n.y = p.y; kick(0.25); }
        else { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; draw(); }
        return;
      }
      const n = pick(e.clientX, e.clientY);
      if (n !== hover) { hover = n; draw(); canvas.style.cursor = n ? 'pointer' : 'grab'; }
      if (n) {
        const r = stage.getBoundingClientRect();
        tip.style.display = 'block'; tip.style.left = e.clientX - r.left + 14 + 'px'; tip.style.top = e.clientY - r.top + 10 + 'px';
        tip.innerHTML = `<b>${esc(n.external ? n.id.slice(4) : n.id)}</b><br><span class="c-dim">${n.external ? 'external package' : `${n.lines} lines · ${esc(n.ext)}`}</span><br><span class="c-cyan">imported by ${n.in}</span> · <span class="c-amber">imports ${n.out}</span>${n.inCycle ? '<br><span class="c-red">part of a dependency cycle</span>' : ''}`;
      } else tip.style.display = 'none';
    });
    canvas.addEventListener('pointerup', () => {
      if (drag) {
        if (drag.n) { drag.n.fixed = false; if (!drag.moved) { selected = selected === drag.n ? null : drag.n; draw(); } }
        else if (!drag.moved) { selected = null; hiCycle = null; draw(); }
      }
      drag = null;
    });
    canvas.addEventListener('dblclick', (e) => { const n = pick(e.clientX, e.clientY); if (n && n.path) bus.emit('open-file', n.path, {}); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left - r.width / 2; const my = e.clientY - r.top - r.height / 2;
      const k2 = Math.max(0.05, Math.min(6, view.k * Math.exp(-e.deltaY * 0.0015)));
      view.x = mx - ((mx - view.x) * k2) / view.k; view.y = my - ((my - view.y) * k2) / view.k; view.k = k2; draw();
    }, { passive: false });
    canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; draw(); });
    qInp.addEventListener('input', () => { query = qInp.value.trim(); draw(); });
    win.onResize(draw);
    const offs = [bus.on('project:changed', load), bus.on('theme:changed', () => { if (graph) load(); })];
    await load();
    return { serialize: () => ({ externals, labels, cluster }), onShow: () => kick(0.02), destroy() { running = false; cancelAnimationFrame(raf); offs.forEach((f) => f()); } };
  }
};
