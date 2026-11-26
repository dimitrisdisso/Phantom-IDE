// Canvas plotting for monitors: hi-DPI aware, cheap to redraw every second.
export function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth; const hgt = canvas.clientHeight;
  if (!w || !hgt) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  return { ctx, w, h: hgt };
}

function rgba(color, a) {
  if (color.startsWith('#')) {
    const n = parseInt(color.length === 4 ? color.slice(1).split('').map((c) => c + c).join('') : color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

/**
 * series: [{ data:number[], color:'#hex', fill:true }]
 * opts: { max, min, grid:true, points: fixed number of slots (right-aligned), label }
 */
export function plot(canvas, series, opts = {}) {
  const f = fit(canvas); if (!f) return;
  const { ctx, w, h } = f;
  const pad = 1;
  const n = opts.points || Math.max(...series.map((s) => s.data.length), 2);
  let max = opts.max;
  if (max === undefined) { max = 0; for (const s of series) for (const v of s.data) if (v > max) max = v; max = max * 1.15 || 1; }
  const min = opts.min || 0;
  if (opts.grid !== false) {
    ctx.strokeStyle = rgba(cssVar('--accent'), 0.07); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) { const y = Math.round((h * i) / 4) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    const step = w / 12;
    for (let x = step; x < w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    ctx.stroke();
  }
  const xs = (i, len) => w - ((len - 1 - i) / (n - 1)) * w;
  const ys = (v) => h - pad - ((Math.min(v, max) - min) / (max - min || 1)) * (h - pad * 2);
  for (const s of series) {
    const d = s.data; if (d.length < 2) continue;
    const color = s.color || cssVar('--accent');
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) { const x = xs(i, d.length); const y = ys(d[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    if (s.fill !== false) {
      ctx.save();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, rgba(color, 0.28)); g.addColorStop(1, rgba(color, 0.02));
      ctx.lineTo(xs(d.length - 1, d.length), h); ctx.lineTo(xs(0, d.length), h); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.restore();
      ctx.beginPath();
      for (let i = 0; i < d.length; i++) { const x = xs(i, d.length); const y = ys(d[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    ctx.shadowColor = rgba(color, 0.6 * (parseFloat(cssVar('--glow-k')) || 1)); ctx.shadowBlur = 4;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  if (opts.label) {
    ctx.fillStyle = cssVar('--dim'); ctx.font = `10px ${cssVar('--font')}`;
    ctx.fillText(opts.label, 4, 11);
  }
}

/** Vertical bars (e.g. per-core CPU). */
export function bars(canvas, values, opts = {}) {
  const f = fit(canvas); if (!f) return;
  const { ctx, w, h } = f;
  const n = values.length || 1; const gap = n > 32 ? 1 : 2;
  const bw = Math.max(1, (w - gap * (n - 1)) / n);
  const acc = cssVar('--accent'); const amb = cssVar('--amber'); const red = cssVar('--red');
  values.forEach((v, i) => {
    const x = i * (bw + gap);
    ctx.fillStyle = rgba(acc, 0.08); ctx.fillRect(x, 0, bw, h);
    const bh = Math.max(1, (Math.min(v, opts.max || 100) / (opts.max || 100)) * h);
    ctx.fillStyle = v > 85 ? red : v > 60 ? amb : acc;
    ctx.fillRect(x, h - bh, bw, bh);
  });
}
