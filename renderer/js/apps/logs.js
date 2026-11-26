// Log viewer: tail -f any file or PHANTOM's own log, with level highlighting and filters.
import { h, esc, time, basename } from '../core/dom.js';
import { call, on } from '../core/api.js';
import { project } from '../core/project.js';
import { menu, prompt, fail } from '../core/ui.js';

const MAX = 8000;
const LEVEL = /\b(FATAL|CRIT(?:ICAL)?|ERR(?:OR)?|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

export default {
  id: 'logs', title: 'Logs', icon: 'logs', desc: 'Real-time log tailing', size: [760, 440], min: [360, 200],
  async create(win, state) {
    let src = state.file || null; let tailId = null; let lines = []; let follow = true; let filter = ''; let regex = false; let lvl = state.level || 'all';
    const srcBtn = h('button.btn', { on: { click: pickSource } });
    const filterInp = h('input.inp', { placeholder: 'filter…', style: { flex: 1 } });
    const reBtn = h('button.btn.icon', { title: 'Regex', on: { click: () => { regex = !regex; reBtn.classList.toggle('on', regex); render(); } } }, '.*');
    const lvlSel = h('select.inp', ['all', 'error', 'warn+', 'info+'].map((v) => h('option', { value: v, selected: v === lvl }, v)));
    const followBtn = h('button.btn.on', { on: { click: () => { follow = !follow; followBtn.classList.toggle('on', follow); if (follow) out.scrollTop = 1e9; } } }, 'FOLLOW');
    const out = h('div.log-out.fill.scroll.sel-text');
    const foot = h('div.toolbar.pr-foot');
    win.body.append(h('div.toolbar', srcBtn, filterInp, reBtn, lvlSel, followBtn, h('button.btn.ghost', { on: { click: () => { lines = []; render(); } } }, 'CLEAR')), out, foot);

    const offs = [];
    offs.push(on('logs:lines', (p) => { if (p.id === tailId) add(p.lines); }));
    offs.push(on('app:log', (e) => { if (src === null) add([`${time(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`]); }));

    function add(newLines) {
      lines.push(...newLines);
      if (lines.length > MAX) lines.splice(0, lines.length - MAX);
      scheduleRender();
    }
    let raf = 0;
    const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

    function lineLevel(l) { const m = LEVEL.exec(l); if (!m) return ''; const k = m[1].toUpperCase(); return /FATAL|CRIT|ERR/.test(k) ? 'err' : /WARN/.test(k) ? 'warn' : /INFO/.test(k) ? 'info' : 'dbg'; }
    function render() {
      if (!win.visible) return;
      let re = null;
      if (filter) { try { re = regex ? new RegExp(filter, 'i') : null; } catch { re = null; } }
      const want = (lv) => lvl === 'all' || (lvl === 'error' && lv === 'err') || (lvl === 'warn+' && (lv === 'err' || lv === 'warn')) || (lvl === 'info+' && lv && lv !== 'dbg');
      const shown = []; let n = 0;
      for (let i = Math.max(0, lines.length - 3000); i < lines.length; i++) {
        const l = lines[i]; const lv = lineLevel(l);
        if (!want(lv)) continue;
        if (filter && !(re ? re.test(l) : l.toLowerCase().includes(filter.toLowerCase()))) continue;
        n++;
        let html = esc(l);
        if (filter && !re) { const fl = esc(filter).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); html = html.replace(new RegExp(fl, 'gi'), (m) => `<mark>${m}</mark>`); }
        html = html.replace(/^(\d{4}-\d\d-\d\d[T ][\d:.]+Z?|\d\d:\d\d:\d\d(?:\.\d+)?|[A-Z][a-z]{2} +\d+ [\d:]+)/, '<span class="c-dim">$1</span>')
          .replace(/(https?:\/\/[^\s<]+)/g, '<span class="c-cyan">$1</span>');
        shown.push(`<div class="ll ${lv}">${html}</div>`);
      }
      out.innerHTML = shown.join('') || '<div class="c-mute" style="padding:10px">no lines yet…</div>';
      if (follow) out.scrollTop = out.scrollHeight;
      foot.textContent = `${n} shown · ${lines.length} buffered · ${src ? src : 'PHANTOM internal log'}`;
    }
    out.addEventListener('scroll', () => { const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 4; if (!atBottom && follow) { follow = false; followBtn.classList.remove('on'); } });

    async function setSource(file) {
      if (tailId) { call('logs:untail', tailId).catch(() => {}); tailId = null; }
      src = file; lines = [];
      if (file) {
        try { const r = await call('logs:tail', file); tailId = r.id; } catch (e) { fail(e, 'TAIL'); src = null; }
      }
      if (!src) { const l = await call('app:logs'); lines = l.map((e) => `${time(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`); }
      srcBtn.textContent = src ? basename(src) : 'PHANTOM LOG';
      win.setSub(src || 'internal');
      render(); win.save();
    }

    async function pickSource(e) {
      const r = e.currentTarget.getBoundingClientRect();
      let found = { project: [], system: [] };
      try { if (project.root) found = await call('logs:discover', project.root); } catch { /* ignore */ }
      menu(r.left, r.bottom, [
        { label: 'PHANTOM internal log', check: !src, action: () => setSource(null) },
        { label: 'Open file…', action: async () => {
          let f = null;
          try { f = await call('fs:pickFile', 'Open log file'); } catch { f = await prompt('Log file path', project.root || '', { select: false }); }
          if (f) setSource(f);
        } },
        ...(found.system.length ? ['-', { header: 'SYSTEM' }, ...found.system.map((f) => ({ label: f, check: f === src, action: () => setSource(f) }))] : []),
        ...(found.project.length ? ['-', { header: 'PROJECT' }, ...found.project.slice(0, 30).map((f) => ({ label: f.name, check: f.path === src, action: () => setSource(f.path) }))] : [])
      ]);
    }

    filterInp.addEventListener('input', () => { filter = filterInp.value; render(); });
    lvlSel.addEventListener('change', () => { lvl = lvlSel.value; render(); win.save(); });
    await setSource(src);
    return { serialize: () => ({ file: src, level: lvl }), onShow: render, destroy() { offs.forEach((f) => f()); if (tailId) call('logs:untail', tailId).catch(() => {}); } };
  }
};
