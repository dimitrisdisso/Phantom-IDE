// Git: status, stage/unstage/discard, diff, commit, branches, graph log, push/pull/fetch, stash.
import { h, icon, esc, basename, debounce } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { project, refreshGit } from '../core/project.js';
import { menu, prompt, confirm, toast, fail, splitter } from '../core/ui.js';
import { wm } from '../core/wm.js';

export function renderDiff(text) {
  if (!text) return '<div class="c-mute" style="padding:10px">no changes</div>';
  const out = []; let oldN = 0; let newN = 0;
  for (const line of text.split('\n')) {
    let cls = ''; let a = ''; let b = '';
    if (/^(diff --git|index |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) cls = 'meta';
    else if (line.startsWith('+++') || line.startsWith('---')) cls = 'file';
    else if (line.startsWith('@@')) { cls = 'hunk'; const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line); if (m) { oldN = +m[1]; newN = +m[2]; } }
    else if (line.startsWith('+')) { cls = 'add'; b = newN++; }
    else if (line.startsWith('-')) { cls = 'del'; a = oldN++; }
    else if (line.startsWith(' ')) { a = oldN++; b = newN++; }
    else if (/^(commit|Author|Date)/.test(line)) cls = 'meta';
    out.push(`<div class="dl ${cls}"><span class="ln">${a}</span><span class="ln">${b}</span><span class="tx">${esc(line) || ' '}</span></div>`);
  }
  return out.join('');
}

