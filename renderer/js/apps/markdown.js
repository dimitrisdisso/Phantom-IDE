// Markdown viewer: live preview of a file (follows unsaved editor changes), sanitized with DOMPurify.
import { h, esc, basename, dirname } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { docs } from '../core/docs.js';
import { prompt, fail } from '../core/ui.js';
import { project } from '../core/project.js';

function render(md) {
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(md, { gfm: true, breaks: false });
    return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
  }
  // Fallback: minimal safe renderer (headings, code, lists, emphasis, links).
  const lines = esc(md).split('\n'); let out = ''; let code = false;
  for (const l of lines) {
    if (/^```/.test(l)) { out += code ? '</code></pre>' : '<pre><code>'; code = !code; continue; }
    if (code) { out += l + '\n'; continue; }
    const m = /^(#{1,6})\s+(.*)/.exec(l);
    if (m) out += `<h${m[1].length}>${m[2]}</h${m[1].length}>`;
    else if (/^\s*[-*]\s+/.test(l)) out += `<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`;
    else if (!l.trim()) out += '<br>';
    else out += `<p>${l.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')}</p>`;
  }
  return out;
}

export default {
  id: 'markdown', title: 'Markdown', icon: 'markdown', desc: 'Live markdown preview', size: [640, 620], min: [300, 200],
  async create(win, state) {
    let path = state.path || null;
    const body = h('div.md-body.fill.scroll.sel-text');
    const pathBtn = h('button.btn', { on: { click: pick } }, 'OPEN…');
    win.body.append(h('div.toolbar', pathBtn, h('span.sp'), h('button.btn.ghost', { on: { click: () => path && bus.emit('open-file', path, {}) } }, 'edit source')), body);
    async function load() {
      if (!path) { body.innerHTML = '<div class="empty"><div><b>NO DOCUMENT</b>open a .md file, or right-click one in the explorer</div></div>'; return; }
      win.setSub(path.replace(project.root || '\0', '.'));
      pathBtn.textContent = basename(path);
      const d = docs.get(path);
      let text;
      if (d) text = d.getValue();
      else { try { const r = await call('fs:read', path); text = r.content || ''; } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
      const sc = body.scrollTop;
      body.innerHTML = render(text);
      // Resolve relative links: open .md/.code files inside PHANTOM, external links in the browser.
      body.querySelectorAll('a[href]').forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.getAttribute('href');
        if (/^https?:/.test(href)) call('app:openExternal', href).catch(fail);
        else if (href.startsWith('#')) { const t = body.querySelector(`[id="${CSS.escape(href.slice(1))}"]`); t && t.scrollIntoView(); }
        else { const target = dirname(path) + '/' + href.split('#')[0]; if (/\.md$/i.test(target)) { path = target; load(); win.save(); } else bus.emit('open-file', target, {}); }
      }));
      body.querySelectorAll('img').forEach((img) => { if (!/^(data:|blob:)/.test(img.getAttribute('src') || '')) { img.replaceWith(h('span.c-mute', `[image: ${img.getAttribute('alt') || img.getAttribute('src')}]`)); } });
      body.scrollTop = sc;
    }
    async function pick() {
      let f = null;
      try { f = await call('fs:pickFile', 'Open markdown', [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }]); } catch { f = await prompt('Markdown file', project.root ? project.root + '/README.md' : '', { select: false }); }
      if (f) { path = f; load(); win.save(); }
    }
    let t = 0;
    const offs = [
      bus.on('doc:changed', (d) => { if (d.path === path) { clearTimeout(t); t = setTimeout(load, 150); } }),
      bus.on('fs:changed', (paths) => { if (paths.includes(path) && !docs.get(path)) load(); })
    ];
    await load();
    return { serialize: () => ({ path }), apply: (s) => { path = s.path; load(); }, destroy: () => offs.forEach((f) => f()) };
  }
};
