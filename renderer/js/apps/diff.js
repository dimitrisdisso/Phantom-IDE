// Side-by-side diff (Monaco diff editor) of a file against HEAD / index.
import { h, esc, basename } from '../core/dom.js';
import { call } from '../core/api.js';
import { loadMonaco } from '../core/docs.js';
import { settings } from '../core/settings.js';
import { renderDiff } from './git.js';

export default {
  id: 'diff', title: 'Diff', icon: 'diff', desc: 'Side-by-side file diff', size: [900, 560], hidden: true,
  async create(win, state) {
    const { root, file, staged } = state;
    if (!root || !file) { win.body.innerHTML = '<div class="empty">open a diff from the Git window or a file tab</div>'; return {}; }
    const relPath = file.startsWith(root) ? file.slice(root.length + 1) : file;
    win.setSub(relPath);
    const inline = h('input', { type: 'checkbox' });
    const host = h('div.fill');
    win.body.append(h('div.toolbar', h('span.c-dim', `HEAD ↔ ${staged ? 'index' : 'working tree'}`), h('span.sp'), h('label.chk', inline, 'inline')), host);
    const monaco = await loadMonaco();
    const original = await call('git:fileAt', root, relPath, 'HEAD');
    const modified = staged ? await call('git:fileAt', root, relPath, '') : await call('fs:read', file).then((r) => r.content || '').catch(() => '');
    if (!monaco) {
      host.classList.add('scroll');
      host.innerHTML = `<div class="diff">${renderDiff(await call('git:diff', root, relPath, !!staged))}</div>`;
      return {};
    }
    const uri = (tag) => monaco.Uri.parse(`phantom-diff://${win.id}/${tag}/${encodeURIComponent(basename(file))}`);
    const a = monaco.editor.createModel(original, undefined, uri('a'));
    const b = monaco.editor.createModel(modified, undefined, uri('b'));
    monaco.editor.setModelLanguage(a, b.getLanguageId());
    const ed = monaco.editor.createDiffEditor(host, { theme: 'phantom', readOnly: true, automaticLayout: false, renderSideBySide: true, fontSize: settings.editorFontSize, minimap: { enabled: false }, scrollBeyondLastLine: false, originalEditable: false });
    ed.setModel({ original: a, modified: b });
    inline.addEventListener('change', () => ed.updateOptions({ renderSideBySide: !inline.checked }));
    win.onResize(() => ed.layout());
    return { serialize: () => state, onShow: () => ed.layout(), destroy() { ed.dispose(); a.dispose(); b.dispose(); } };
  }
};
export { esc };