export default {
  id: 'git', title: 'Git', icon: 'git', desc: 'Source control', size: [820, 560], min: [420, 260], key: 'Ctrl+Shift+G',
  async create(win, state) {
    let st = null; let tab = state.tab || 'diff'; let selected = null; let busy = false;
    const offs = [];
    const branchBtn = h('button.btn', { on: { click: branchMenu } });
    const syncInfo = h('span.c-dim');
    const actions = h('div.toolbar',
      branchBtn, syncInfo, h('span.sp'),
      h('button.btn.ghost.icon', { title: 'Fetch', html: icon('refresh'), on: { click: () => netOp('fetch') } }),
      h('button.btn.ghost', { title: 'Pull (fast-forward only)', on: { click: () => netOp('pull') }, html: icon('down') + 'PULL' }),
      h('button.btn.ghost', { title: 'Push', on: { click: () => netOp('push') }, html: icon('up') + 'PUSH' }),
      h('button.btn.ghost.icon', { title: 'More', html: icon('chev'), on: { click: moreMenu } })
    );
    const changes = h('div.git-changes.scroll.fill');
    const msg = h('textarea.inp.git-msg', { placeholder: 'commit message  (Ctrl+Enter to commit)', rows: 3, spellcheck: false });
    const amend = h('input', { type: 'checkbox' });
    const commitBtn = h('button.btn.primary', { on: { click: commit } }, 'COMMIT');
    const left = h('div.git-left.split-v', actions, changes, h('div.git-commit', msg, h('div.toolbar', h('label.chk', amend, 'amend'), h('span.sp'), commitBtn)));
    const tabs = h('div.tabs');
    const view = h('div.fill.scroll.git-view.sel-text');
    const right = h('div.split-v.fill', tabs, view);
    const gut = h('div.gutter-x');
    const wrap = h('div.split-h.fill', left, gut, right);
    left.style.flex = '0 0 46%';
    splitter(gut, left, { min: 220 });
    win.body.appendChild(wrap);

    const root = () => project.gitRoot;

    async function refresh() {
      if (!project.root) { changes.innerHTML = '<div class="empty"><div><b>NO PROJECT</b></div></div>'; return; }
      if (!root()) {
        changes.innerHTML = ''; changes.appendChild(h('div.empty', h('div', h('b', 'NOT A GIT REPOSITORY'), h('button.btn.primary', { style: { marginTop: '10px' }, on: { click: async () => { await call('git:init', project.root); await refreshGit(); refresh(); } } }, 'GIT INIT'))));
        view.innerHTML = ''; branchBtn.textContent = '—'; return;
      }
      try { st = await call('git:status', root()); } catch (e) { changes.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      branchBtn.innerHTML = `${icon('branch')} ${esc(st.branch || '?')}`;
      syncInfo.innerHTML = st.upstream ? `${st.ahead ? `<span class="c-acc">↑${st.ahead}</span> ` : ''}${st.behind ? `<span class="c-amber">↓${st.behind}</span> ` : ''}${!st.ahead && !st.behind ? '<span class="c-dim">in sync</span>' : ''}` : '<span class="c-mute">no upstream</span>';
      win.setSub(`${basename(root())} · ${st.branch}`);
      win.setBadge(st.files.length ? String(st.files.length) : '');
      const staged = st.files.filter((f) => f.staged);
      const unstaged = st.files.filter((f) => f.unstaged || f.untracked);
      const code = (f, s) => s ? f.index : (f.untracked ? 'U' : f.work);
      const sect = (title, list, isStaged) => {
        const s = h('div.git-sect', h('div.hdr', `${title} (${list.length})`, h('span.sp'),
          list.length ? h('button.btn.ghost', { on: { click: () => isStaged ? op('unstage', list.map((f) => f.path)) : call('git:stageAll', root()).then(refresh).catch(fail) } }, isStaged ? 'unstage all' : 'stage all') : null));
        for (const f of list) {
          const c = code(f, isStaged);
          const row = h('div.git-file' + (selected && selected.path === f.path && selected.staged === isStaged ? '.sel' : ''), { title: f.path, html: `<span class="gc g-${esc(c === '?' ? 'U' : c)}">${esc(c === '?' ? 'U' : c)}</span><span class="nm">${esc(basename(f.path))}</span><span class="dir">${esc(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}</span>` });
          const btns = h('span.acts');
          if (isStaged) btns.appendChild(h('button.btn.ghost.icon', { title: 'Unstage', html: icon('min'), on: { click: (e) => { e.stopPropagation(); op('unstage', [f.path]); } } }));
          else {
            btns.appendChild(h('button.btn.ghost.icon', { title: f.untracked ? 'Delete untracked file' : 'Discard changes', html: icon('refresh'), on: { click: (e) => { e.stopPropagation(); discard(f); } } }));
            btns.appendChild(h('button.btn.ghost.icon', { title: 'Stage', html: icon('plus'), on: { click: (e) => { e.stopPropagation(); op('stage', [f.path]); } } }));
          }
          row.appendChild(btns);
          row.addEventListener('click', () => { selected = { path: f.path, staged: isStaged, untracked: f.untracked }; tab = 'diff'; renderTabs(); showDiff(); refreshSel(); });
          row.addEventListener('dblclick', () => bus.emit('open-file', `${root()}/${f.path}`, {}));
          row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
            { label: 'Open file', action: () => bus.emit('open-file', `${root()}/${f.path}`, {}) },
            !f.untracked ? { label: 'Side-by-side diff', action: () => wm.open('diff', { state: { root: root(), file: `${root()}/${f.path}`, staged: isStaged } }) } : null,
            isStaged ? { label: 'Unstage', action: () => op('unstage', [f.path]) } : { label: 'Stage', action: () => op('stage', [f.path]) },
            !isStaged ? { label: f.untracked ? 'Delete file…' : 'Discard changes…', danger: true, action: () => discard(f) } : null,
            { label: 'Copy path', action: () => navigator.clipboard.writeText(f.path) }
          ]); });
          s.appendChild(row);
        }
        return s;
      };
      const sc = changes.scrollTop;
      changes.innerHTML = '';
      if (!st.files.length) changes.appendChild(h('div.empty', { html: '<div><b>WORKING TREE CLEAN</b>nothing to commit</div>' }));
      else { if (staged.length) changes.appendChild(sect('STAGED', staged, true)); if (unstaged.length) changes.appendChild(sect('CHANGES', unstaged, false)); }
      changes.scrollTop = sc;
      commitBtn.textContent = staged.length ? `COMMIT ${staged.length}` : 'COMMIT';
      if (tab === 'log') showLog(); else if (tab === 'branches') showBranches(); else if (selected) showDiff();
    }
    const refreshSel = () => changes.querySelectorAll('.git-file').forEach((r) => r.classList.toggle('sel', r.title === (selected && selected.path) && r.closest('.git-sect').firstChild.textContent.startsWith(selected.staged ? 'STAGED' : 'CHANGES')));

    async function op(kind, files) { try { await call('git:' + kind, root(), files); await refresh(); } catch (e) { fail(e, 'GIT'); } }
    async function discard(f) {
      const ok = await confirm(f.untracked ? 'Delete untracked file' : 'Discard changes', f.untracked ? `Permanently delete "${f.path}"? It is not tracked by git, so this cannot be undone.` : `Discard all unstaged changes to "${f.path}"? This cannot be undone.`, { danger: true, ok: f.untracked ? 'DELETE' : 'DISCARD' });
      if (!ok) return;
      try { await call(f.untracked ? 'git:clean' : 'git:discard', root(), [f.path]); await refresh(); } catch (e) { fail(e); }
    }
    async function commit() {
      if (!msg.value.trim()) { toast('write a commit message first', 'warn'); msg.focus(); return; }
      if (!st || (!st.files.some((f) => f.staged) && !amend.checked)) { toast('nothing staged — stage files first', 'warn'); return; }
      try { const out = await call('git:commit', root(), msg.value, amend.checked); msg.value = ''; amend.checked = false; toast(out.split('\n')[0], 'info', 'COMMITTED'); await refresh(); refreshGit(); } catch (e) { fail(e, 'COMMIT'); }
    }
    msg.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit(); } });

    async function netOp(kind) {
      if (busy || !root()) return;
      busy = true; win.setBadge('…'); toast(`git ${kind}…`, 'info', 'GIT', 1500);
      try { const r = await call('git:' + kind, root()); toast(r || 'done', 'info', `GIT ${kind.toUpperCase()}`); } catch (e) { fail(e, `GIT ${kind.toUpperCase()}`); }
      busy = false; refresh(); refreshGit();
    }

    async function branchMenu(e) {
      if (!root()) return;
      const r = e.currentTarget.getBoundingClientRect();
      const list = await call('git:branches', root()).catch(() => []);
      menu(r.left, r.bottom, [
        { label: 'New branch…', action: async () => { const n = await prompt('New branch', '', { placeholder: 'feature/name' }); if (n) call('git:createBranch', root(), n.trim()).then(() => { refresh(); refreshGit(); }).catch(fail); } },
        '-', { header: 'LOCAL' },
        ...list.filter((b) => !b.remote).map((b) => ({ label: `${b.name}  ${b.date ? '· ' + b.date : ''}`, check: b.current, action: () => !b.current && checkout(b.name) })),
        ...(list.some((b) => b.remote) ? ['-', { header: 'REMOTE' }, ...list.filter((b) => b.remote).slice(0, 25).map((b) => ({ label: b.name, action: () => checkout(b.name.replace(/^[^/]+\//, '')) }))] : [])
      ]);
    }
    async function checkout(name) { try { await call('git:checkout', root(), name); toast(`switched to ${name}`, 'info', 'GIT'); refresh(); refreshGit(); } catch (e) { fail(e, 'CHECKOUT'); } }
    function moreMenu(e) {
      menu(e.clientX - 150, e.clientY + 10, [
        { label: 'Stash changes', action: () => call('git:stash', root(), false).then((r) => { toast(r || 'stashed'); refresh(); }).catch(fail) },
        { label: 'Pop stash', action: () => call('git:stash', root(), true).then((r) => { toast(r || 'popped'); refresh(); }).catch(fail) },
        '-',
        { label: 'Open terminal at repo root', action: () => wm.open('terminal', { state: { cwd: root() } }) },
        { label: 'Refresh', action: refresh }
      ]);
    }

    const renderTabs = () => {
      tabs.innerHTML = '';
      for (const [k, l] of [['diff', 'DIFF'], ['log', 'LOG / GRAPH'], ['branches', 'BRANCHES']]) tabs.appendChild(h('button.tab' + (tab === k ? '.on' : ''), { on: { click: () => { tab = k; renderTabs(); if (k === 'log') showLog(); else if (k === 'branches') showBranches(); else showDiff(); win.save(); } } }, l));
    };
    async function showDiff() {
      if (!selected) { view.innerHTML = '<div class="empty"><div><b>SELECT A FILE</b>click a changed file to inspect its diff</div></div>'; return; }
      try {
        const d = await call('git:diff', root(), selected.path, selected.staged);
        view.innerHTML = `<div class="git-diffhead"><span>${esc(selected.path)}</span><span class="c-dim">${selected.staged ? 'staged' : selected.untracked ? 'untracked' : 'working tree'}</span></div><div class="diff">${renderDiff(d)}</div>`;
      } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }
    async function showLog() {
      const log = await call('git:log', root(), 400).catch(() => []);
      view.innerHTML = '';
      const box = h('div.git-log');
      for (const l of log) {
        const row = h('div.gl' + (l.hash ? '' : '.edge'), { html: `<span class="graph">${esc(l.graph)}</span>${l.hash ? `<span class="hash">${esc(l.hash)}</span>${l.refs ? l.refs.split(', ').map((r) => `<span class="ref ${r.startsWith('HEAD') ? 'head' : r.startsWith('tag:') ? 'tag' : r.includes('/') ? 'remote' : ''}">${esc(r.replace('HEAD -> ', '➜ '))}</span>`).join('') : ''}<span class="subj">${esc(l.subject)}</span><span class="auth">${esc(l.author)}</span><span class="date">${esc(l.date)}</span>` : ''}` });
        if (l.hash) row.addEventListener('click', async () => {
          const d = await call('git:show', root(), l.hash).catch((e) => e.message);
          view.innerHTML = ''; view.appendChild(h('div.toolbar', h('button.btn.ghost', { on: { click: showLog } }, '← back to log'), h('span.c-dim', l.hash + ' ' + l.subject)));
          view.appendChild(h('div.diff', { html: renderDiff(d) }));
          view.scrollTop = 0;
        });
        box.appendChild(row);
      }
      if (!log.length) box.innerHTML = '<div class="empty">no commits yet</div>';
      view.appendChild(box);
    }
    async function showBranches() {
      const list = await call('git:branches', root()).catch(() => []);
      view.innerHTML = `<table class="grid"><tr><th></th><th>BRANCH</th><th>COMMIT</th><th>UPSTREAM</th><th>UPDATED</th></tr>${list.map((b) => `<tr data-b="${esc(b.name)}" data-r="${b.remote ? 1 : ''}"><td class="c-acc">${b.current ? '●' : ''}</td><td class="${b.remote ? 'c-dim' : ''}">${esc(b.name)}</td><td class="c-amber">${esc(b.hash)}</td><td class="c-dim">${esc(b.upstream || '')}</td><td class="c-dim">${esc(b.date)}</td></tr>`).join('')}</table>`;
      view.querySelector('table').addEventListener('dblclick', (e) => { const tr = e.target.closest('tr[data-b]'); if (tr) checkout(tr.dataset.r ? tr.dataset.b.replace(/^[^/]+\//, '') : tr.dataset.b); });
    }

    const soon = debounce(refresh, 500);
    offs.push(bus.on('fs:changed', soon));
    offs.push(bus.on('git:changed', soon));
    offs.push(bus.on('project:changed', () => { selected = null; refresh(); }));
    renderTabs();
    await refresh();
    if (tab === 'diff') showDiff();
    return { serialize: () => ({ tab }), onFocus: soon, destroy: () => offs.forEach((f) => f()) };
  }
};
