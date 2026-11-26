// DOM + formatting helpers and the icon set.

/** h('div.cls#id', {attrs, on: {click}}, ...children) */
export function h(sel, props, ...kids) {
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function bytes(n, digits = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const u = ['B', 'K', 'M', 'G', 'T', 'P'];
  let i = 0; let v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (n < 0 ? '-' : '') + (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : digits)) + u[i];
}
export const rate = (n) => bytes(n) + '/s';
export const pct = (n, d = 0) => (n === null || n === undefined || isNaN(n) ? '—' : n.toFixed(d) + '%');
export function dur(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${Math.round(s % 60)}s`;
  const hh = Math.floor(m / 60);
  if (hh < 48) return `${hh}h${m % 60}m`;
  return `${Math.floor(hh / 24)}d${hh % 24}h`;
}
export const time = (ts) => { const d = new Date(ts); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
export const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
export const dirname = (p) => { const s = String(p).replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i <= 0 ? (s[0] === '/' ? '/' : s) : s.slice(0, i); };
export const sep = () => (window.phantom && window.phantom.platform === 'win32' ? '\\' : '/');
export const join = (...parts) => parts.filter(Boolean).join(sep()).replace(/[\\/]+/g, sep());
export const rel = (root, p) => (root && p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, '') : p);
export const ext = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function throttle(fn, ms) { let last = 0; let t; return (...a) => { const now = Date.now(); clearTimeout(t); if (now - last >= ms) { last = now; fn(...a); } else t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); }; }

/** Fuzzy score: subsequence match with bonuses for consecutive & word-start hits. */
export function fuzzy(query, text) {
  if (!query) return { score: 1, idx: [] };
  const q = query.toLowerCase(); const t = text.toLowerCase();
  let qi = 0; let score = 0; let prev = -2; const idx = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      let s = 1;
      if (i === prev + 1) s += 4;
      if (i === 0 || /[\s/\\._-]/.test(t[i - 1])) s += 3;
      score += s; idx.push(i); prev = i; qi++;
    }
  }
  if (qi < q.length) return null;
  return { score: score - t.length * 0.01, idx };
}
export function markIdx(text, idx) {
  if (!idx || !idx.length) return esc(text);
  let out = ''; const set = new Set(idx);
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<em>${esc(text[i])}</em>` : esc(text[i]);
  return out;
}

