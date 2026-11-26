// Project-wide search & replace (ripgrep-backed).
import { h, esc, rel, basename, debounce } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { confirm, toast, fail } from '../core/ui.js';
import { fileGlyph } from './editor.js';

export default {
  id: 'search', title: 'Search', icon: 'search', desc: 'Project-wide search & replace', size: [520, 560], min: [300, 220], key: 'Ctrl+Shift+H',
  create(win, state) {
    const opt = { regex: !!state.regex, caseSensitive: !!state.caseSensitive, wholeWord: !!state.wholeWord };
    let last = null; const collapsed = new Set(); let seq = 0;
    const q = h('input.inp', { placeholder: 'search…', value: state.query || '', spellcheck: false });
    const rep = h('input.inp', { placeholder: 'replace with…', value: state.replace || '', spellcheck: false });
    const inc = h('input.inp', { placeholder: 'include  e.g. src/**, *.ts', value: state.include || '', spellcheck: false });
    const exc = h('input.inp', { placeholder: 'exclude  e.g. *.min.js, dist', value: state.exclude || '', spellcheck: false });
    const tog = (k, label, title) => { const b = h('button.btn.icon' + (opt[k] ? '.on' : ''), { title, on: { click: () => { opt[k] = !opt[k]; b.classList.toggle('on', opt[k]); go(); } } }, label); return b; };
    const repBtn = h('button.btn.danger', { on: { click: replaceAll }, disabled: true }, 'REPLACE ALL');
    const summary = h('div.search-sum.c-dim');
    const results = h('div.fill.scroll.search-res');
    win.body.append(h('div.search-form',
      h('div.row', q, tog('caseSensitive', 'Aa', 'Match case'), tog('wholeWord', 'ab', 'Whole word'), tog('regex', '.*', 'Regular expression')),
      h('div.row', rep, repBtn), h('div.row', inc, exc)), summary, results);

    async function go() {
      win.save();
      const query = q.value;
      if (!project.root) { summary.textContent = 'open a project first'; return; }
      if (!query) { results.innerHTML = ''; summary.textContent = ''; repBtn.disabled = true; last = null; return; }
      const my = ++seq;
      summary.innerHTML = '<span class="spin"></span> searching…';
      try {
        const r = await call('search:run', { root: project.root, query, ...opt, include: inc.value, exclude: exc.value, searchId: String(my) });
        if (my !== seq) return;
        last = r; render();
      } catch (e) { if (my === seq) summary.innerHTML = `<span class="c-red">${esc(e.message)}</span>`; }
    }
    function render() {
      const r = last;
      const byFile = new Map();
      for (const m of r.results) { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push(m); }
      summary.innerHTML = `${r.results.length}${r.truncated ? '+' : ''} matches in ${byFile.size} files <span class="c-mute">· ${r.engine} · ${r.ms}ms</span>`;
      repBtn.disabled = !r.results.length;
      win.setBadge(r.results.length ? String(r.results.length) : '');
      const frag = [];
      for (const [file, ms] of byFile) {
        const open = !collapsed.has(file);
        frag.push(`<div class="sr-file" data-f="${esc(file)}"><span class="tw">${open ? '▾' : '▸'}</span><span class="fi">${fileGlyph(file)}</span><b>${esc(basename(file))}</b><span class="c-mute">${esc(rel(project.root, file))}</span><span class="cnt">${ms.length}</span></div>`);
        if (open) for (const m of ms.slice(0, 200)) {
          let html = ''; let pos = 0; const text = m.text;
          const lead = Math.max(0, (m.ranges[0] ? m.ranges[0][0] : 0) - 40);
          for (const [a, b] of m.ranges) { if (a < pos) continue; html += esc(text.slice(Math.max(pos, lead), a)) + `<mark>${esc(text.slice(a, b))}</mark>`; pos = b; }
          html += esc(text.slice(pos, pos + 200));
          frag.push(`<div class="sr-line" data-f="${esc(file)}" data-l="${m.line}" data-c="${(m.ranges[0] || [0])[0] + 1}"><span class="ln">${m.line}</span><span class="tx">${lead ? '…' : ''}${html.replace(/^\s+/, '')}</span></div>`);
        }
      }
      results.innerHTML = frag.join('') || '<div class="empty">no results</div>';
    }
    results.addEventListener('click', (e) => {
      const f = e.target.closest('.sr-file');
      if (f) { const p = f.dataset.f; collapsed.has(p) ? collapsed.delete(p) : collapsed.add(p); render(); return; }
      const l = e.target.closest('.sr-line');
      if (l) { results.querySelectorAll('.sr-line.sel').forEach((x) => x.classList.remove('sel')); l.classList.add('sel'); bus.emit('open-file', l.dataset.f, { line: Number(l.dataset.l), column: Number(l.dataset.c) }); }
    });
    async function replaceAll() {
      if (!last || !last.results.length) return;
      const files = [...new Set(last.results.map((r) => r.file))];
      if (!(await confirm('Replace across project', `Replace ${last.results.length} match(es) of\n  ${q.value}\nwith\n  ${rep.value}\nin ${files.length} file(s)?\n\nFiles are rewritten on disk. Use git to review or revert.`, { danger: true, ok: 'REPLACE' }))) return;
      try { const r = await call('search:replace', { files, query: q.value, replacement: rep.value, ...opt }); toast(`${r.replacements} replacements in ${r.files} files`, 'info', 'REPLACED'); go(); } catch (e) { fail(e); }
    }
    const dgo = debounce(go, 280);
    [q, inc, exc].forEach((i) => i.addEventListener('input', dgo));
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    rep.addEventListener('input', () => win.save());
    const off = bus.on('project:changed', go);
    if (q.value) go();
    setTimeout(() => q.focus(), 50);
    return { serialize: () => ({ query: q.value, replace: rep.value, include: inc.value, exclude: exc.value, ...opt }), onFocus: () => q.focus(), destroy: off, apply: (s) => { if (s.include !== undefined) { inc.value = s.include; go(); } } };
  }
};
