// Code editor: Monaco, tabs, split groups, shared models across windows, breakpoints.
import { h, icon, esc, basename, rel, ext, copy } from '../core/dom.js';
import { bus, call } from '../core/api.js';
import { openDoc, releaseDoc, saveDoc, loadMonaco, breakpoints, toggleBreakpoint, debugLoc, docs, normPath } from '../core/docs.js';
import { settings } from '../core/settings.js';
import { project } from '../core/project.js';
import { menu, toast, fail, choice, prompt, splitter } from '../core/ui.js';
import { wm } from '../core/wm.js';
import * as run from '../core/run.js';
import * as live from '../core/collab.js';

export default {
  id: 'editor', title: 'Editor', icon: 'editor', desc: 'Monaco code editor with tabs & split', size: [860, 560], key: 'Ctrl+P',
  async create(win, state) {
    const monaco = await loadMonaco();
    const root = h('div.ed-root');
    win.body.appendChild(root);
    const groups = [];
    let active = null;
    const offs = [];

    function makeGroup() {
      const g = { files: [], active: null, views: new Map(), decos: null };
      g.tabs = h('div.tabs.ed-tabs');
      g.actions = h('div.ed-actions');
      g.host = h('div.ed-host');
      g.status = h('div.ed-status');
      g.el = h('div.ed-group', h('div.ed-head', g.tabs, g.actions), g.host, g.status);
      g.el.addEventListener('mousedown', () => setActive(g), true);
      if (monaco) {
        g.editor = monaco.editor.create(g.host, {
          model: null, theme: 'phantom', automaticLayout: false, glyphMargin: true,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font'), fontSize: settings.editorFontSize, fontLigatures: settings.fontLigatures,
          minimap: { enabled: settings.minimap, scale: 1, renderCharacters: false }, wordWrap: settings.wordWrap ? 'on' : 'off',
          smoothScrolling: true, cursorBlinking: 'phase', cursorSmoothCaretAnimation: 'on', renderLineHighlight: 'all',
          bracketPairColorization: { enabled: true }, guides: { bracketPairs: 'active', indentation: true }, padding: { top: 6 },
          scrollBeyondLastLine: false, wordBasedSuggestions: 'allDocuments', quickSuggestions: { other: true, comments: false, strings: true },
          suggestSelection: 'recentlyUsedByPrefix', fixedOverflowWidgets: true, stickyScroll: { enabled: true }, linkedEditing: true,
          mouseWheelZoom: true, tabSize: settings.tabSize, renderWhitespace: 'selection', lineNumbersMinChars: 4
        });
        const K = monaco.KeyMod; const C = monaco.KeyCode;
        g.editor.addCommand(K.CtrlCmd | C.KeyS, () => save(g));
        g.editor.addCommand(K.CtrlCmd | K.Shift | C.KeyS, () => saveAs(g));
        g.editor.addCommand(K.CtrlCmd | C.KeyW, () => g.active && closeTab(g, g.active));
        g.editor.addCommand(K.CtrlCmd | C.Backslash, () => toggleSplit());
        g.editor.addCommand(C.F9, () => { const p = g.editor.getPosition(); if (g.active && p) toggleBreakpoint(g.active, p.lineNumber); });
        g.editor.addCommand(K.CtrlCmd | C.Tab, () => cycleTab(g, 1));
        g.editor.onMouseDown((e) => {
          const T = monaco.editor.MouseTargetType;
          if (g.active && (e.target.type === T.GUTTER_GLYPH_MARGIN || (e.target.type === T.GUTTER_LINE_DECORATIONS))) toggleBreakpoint(g.active, e.target.position.lineNumber);
        });
        g.editor.onDidChangeCursorSelection((e) => {
          renderStatus(g);
          const m = g.editor.getModel();
          if (m && live.session.role) {
            const sel = e.selection;
            bus.emit('editor:cursor', { model: m, anchor: m.getOffsetAt({ lineNumber: sel.selectionStartLineNumber, column: sel.selectionStartColumn }), head: m.getOffsetAt(sel.getPosition()) });
          }
        });
        g.editor.onDidFocusEditorText(() => setActive(g));
        g.decos = g.editor.createDecorationsCollection([]);
      } else {
        g.ta = h('textarea.ed-fallback', { spellcheck: false });
        g.host.appendChild(g.ta);
        g.ta.addEventListener('input', () => { const d = docs.get(g.active); if (d) { g.syncing = true; d.model.setValue(g.ta.value); g.syncing = false; } });
        g.ta.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(g); }
          else if (e.key === 'Tab') { e.preventDefault(); const s = g.ta.selectionStart; g.ta.setRangeText(' '.repeat(settings.tabSize), s, g.ta.selectionEnd, 'end'); g.ta.dispatchEvent(new Event('input')); }
        });
        g.ta.addEventListener('keyup', () => renderStatus(g)); g.ta.addEventListener('click', () => renderStatus(g));
      }
      g.empty = h('div.empty.ed-empty', { html: `<div><b>NO FILE</b>Ctrl+P go to file · double-click in explorer<br>F9 breakpoint · Ctrl+\\ split · Ctrl+S save</div>` });
      g.host.appendChild(g.empty);
      g.actions.append(
        h('button.btn.ghost.icon.ed-run', { title: 'Run (F5) · right-click for more', html: icon('play'), on: {
          click: () => { setActive(g); run.start({ debug: true }); },
          contextmenu: (e) => { e.preventDefault(); setActive(g); menu(e.clientX, e.clientY, [
            { label: 'Start', key: 'F5', action: () => run.start({ debug: true }) },
            { label: 'Start without debugging', key: 'Ctrl+F5', action: () => run.start({ debug: false }) },
            { label: 'Stop', key: 'Shift+F5', action: run.stop },
            { label: 'Restart', key: 'Ctrl+Shift+F5', action: run.restart },
            '-', { label: 'Set project run command…', action: run.configure }
          ]); }
        } }),
        h('button.btn.ghost.icon', { title: 'Split editor (Ctrl+\\)', html: icon('split'), on: { click: toggleSplit } }),
        h('button.btn.ghost.icon', { title: 'More', html: icon('chev'), on: { click: (e) => moreMenu(g, e) } })
      );
      return g;
    }

    function setActive(g) { active = g; groups.forEach((x) => x.el.classList.toggle('on', x === g && groups.length > 1)); updateSub(); }
    function updateSub() { const p = active && active.active; win.setSub(!p ? '' : live.isCollabPath(p) ? `⇄ live · ${basename(p)}` : rel(project.root, p)); }

    function layout() {
      root.innerHTML = '';
      groups.forEach((g, i) => {
        if (i) { const gut = h('div.gutter-x'); root.appendChild(gut); splitter(gut, groups[0].el, { min: 160, onResize: relayout }); }
        root.appendChild(g.el);
      });
      groups[0].el.style.flex = groups.length > 1 ? '0 0 50%' : '1';
      relayout();
    }
    function relayout() { for (const g of groups) if (g.editor) g.editor.layout(); }

    function renderTabs(g) {
      g.tabs.innerHTML = '';
      for (const p of g.files) {
        const d = docs.get(p);
        const dirty = d && d.dirty; const conflict = d && d.conflict;
        const t = h('button.tab' + (p === g.active ? '.on' : '') + (dirty ? '.dirty' : ''), { title: p, html: `<span class="fi fi-${esc(ext(p))}">${fileGlyph(p)}</span><span>${esc(basename(p))}</span>${live.isCollabPath(p) || live.liveDocFor(p) ? '<span class="live-dot" title="live-shared">⇄</span>' : ''}${conflict ? '<span class="c-amber">!</span>' : ''}<span class="x">${dirty ? '●' : '×'}</span>` });
        t.addEventListener('click', (e) => { if (e.target.closest('.x')) closeTab(g, p); else activate(g, p); });
        t.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(g, p); });
        t.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(g, p, e); });
        t.draggable = true;
        t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/phantom-tab', JSON.stringify({ win: win.id, g: groups.indexOf(g), p })); });
        g.tabs.appendChild(t);
      }
      g.empty.style.display = g.active ? 'none' : '';
      if (g.ta) g.ta.style.display = g.active ? '' : 'none';
    }

    function renderStatus(g) {
      const p = g.active; const d = p && docs.get(p);
      if (!d) { g.status.innerHTML = '<span class="c-dim">ready</span>'; return; }
      let pos = ''; let lang = ext(p) || 'text'; let sel = '';
      if (g.editor) {
        const ps = g.editor.getPosition(); const s = g.editor.getSelection();
        if (ps) pos = `Ln ${ps.lineNumber}, Col ${ps.column}`;
        if (s && !s.isEmpty()) sel = ` (${g.editor.getModel().getValueInRange(s).length} sel)`;
        lang = d.model.getLanguageId();
      } else if (g.ta) {
        const before = g.ta.value.slice(0, g.ta.selectionStart); const lines = before.split('\n');
        pos = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
      }
      const bp = breakpoints.get(p);
      g.status.innerHTML = `<span>${pos}${sel}</span><span>${esc(lang)}</span><span>${d.eol || 'LF'}</span><span>UTF-8</span><span>spaces:${settings.tabSize}</span>${bp && bp.size ? `<span class="c-red">● ${bp.size} bp</span>` : ''}${live.liveDocFor(p) ? `<span class="c-cyan">⇄ LIVE · ${live.session.peers.length} in session</span>` : live.isCollabPath(p) ? '<span class="c-amber">⇄ offline copy</span>' : ''}<span class="sp"></span>${d.virtual ? (live.liveDocFor(p) ? '<span class="c-cyan">owner saves</span>' : '') : d.conflict ? '<span class="c-amber">changed on disk</span>' : d.dirty ? '<span class="c-amber">● modified</span>' : '<span class="c-acc">saved</span>'}`;
    }

    function decorate(g) {
      if (!g.editor || !g.active) return;
      const list = [];
      for (const line of breakpoints.get(g.active) || []) list.push({ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'pw-bp', glyphMarginHoverMessage: { value: 'Breakpoint (F9 / click to remove)' }, stickiness: 1 } });
      if (debugLoc.path === g.active && debugLoc.line) list.push({ range: new monaco.Range(debugLoc.line, 1, debugLoc.line, 1), options: { isWholeLine: true, className: 'pw-dbg-line', glyphMarginClassName: 'pw-dbg-arrow' } });
      g.decos.set(list);
    }

    async function activate(g, p, opts = {}) {
      const d = docs.get(p); if (!d) return;
      if (g.editor) {
        if (g.active && g.active !== p) g.views.set(g.active, g.editor.saveViewState());
        g.active = p;
        if (g.editor.getModel() !== d.model) g.editor.setModel(d.model);
        const vs = g.views.get(p); if (vs && !opts.line) g.editor.restoreViewState(vs);
        if (opts.line) { const pos = { lineNumber: opts.line, column: opts.column || 1 }; g.editor.setPosition(pos); g.editor.revealPositionInCenter(pos); }
        decorate(g);
        if (opts.focus !== false) g.editor.focus();
      } else {
        g.active = p; g.ta.value = d.getValue();
        if (opts.line) { const idx = d.getValue().split('\n').slice(0, opts.line - 1).join('\n').length + 1; g.ta.setSelectionRange(idx, idx); }
        if (opts.focus !== false) g.ta.focus();
      }
      setActive(g); renderTabs(g); renderStatus(g);
      win.save();
    }

    async function openFile(path, opts = {}) {
      path = normPath(path);
      const g = opts.group !== undefined ? groups[opts.group] || active : active;
      if (!g.files.includes(path)) {
        let doc;
        try { doc = await openDoc(path); } catch (e) { fail(e, 'OPEN'); return; }
        if (g.files.includes(path)) releaseDoc(doc); // raced
        else { const i = g.active ? g.files.indexOf(g.active) + 1 : g.files.length; g.files.splice(i, 0, path); }
      }
      await activate(g, path, opts);
    }

    async function confirmRelease(paths) {
      // Only prompt for docs whose last reference lives in this set.
      const count = new Map(); for (const p of paths) count.set(p, (count.get(p) || 0) + 1);
      const dirty = [...count].map(([p, n]) => docs.get(p)).filter((d) => d && d.dirty && d.refs <= count.get(d.path));
      if (!dirty.length) return true;
      const r = await choice('Unsaved changes', `${dirty.map((d) => '  ' + d.name).join('\n')}\n\nSave before closing?`, [{ label: 'CANCEL', value: null }, { label: "DON'T SAVE", value: 'discard', cls: 'danger' }, { label: 'SAVE', value: 'save', cls: 'primary' }]);
      if (!r) return false;
      if (r === 'save') { try { for (const d of dirty) await saveDoc(d); } catch (e) { fail(e, 'SAVE'); return false; } }
      return true;
    }

    async function closeTab(g, p, skipConfirm) {
      if (!skipConfirm && !(await confirmRelease([p]))) return;
      const i = g.files.indexOf(p); if (i < 0) return;
      g.files.splice(i, 1); g.views.delete(p);
      const d = docs.get(p);
      if (g.active === p) {
        const next = g.files[Math.min(i, g.files.length - 1)];
        g.active = null;
        if (next) await activate(g, next, { focus: false });
        else { if (g.editor) g.editor.setModel(null); renderTabs(g); renderStatus(g); updateSub(); }
      } else renderTabs(g);
      if (d) releaseDoc(d);
      if (!g.files.length && groups.length > 1) { groups.splice(groups.indexOf(g), 1); if (g.editor) g.editor.dispose(); setActive(groups[0]); layout(); }
      win.save();
    }

    function cycleTab(g, dir) { if (g.files.length < 2) return; const i = g.files.indexOf(g.active); activate(g, g.files[(i + dir + g.files.length) % g.files.length]); }

    async function save(g) {
      const d = g.active && docs.get(g.active); if (!d) return;
      if (d.conflict) {
        const r = await choice('File changed on disk', `${d.name} was modified outside PHANTOM.\nOverwrite the version on disk with your edits?`, [{ label: 'CANCEL', value: null }, { label: 'OVERWRITE', value: true, cls: 'danger' }]);
        if (!r) return;
      }
      try { await saveDoc(d); } catch (e) { fail(e, 'SAVE FAILED'); }
    }
    async function saveAs(g) {
      const d = g.active && docs.get(g.active); if (!d) return;
      let target = null;
      try { target = await call('fs:pickSave', 'Save as', d.path); } catch { target = await prompt('Save as', d.path, { select: false }); }
      if (!target) return;
      try { await call('fs:write', target, d.getValue()); await openFile(target); } catch (e) { fail(e); }
    }

    async function toggleSplit() {
      if (groups.length > 1) {
        const g = groups[1];
        for (const p of [...g.files]) if (!groups[0].files.includes(p)) groups[0].files.push(p), await openDoc(p);
        for (const p of g.files) { const d = docs.get(p); if (d) releaseDoc(d); }
        groups.splice(1, 1); if (g.editor) g.editor.dispose();
        renderTabs(groups[0]); setActive(groups[0]); layout(); win.save(); return;
      }
      const g = makeGroup(); groups.push(g); layout();
      const p = groups[0].active;
      if (p) { setActive(g); await openFile(p); } else setActive(g);
    }

    function tabMenu(g, p, e) {
      const isMd = /^(md|markdown|mdx)$/.test(ext(p)); const isJson = /^(json|jsonc|geojson)$/.test(ext(p));
      menu(e.clientX, e.clientY, [
        { header: basename(p) },
        { label: 'Save', key: 'Ctrl+S', action: () => activate(g, p).then(() => save(g)) },
        { label: 'Close', key: 'Ctrl+W', action: () => closeTab(g, p) },
        { label: 'Close others', action: async () => { const others = g.files.filter((x) => x !== p); if (await confirmRelease(others)) for (const x of others) await closeTab(g, x, true); } },
        { label: 'Close to the right', action: async () => { const r = g.files.slice(g.files.indexOf(p) + 1); if (await confirmRelease(r)) for (const x of r) await closeTab(g, x, true); } },
        '-',
        { label: groups.length > 1 ? 'Move to other group' : 'Open in split', action: async () => {
          if (groups.length === 1) { await toggleSplit(); return; }
          const other = groups[1 - groups.indexOf(g)];
          setActive(other); await openFile(p); await closeTab(g, p, true);
        } },
        { label: 'Open in new editor window', action: () => wm.open('editor', { state: { groups: [{ files: [p], active: p }] } }) },
        isMd ? { label: 'Markdown preview', action: () => wm.open('markdown', { state: { path: p } }) } : null,
        isJson ? { label: 'Open in JSON viewer', action: () => wm.open('json', { state: { path: p } }) } : null,
        project.gitRoot ? { label: 'Diff against HEAD', action: () => wm.open('diff', { state: { root: project.gitRoot, file: p } }) } : null,
        /\.(m?js|cjs)$/.test(p) ? { label: 'Debug this file', action: () => wm.open('debug', { state: { program: p, autostart: true } }) } : null,
        live.session.role && !live.isCollabPath(p) && !live.liveDocFor(p) ? { label: 'Share in live session', action: () => live.share(p).catch((e) => fail(e, 'SHARE')) } : null,
        live.liveDocFor(p) && live.liveDocFor(p).owner ? { label: 'Stop sharing', action: () => live.unshare(live.liveDocFor(p).id) } : null,
        '-',
        { label: 'Copy path', action: () => copy(p) },
        { label: 'Copy relative path', action: () => copy(rel(project.root, p)) },
        { label: 'Reveal in explorer', action: () => bus.emit('explorer:reveal', p) },
        { label: 'Reveal in system file manager', action: () => call('fs:reveal', p) }
      ]);
    }
    function moreMenu(g, e) {
      const p = g.active;
      menu(e.clientX - 160, e.clientY + 10, [
        { label: 'Save', key: 'Ctrl+S', action: () => save(g), disabled: !p },
        { label: 'Save as…', key: 'Ctrl+Shift+S', action: () => saveAs(g), disabled: !p },
        { label: 'Save all', action: async () => { for (const gg of groups) for (const f of gg.files) { const d = docs.get(f); if (d && d.dirty) await saveDoc(d).catch(fail); } } },
        { label: 'New file…', action: async () => { const n = await prompt('New file', (project.root || '') + '/untitled.txt', { select: false }); if (n) { try { await call('fs:createFile', n); await openFile(n); } catch (er) { fail(er); } } } },
        '-',
        { label: 'Command palette (editor)', key: 'F1', action: () => g.editor && (g.editor.focus(), g.editor.trigger('k', 'editor.action.quickCommand')) , disabled: !g.editor },
        { label: 'Format document', key: 'Shift+Alt+F', action: () => g.editor && g.editor.getAction('editor.action.formatDocument').run(), disabled: !g.editor },
        { label: 'Go to line…', key: 'Ctrl+G', action: () => g.editor && (g.editor.focus(), g.editor.trigger('k', 'editor.action.gotoLine')), disabled: !g.editor },
        { label: 'Toggle word wrap', action: () => g.editor && g.editor.updateOptions({ wordWrap: g.editor.getOption(monaco.editor.EditorOption.wordWrap) === 'on' ? 'off' : 'on' }), disabled: !g.editor },
        { label: 'Toggle breakpoint', key: 'F9', action: () => { const ps = g.editor && g.editor.getPosition(); if (p && ps) toggleBreakpoint(p, ps.lineNumber); }, disabled: !p || !g.editor },
        '-',
        p && /^(md|markdown)$/.test(ext(p)) ? { label: 'Markdown preview', action: () => wm.open('markdown', { state: { path: p } }) } : null,
        p && /^json/.test(ext(p)) ? { label: 'JSON tree view', action: () => wm.open('json', { state: { path: p } }) } : null
      ]);
    }

    // drag tabs between groups / editor windows
    root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/phantom-tab')) e.preventDefault(); });
    root.addEventListener('drop', async (e) => {
      const raw = e.dataTransfer.getData('text/phantom-tab'); if (!raw) return;
      e.preventDefault();
      const { p } = JSON.parse(raw);
      const ge = e.target.closest('.ed-group'); const g = groups.find((x) => x.el === ge) || active;
      setActive(g); await openFile(p);
    });

    // reactive updates
    offs.push(bus.on('doc:dirty', (d) => { for (const g of groups) if (g.files.includes(d.path)) { renderTabs(g); if (g.active === d.path) renderStatus(g); } }));
    offs.push(bus.on('collab:remoteop', ({ model, op }) => { for (const g of groups) { const d = docs.get(g.active); if (g.ta && d && d.model === model) g.pendingSel = [op.transformIndex(g.ta.selectionStart), op.transformIndex(g.ta.selectionEnd)]; } }));
    offs.push(bus.on('doc:changed', (d) => { for (const g of groups) if (g.ta && g.active === d.path && !g.syncing && g.ta.value !== d.getValue()) { const [a, z] = g.pendingSel || [g.ta.selectionStart, g.ta.selectionEnd]; g.pendingSel = null; g.ta.value = d.getValue(); g.ta.setSelectionRange(Math.min(a, g.ta.value.length), Math.min(z, g.ta.value.length)); } }));
    offs.push(bus.on('collab:bound', (p) => { for (const g of groups) if (g.files.includes(p)) { renderTabs(g); renderStatus(g); } }));
    offs.push(bus.on('collab:changed', () => { for (const g of groups) renderStatus(g); }));
    offs.push(bus.on('bp:changed', (p) => { for (const g of groups) if (g.active === p) { decorate(g); renderStatus(g); } }));
    offs.push(bus.on('debug:loc', () => { for (const g of groups) decorate(g); }));
    offs.push(bus.on('settings:changed', (k) => {
      for (const g of groups) if (g.editor) g.editor.updateOptions({ fontSize: settings.editorFontSize, minimap: { enabled: settings.minimap }, wordWrap: settings.wordWrap ? 'on' : 'off', fontLigatures: settings.fontLigatures, tabSize: settings.tabSize });
      if (k === 'uiFontSize') relayout();
    }));
    offs.push(win.onResize(relayout));

    groups.push(makeGroup());
    setActive(groups[0]);
    layout();
    // restore
    const sg = (state.groups && state.groups.length) ? state.groups : [{ files: [], active: null }];
    for (let i = 0; i < sg.length; i++) {
      if (i > 0) { groups.push(makeGroup()); layout(); }
      const g = groups[i]; setActive(g);
      for (const p of sg[i].files || []) { try { const d = await openDoc(p); g.files.push(p); void d; } catch { /* file gone */ } }
      const a = (sg[i].active && g.files.includes(sg[i].active)) ? sg[i].active : g.files[0];
      if (a) await activate(g, a, { focus: false }); else renderTabs(g);
      renderStatus(g);
    }
    setActive(groups[0]);
    if (state.open) await openFile(state.open, { line: state.line });

    return {
      openFile,
      activeFile: () => (active && active.active) || (groups.find((x) => x.active) || {}).active || null,
      onShow: relayout,
      onFocus: () => { const g = active; if (g && g.editor && g.active) setTimeout(() => g.editor.focus(), 0); },
      serialize: () => ({ groups: groups.map((g) => ({ files: [...g.files], active: g.active })) }),
      canClose: () => confirmRelease(groups.flatMap((g) => g.files)),
      destroy() {
        offs.forEach((f) => f());
        for (const g of groups) { for (const p of g.files) { const d = docs.get(p); if (d) releaseDoc(d); } if (g.editor) g.editor.dispose(); }
      }
    };
  }
};

export function fileGlyph(p) {
  const e = ext(p);
  const map = { js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JX', ts: 'TS', tsx: 'TX', py: 'PY', go: 'GO', rs: 'RS', json: '{}', md: 'MD', html: '<>', css: '#', scss: '#', sh: '$', yml: 'YM', yaml: 'YM', toml: 'TM', sql: 'SQ', c: 'C', h: 'H', cpp: 'C+', java: 'JV', rb: 'RB', php: 'PH', lock: 'LK', env: '•', txt: '≡', svg: 'SV', vue: 'VU', swift: 'SW', kt: 'KT', lua: 'LU', dockerfile: 'DK' };
  return map[e] || (basename(p).toLowerCase() === 'dockerfile' ? 'DK' : basename(p).toLowerCase() === 'makefile' ? 'MK' : '··');
}
