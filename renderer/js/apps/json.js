// JSON viewer: collapsible tree, path copy, filter, stats, pretty/minify, paste mode.
import { h, esc, basename, bytes, copy } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { docs } from '../core/docs.js';
import { prompt, toast, fail } from '../core/ui.js';
import { project } from '../core/project.js';

const keyPath = (parent, k, isArr) => (isArr ? `${parent}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${parent}.${k}` : `${parent}[${JSON.stringify(k)}]`);

export default {
  id: 'json', title: 'JSON', icon: 'json', desc: 'JSON tree viewer', size: [600, 600], min: [300, 200],
  async create(win, state) {
    let path = state.path || null; let text = state.text || ''; let data; let err = null; let filter = '';
    const openNodes = new Set(['$']);
    const pathBtn = h('button.btn', { on: { click: pick } }, 'OPEN…');
    const pasteBtn = h('button.btn', { on: { click: paste } }, 'PASTE');
    const filterInp = h('input.inp', { placeholder: 'filter keys/values…', style: { flex: 1 } });
    const crumbs = h('div.json-crumb.c-dim');
    const tree = h('div.json-tree.fill.scroll.sel-text');
    const info = h('span.c-dim');
    win.body.append(h('div.toolbar', pathBtn, pasteBtn, filterInp,
      h('button.btn.ghost', { on: { click: () => { expandAll(data, '$', 0); render(); } } }, 'expand'),
      h('button.btn.ghost', { on: { click: () => { openNodes.clear(); openNodes.add('$'); render(); } } }, 'collapse'),
      h('button.btn.ghost', { on: { click: () => { copy(JSON.stringify(data, null, 2)); toast('pretty JSON copied'); } } }, 'copy pretty'),
      h('button.btn.ghost', { on: { click: () => { copy(JSON.stringify(data)); toast('minified JSON copied'); } } }, 'copy min')), crumbs, tree, h('div.toolbar.pr-foot', info));

    function expandAll(v, p, depth, max = 9) { if (depth >= max || v === null || typeof v !== 'object') return; openNodes.add(p); const isArr = Array.isArray(v); for (const [k, c] of Object.entries(v).slice(0, 500)) expandAll(c, keyPath(p, k, isArr), depth + 1, max); }
    function parse() {
      try { data = JSON.parse(text); err = null; } catch (e) {
        // tolerate JSON Lines
        const lines = text.split('\n').filter((l) => l.trim());
        try { data = lines.map((l) => JSON.parse(l)); err = null; } catch { data = undefined; err = e.message; }
      }
    }
    function stats(v) { let n = 0; let depth = 0; const walk = (x, d) => { n++; depth = Math.max(depth, d); if (x && typeof x === 'object') for (const c of Object.values(x)) { if (n > 200000) return; walk(c, d + 1); } }; walk(v, 0); return { n, depth }; }

    function matches(k, v) { if (!filter) return true; const f = filter.toLowerCase(); return String(k).toLowerCase().includes(f) || (v !== null && typeof v !== 'object' && String(v).toLowerCase().includes(f)); }
    function subtreeMatches(k, v, depth = 0) { if (matches(k, v)) return true; if (depth > 12 || v === null || typeof v !== 'object') return false; return Object.entries(v).some(([kk, vv]) => subtreeMatches(kk, vv, depth + 1)); }

    function node(k, v, p, isArrChild) {
      const isObj = v !== null && typeof v === 'object';
      if (filter && !subtreeMatches(k, v)) return '';
      const keyHtml = k === null ? '' : `<span class="${isArrChild ? 'j-idx' : 'j-key'}">${isArrChild ? k : esc(JSON.stringify(k))}</span><span class="j-p">: </span>`;
      if (!isObj) {
        const cls = v === null ? 'j-kw' : typeof v === 'string' ? 'j-str' : typeof v === 'number' ? 'j-num' : 'j-kw';
        const val = typeof v === 'string' ? esc(JSON.stringify(v)) : esc(String(v));
        return `<div class="jn" data-p="${esc(p)}">${keyHtml}<span class="${cls}">${val}</span></div>`;
      }
      const isArr = Array.isArray(v); const entries = Object.entries(v);
      const open = openNodes.has(p) || (filter && entries.length < 2000);
      const summary = isArr ? `Array(${entries.length})` : `{${entries.length}}`;
      let out = `<div class="jn jo" data-p="${esc(p)}" data-toggle="1"><span class="tw">${open ? '▾' : '▸'}</span>${keyHtml}<span class="j-p">${isArr ? '[' : '{'}</span>${open ? '' : `<span class="c-mute"> ${summary} </span><span class="j-p">${isArr ? ']' : '}'}</span>`}</div>`;
      if (open) {
        out += '<div class="jc">';
        const LIMIT = 1000;
        for (const [ck, cv] of entries.slice(0, LIMIT)) out += node(isArr ? Number(ck) : ck, cv, keyPath(p, ck, isArr), isArr);
        if (entries.length > LIMIT) out += `<div class="c-mute">… ${entries.length - LIMIT} more</div>`;
        out += `</div><div class="jn"><span class="j-p">${isArr ? ']' : '}'}</span></div>`;
      }
      return out;
    }

    function render() {
      if (err) { tree.innerHTML = `<div class="empty"><div><b class="c-red">INVALID JSON</b>${esc(err)}</div></div>`; info.textContent = ''; return; }
      if (data === undefined) { tree.innerHTML = '<div class="empty"><div><b>NO DATA</b>open a .json file or paste JSON</div></div>'; return; }
      tree.innerHTML = node(null, data, '$', false);
      const s = stats(data);
      info.textContent = `${bytes(text.length)} · ${s.n} nodes · depth ${s.depth}${path ? ' · ' + path : ''}`;
    }

    tree.addEventListener('click', (e) => {
      const n = e.target.closest('.jn[data-p]'); if (!n) return;
      crumbs.textContent = n.dataset.p;
      if (n.dataset.toggle && (e.target.closest('.tw') || e.target.closest('.j-p') || e.detail === 2 || e.target === n || e.target.closest('.j-key,.j-idx'))) {
        const p = n.dataset.p; openNodes.has(p) ? openNodes.delete(p) : openNodes.add(p); render();
      }
    });
    tree.addEventListener('dblclick', (e) => { const n = e.target.closest('.jn[data-p]'); if (n) { copy(n.dataset.p); toast(`path copied: ${n.dataset.p}`); } });
    filterInp.addEventListener('input', () => { filter = filterInp.value.trim(); render(); });

    async function load() {
      if (path) {
        const d = docs.get(path);
        if (d) text = d.getValue();
        else { try { const r = await call('fs:read', path); text = r.content || ''; } catch (e) { fail(e); } }
        pathBtn.textContent = basename(path); win.setSub(path.replace(project.root || '\0', '.'));
      } else if (state.title) win.setSub(state.title);
      parse(); if (data !== undefined && openNodes.size === 1) expandAll(data, '$', 0, 2);
      render();
    }
    async function pick() {
      let f = null;
      try { f = await call('fs:pickFile', 'Open JSON', [{ name: 'JSON', extensions: ['json', 'jsonl', 'geojson', 'json5'] }]); } catch { f = await prompt('JSON file', project.root || '', { select: false }); }
      if (f) { path = f; openNodes.clear(); openNodes.add('$'); load(); win.save(); }
    }
    async function paste() {
      try { text = await navigator.clipboard.readText(); path = null; pathBtn.textContent = 'OPEN…'; win.setSub('clipboard'); parse(); render(); win.save(); } catch (e) { fail(e); }
    }
    let t = 0;
    const offs = [bus.on('doc:changed', (d) => { if (d.path === path) { clearTimeout(t); t = setTimeout(load, 250); } })];
    await load();
    return { serialize: () => (path ? { path } : { text: text.length < 200000 ? text : '', title: state.title }), apply: (s) => { path = s.path || null; text = s.text || text; load(); }, destroy: () => offs.forEach((f) => f()) };
  }
};