export function ansiToHtml(s) {
  // Minimal SGR → span conversion (16 colours + bold) for task output panes.
  const colors = ['#4d5a52', 'var(--red)', 'var(--accent)', 'var(--amber)', '#5aa8ff', 'var(--violet)', 'var(--cyan)', 'var(--fg)'];
  let out = ''; let open = 0;
  // eslint-disable-next-line no-control-regex
  const parts = String(s).split(/(\x1b\[[0-9;]*m)/);
  for (const p of parts) {
    // eslint-disable-next-line no-control-regex
    const m = /^\x1b\[([0-9;]*)m$/.exec(p);
    if (!m) { out += esc(p.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')); continue; }
    const codes = m[1].split(';').map(Number);
    for (const c of codes) {
      if (c === 0 || isNaN(c)) { out += '</span>'.repeat(open); open = 0; }
      else if (c === 1) { out += '<span style="font-weight:700">'; open++; }
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { out += `<span style="color:${colors[(c % 10)]}">`; open++; }
    }
  }
  return out + '</span>'.repeat(open);
}

export function copy(text) { return navigator.clipboard.writeText(String(text)); }

// ───────── icons (16×16, 1.3px stroke) ─────────
const P = {
  terminal: '<path d="M2.5 3.5h11v9h-11z"/><path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5"/>',
  editor: '<path d="M3 2.5h7l3 3v8H3z"/><path d="M10 2.5v3h3M5.5 8.5l-1.3 1.5 1.3 1.5M8.5 8.5l1.3 1.5-1.3 1.5"/>',
  explorer: '<path d="M2 4h4.5l1.2 1.5H14v7.5H2z"/><path d="M2 7h12"/>',
  sysmon: '<path d="M2 13.5h12M3 11l2.5-4 2.5 2 2.5-5 2.5 3"/>',
  net: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
  proc: '<path d="M3 3h10v10H3z"/><path d="M5.5 5.5h5v5h-5zM3 6H1.5M3 10H1.5M13 6h1.5M13 10h1.5M6 3V1.5M10 3V1.5M6 13v1.5M10 13v1.5"/>',
  logs: '<path d="M3 2.5h10v11H3z"/><path d="M5 5h6M5 7.5h6M5 10h4"/>',
  git: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="6" r="1.5"/><path d="M4.5 5v6M11.5 7.5c0 2.5-7 1.5-7 3.5"/>',
  api: '<path d="M2 8h3l1.5-3.5 3 7L11 8h3"/>',
  db: '<ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>',
  arch: '<circle cx="8" cy="3.5" r="1.6"/><circle cx="3.5" cy="12" r="1.6"/><circle cx="12.5" cy="12" r="1.6"/><path d="M7.2 5L4.3 10.5M8.8 5l2.9 5.5M5.1 12h5.8"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  markdown: '<path d="M1.5 4h13v8h-13z"/><path d="M3.5 10V6l2 2 2-2v4M11 6v4M9.5 8.5L11 10l1.5-1.5"/>',
  json: '<path d="M5.5 2.5c-2 0-1.5 2.5-1.5 4S2.5 8 2.5 8 4 8 4 9.5 3.5 13.5 5.5 13.5M10.5 2.5c2 0 1.5 2.5 1.5 4s1.5 1.5 1.5 1.5-1.5 0-1.5 1.5.5 4-1.5 4"/>',
  ssh: '<path d="M2.5 4h11v8h-11z"/><path d="M5 7l1.5 1L5 9M8 9.5h3"/><path d="M13.5 6.5L15 5"/>',
  debug: '<path d="M5.5 5.5h5v6a2.5 2.5 0 0 1-5 0z"/><path d="M6.5 5.5a1.5 1.5 0 0 1 3 0M3 8h2.5M10.5 8H13M3 12l2.5-1M13 12l-2.5-1M4 4.5l1.8 1.5M12 4.5L10.2 6"/>',
  tests: '<path d="M6 2.5h4M7 2.5v4L3.5 12.5a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4"/><path d="M5 10h6"/>',
  build: '<path d="M9.5 3.5l3 3-6.5 6.5H3v-3z"/><path d="M8 5l3 3"/>',
  events: '<path d="M8.5 1.5L4 9h4l-1 5.5L12 7H8z"/>',
  audit: '<path d="M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z"/><path d="M5.5 8l2 2 3-3.5"/>',
  settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  diff: '<path d="M4 2.5v11M12 2.5v11M2 5h4M10 11h4M12 3.5l-2 1.5h4"/>',
  layout: '<path d="M2 2.5h12v11H2zM7 2.5v11M7 8h7"/>',
  close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  min: '<path d="M3 11.5h10"/>',
  max: '<path d="M3 3h10v10H3z"/>',
  restore: '<path d="M5 3h8v8M3 5h8v8H3z"/>',
  pin: '<path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6zM8 8.5V14"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  refresh: '<path d="M13 4v3.5H9.5"/><path d="M12.6 7.5A5 5 0 1 0 13 9.5"/>',
  play: '<path d="M4.5 3l8 5-8 5z"/>',
  pause: '<path d="M5 3v10M11 3v10"/>',
  stop: '<path d="M3.5 3.5h9v9h-9z"/>',
  stepover: '<path d="M2.5 9a5 5 0 0 1 9.5-2M12.5 3.5v3.5H9"/><circle cx="7" cy="12.5" r="1.3"/>',
  stepinto: '<path d="M8 2v7M5 6.5L8 9.5l3-3"/><circle cx="8" cy="13" r="1.3"/>',
  stepout: '<path d="M8 10V3M5 5.5L8 2.5l3 3"/><circle cx="8" cy="13" r="1.3"/>',
  trash: '<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  folder: '<path d="M2 4h4.5l1.2 1.5H14v7.5H2z"/>',
  file: '<path d="M4 2.5h5.5l2.5 2.5v8.5H4z"/><path d="M9.5 2.5V5H12"/>',
  chev: '<path d="M6 4l4 4-4 4"/>',
  split: '<path d="M2.5 3h11v10h-11zM8 3v10"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  copy: '<path d="M5.5 5.5h7v8h-7z"/><path d="M3.5 10.5v-8h7"/>',
  save: '<path d="M3 2.5h8.5l2 2v9H3z"/><path d="M5.5 2.5v3.5h5V2.5M5.5 13.5V9.5h5v4"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="4.5" r="1.5"/><path d="M4.5 5v6M11.5 6c0 3-7 2-7 5"/>',
  collab: '<circle cx="5.5" cy="5" r="2"/><circle cx="11" cy="6" r="1.6"/><path d="M1.8 13c.4-2.6 1.8-4 3.7-4s3.3 1.4 3.7 4M9.4 9.4c.5-.3 1-.4 1.6-.4 1.6 0 2.7 1.2 3 3.4"/>',
  logo: '<path d="M8 1.2c-3.3 0-5.6 2.6-5.6 5.8v7.6l1.9-1.4 1.9 1.4L8 13.2l1.8 1.4 1.9-1.4 1.9 1.4V7c0-3.2-2.3-5.8-5.6-5.8z"/><path d="M5.6 6.6h1.3M9.1 6.6h1.3"/>'
};
export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" stroke-linejoin="miter">${P[name] || P.file}</svg>`;
}
export function iconEl(name) { const s = document.createElement('span'); s.className = 'ic-wrap'; s.innerHTML = icon(name); return s.firstChild; }
