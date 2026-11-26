// Database explorer: SQLite / PostgreSQL / MySQL — schema browser, SQL editor, result grid.
import { h, esc, copy, basename } from '../core/dom.js';
import { call } from '../core/api.js';
import { loadMonaco } from '../core/docs.js';
import { settings } from '../core/settings.js';
import { form, toast, fail, menu, splitter, confirm } from '../core/ui.js';
import { project } from '../core/project.js';

export default {
  id: 'db', title: 'Database', icon: 'db', desc: 'SQLite / Postgres / MySQL explorer', size: [960, 600], min: [500, 300],
  async create(win, state) {
    let conn = null; let cfg = state.conn || null; let tables = []; let result = null; let history = state.history || [];
    const offs = [];
    const connBtn = h('button.btn.primary', { on: { click: () => connectDialog() } }, 'CONNECT');
    const label = h('span.c-dim');
    const runBtn = h('button.btn.primary', { disabled: true, on: { click: () => run() } }, '▶ RUN');
    const side = h('div.db-side.scroll');
    const edHost = h('div.db-editor');
    const resHead = h('div.toolbar.db-reshead');
    const grid = h('div.fill.scroll.db-grid.sel-text');
    const right = h('div.split-v.fill', edHost, h('div.gutter-y'), h('div.split-v.fill', resHead, grid));
    edHost.style.flex = '0 0 150px';
    splitter(right.children[1], edHost, { axis: 'y', min: 60, onResize: () => ed && ed.layout && ed.layout() });
    side.style.flex = '0 0 220px';
    const gx = h('div.gutter-x');
    win.body.append(h('div.toolbar', connBtn, label, h('span.sp'), h('span.c-mute', 'Ctrl+Enter runs selection or all'), runBtn), h('div.split-h.fill', side, gx, right));
    splitter(gx, side, { min: 140 });

    // SQL editor
    const monaco = await loadMonaco();
    let ed; let getSql;
    const initialSql = state.sql || '-- connect, then pick a table or write SQL\nSELECT 1;';
    if (monaco) {
      const model = monaco.editor.createModel(initialSql, 'sql');
      ed = monaco.editor.create(edHost, { model, theme: 'phantom', minimap: { enabled: false }, fontSize: settings.editorFontSize, scrollBeyondLastLine: false, lineNumbersMinChars: 3, automaticLayout: false, wordBasedSuggestions: 'currentDocument', fixedOverflowWidgets: true });
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());
      getSql = () => { const s = ed.getSelection(); const sel = s && !s.isEmpty() ? model.getValueInRange(s) : ''; return sel.trim() ? sel : model.getValue(); };
      offs.push(() => { ed.dispose(); model.dispose(); });
      // completions for table/column names
      const prov = monaco.languages.registerCompletionItemProvider('sql', {
        provideCompletionItems: (m, pos) => {
          if (m !== model) return { suggestions: [] };
          const w = m.getWordUntilPosition(pos); const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
          const kw = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'JOIN', 'LEFT JOIN', 'ON', 'AND', 'OR', 'COUNT(*)', 'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE', 'DISTINCT', 'HAVING', 'AS', 'IN', 'LIKE', 'IS NULL'];
          return { suggestions: [
            ...tables.map((t) => ({ label: t.name, kind: monaco.languages.CompletionItemKind.Struct, insertText: t.name, range, detail: t.type })),
            ...tables.flatMap((t) => (t.cols || []).map((c) => ({ label: c.name, kind: monaco.languages.CompletionItemKind.Field, insertText: c.name, range, detail: `${t.name}.${c.type || ''}` }))),
            ...kw.map((k) => ({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range }))
          ] };
        }
      });
      offs.push(() => prov.dispose());
      win.onResize(() => ed.layout());
    } else {
      const ta = h('textarea.inp', { spellcheck: false, style: { width: '100%', height: '100%', resize: 'none' } }, initialSql);
      edHost.appendChild(ta);
      ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
      getSql = () => { const s = ta.value.slice(ta.selectionStart, ta.selectionEnd); return s.trim() ? s : ta.value; };
      ed = { getValue: () => ta.value, setValue: (v) => { ta.value = v; } };
    }
    const setSql = (s) => { if (ed.getModel) ed.getModel().setValue(s); else ed.setValue(s); };
    const currentSql = () => (ed.getModel ? ed.getModel().getValue() : ed.getValue());

    async function connectDialog(prefill) {
      const saved = (await call('store:get', 'db-conns', [])) || [];
      const c = prefill || cfg || {};
      const pick = await form('Connect to database', [
        { key: 'type', label: 'Engine', type: 'select', value: c.type || 'sqlite', options: [{ value: 'sqlite', label: 'SQLite (file)' }, { value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL / MariaDB' }] },
        { key: 'file', label: 'SQLite file (created if missing)', value: c.file || (project.root ? project.root + '/data.db' : ''), placeholder: '/path/to/app.db' },
        { key: 'host', label: 'Host (server engines)', value: c.host || '127.0.0.1' },
        { key: 'port', label: 'Port', value: c.port || '' , placeholder: '5432 / 3306' },
        { key: 'user', label: 'User', value: c.user || '' },
        { key: 'password', label: 'Password (kept in memory only)', type: 'password', value: '' },
        { key: 'database', label: 'Database', value: c.database || '' },
        { key: 'ssl', label: 'Use TLS', type: 'checkbox', value: !!c.ssl },
        ...(saved.length ? [{ key: 'savedIdx', label: 'Or load a saved connection', type: 'select', value: '', options: [{ value: '', label: '—' }, ...saved.map((s, i) => ({ value: String(i), label: s.type === 'sqlite' ? `sqlite · ${s.file}` : `${s.type} · ${s.user}@${s.host}/${s.database}` }))] }] : [])
      ], { ok: 'CONNECT' });
      if (!pick) return;
      let conf = pick;
      if (pick.savedIdx) { const s = saved[Number(pick.savedIdx)]; conf = { ...s, password: pick.password }; if (s.type !== 'sqlite' && !pick.password) { connectDialog(s); return; } }
      await connect(conf);
      const toSave = { type: conf.type, file: conf.file, host: conf.host, port: conf.port, user: conf.user, database: conf.database, ssl: conf.ssl };
      if (conn && !saved.some((s) => JSON.stringify(s) === JSON.stringify(toSave))) call('store:set', 'db-conns', [toSave, ...saved].slice(0, 20)).catch(() => {});
    }

    async function connect(c) {
      if (conn) { await call('db:close', conn.id).catch(() => {}); conn = null; }
      try {
        conn = await call('db:connect', c.type === 'sqlite' ? { type: 'sqlite', file: c.file } : c);
        cfg = { ...c, password: undefined };
        label.innerHTML = `<span class="c-acc">●</span> ${esc(conn.kind)} · ${esc(conn.label)} <span class="c-mute">${esc(conn.engine)}</span>`;
        win.setSub(conn.label); runBtn.disabled = false; connBtn.textContent = 'SWITCH'; connBtn.classList.remove('primary');
        await loadTables(); win.save();
      } catch (e) { fail(e, 'CONNECT'); }
    }

    async function loadTables() {
      tables = await call('db:tables', conn.id).catch((e) => { fail(e); return []; });
      side.innerHTML = '';
      side.appendChild(h('div.hdr', `TABLES (${tables.length})`, h('span.sp'), h('button.btn.ghost', { on: { click: loadTables } }, '⟳')));
      for (const t of tables) {
        const row = h('div.db-table', { html: `<span class="${t.type === 'view' ? 'c-violet' : 'c-acc'}">${t.type === 'view' ? 'V' : 'T'}</span> ${esc(t.name)}` });
        const cols = h('div.db-cols');
        row.addEventListener('click', async () => {
          const sql = await call('db:selectSql', conn.id, t.name, 200); setSql(sql); run(sql);
          if (!t.cols) { t.cols = await call('db:columns', conn.id, t.name).catch(() => []); }
          cols.innerHTML = t.cols.map((c) => `<div><span class="${c.pk ? 'c-amber' : 'c-dim'}">${c.pk ? '⚿' : '·'}</span> ${esc(c.name)} <span class="c-mute">${esc(c.type || '')}${c.nullable ? '' : ' not null'}</span></div>`).join('');
          cols.classList.toggle('open');
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
          { label: 'SELECT * LIMIT 200', action: async () => { const sql = await call('db:selectSql', conn.id, t.name, 200); setSql(sql); run(sql); } },
          { label: 'COUNT(*)', action: () => { const sql = `SELECT COUNT(*) AS n FROM ${conn.kind === 'mysql' ? '`' + t.name + '`' : '"' + t.name + '"'};`; setSql(sql); run(sql); } },
          { label: 'Copy name', action: () => copy(t.name) }
        ]); });
        side.append(row, cols);
      }
    }

    async function run(sql) {
      if (!conn) { connectDialog(); return; }
      sql = sql || getSql();
      if (/^\s*(drop|truncate|delete\s+from\s+\S+\s*;?\s*$|alter)/i.test(sql) && !(await confirm('Destructive statement', `This statement modifies or deletes data/schema:\n\n${sql.slice(0, 300)}`, { danger: true, ok: 'RUN IT' }))) return;
      resHead.innerHTML = '<span class="spin"></span> running…';
      try {
        result = await call('db:query', conn.id, sql);
        history = [sql, ...history.filter((x) => x !== sql)].slice(0, 30);
        renderResult();
        if (/^\s*(create|drop|alter)/i.test(sql)) loadTables();
      } catch (e) { result = null; resHead.innerHTML = `<span class="pill c-red">ERROR</span> <span class="c-red sel-text">${esc(e.message)}</span>`; grid.innerHTML = ''; }
      win.save();
    }

    function renderResult() {
      const r = result;
      if (!r.columns.length) {
        resHead.innerHTML = `<span class="pill c-acc">OK</span> ${r.changes != null ? `${r.changes} row(s) affected` : 'statement executed'}${r.lastInsertId != null ? ` · last id ${esc(r.lastInsertId)}` : ''} <span class="c-dim">${r.ms}ms</span>`;
        grid.innerHTML = ''; return;
      }
      resHead.innerHTML = `<span class="pill c-acc">${r.rows.length} rows</span>${r.capped ? `<span class="c-amber">showing first ${r.rows.length} of ${r.total}</span>` : ''}<span class="c-dim">${r.ms}ms</span><span class="sp"></span>`;
      resHead.appendChild(h('button.btn.ghost', { on: { click: () => { copy(toCsv(r)); toast('copied as CSV'); } } }, 'copy CSV'));
      resHead.appendChild(h('button.btn.ghost', { on: { click: () => { copy(JSON.stringify(r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))), null, 2)); toast('copied as JSON'); } } }, 'copy JSON'));
      grid.innerHTML = `<table class="grid"><tr><th class="num">#</th>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${r.rows.map((row, i) => `<tr><td class="num c-mute">${i + 1}</td>${row.map((v) => v === null ? '<td class="c-mute">NULL</td>' : typeof v === 'number' ? `<td class="num c-cyan">${v}</td>` : `<td title="${esc(String(v).slice(0, 500))}">${esc(String(v).slice(0, 300))}</td>`).join('')}</tr>`).join('')}</table>`;
    }
    const toCsv = (r) => [r.columns, ...r.rows].map((row) => row.map((v) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n');

    side.appendChild(h('div.empty', { html: '<div><b>NOT CONNECTED</b>SQLite files open directly.<br>Server credentials are never written to disk.</div>' }));
    resHead.innerHTML = '<span class="c-mute">results appear here</span>';
    if (cfg && cfg.type === 'sqlite' && cfg.file) connect(cfg);
    else if (cfg && cfg.type) { label.textContent = `last: ${cfg.type} ${cfg.user || ''}@${cfg.host || ''}/${cfg.database || ''} (password required)`; }

    return {
      serialize: () => ({ conn: cfg, sql: currentSql(), history }),
      destroy() { offs.forEach((f) => f()); if (conn) call('db:close', conn.id).catch(() => {}); }
    };
  }
};
export { basename };
