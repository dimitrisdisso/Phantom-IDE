// Process manager: sortable/filterable table, tree view, details, signals.
import { h, esc, bytes, dur } from '../core/dom.js';
import { call, poll, platform } from '../core/api.js';
import { endProcess } from '../core/procctl.js';
import { menu, confirm, toast, fail } from '../core/ui.js';
import { wm } from '../core/wm.js';

export default {
  id: 'procs', title: 'Processes', icon: 'proc', desc: 'Running process monitor', size: [760, 520], min: [420, 220],
  create(win, state) {
    let data = null; let sortKey = state.sortKey || 'cpu'; let sortDir = state.sortDir || -1; let filter = state.filter || '';
    let selPid = null; let paused = false; let tree = !!state.tree; let mine = !!state.mine;
    const filterInp = h('input.inp', { placeholder: 'filter name / pid / user / command…', value: filter, style: { flex: 1 } });
    const pauseBtn = h('button.btn', { on: { click: () => { paused = !paused; pauseBtn.classList.toggle('on', paused); pauseBtn.textContent = paused ? 'RESUME' : 'PAUSE'; } } }, 'PAUSE');
    const treeBtn = h('button.btn' + (tree ? '.on' : ''), { on: { click: () => { tree = !tree; treeBtn.classList.toggle('on', tree); render(); win.save(); } } }, 'TREE');
    const mineBtn = h('button.btn' + (mine ? '.on' : ''), { on: { click: () => { mine = !mine; mineBtn.classList.toggle('on', mine); render(); win.save(); } } }, 'MINE');
    const killBtn = h('button.btn.danger', { disabled: true, on: { click: () => kill('SIGTERM') } }, 'TERMINATE');
    const stats = h('span.c-dim');
    const table = h('div.fill.scroll');
    const detail = h('div.pr-detail');
    win.body.append(h('div.toolbar', filterInp, treeBtn, mineBtn, pauseBtn, killBtn), table, detail, h('div.toolbar.pr-foot', stats));

    const cols = [['pid', 'PID', 'num'], ['name', 'NAME'], ['user', 'USER'], ['cpu', 'CPU%', 'num'], ['mem', 'MEM%', 'num'], ['rss', 'RSS', 'num'], ['threads', 'THR', 'num'], ['state', 'S'], ['command', 'COMMAND']];

    function rowsSorted() {
      const me = data && data.procs.find((p) => p.pid === data.self);
      const q = filter.toLowerCase();
      let list = data.procs.filter((p) => (!mine || !me || p.user === me.user) && (!q || `${p.pid} ${p.name} ${p.user} ${p.command}`.toLowerCase().includes(q)));
      const cmp = (a, b) => { const x = a[sortKey] ?? ''; const y = b[sortKey] ?? ''; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sortDir; };
      if (!tree || q) return list.sort(cmp).map((p) => [p, 0]);
      const byParent = new Map(); const pids = new Set(list.map((p) => p.pid));
      for (const p of list) { const k = pids.has(p.ppid) ? p.ppid : 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(p); }
      const out = [];
      const walk = (k, d) => { for (const p of (byParent.get(k) || []).sort(cmp)) { out.push([p, d]); if (d < 30) walk(p.pid, d + 1); } };
      walk(0, 0);
      return out;
    }

    function render() {
      if (!data) return;
      const rows = rowsSorted();
      const sc = table.scrollTop;
      table.innerHTML = `<table class="grid pr-table"><tr>${cols.map(([k, l, c]) => `<th class="sort ${c || ''} ${sortKey === k ? (sortDir > 0 ? 'asc' : 'desc') : ''}" data-k="${k}">${l}</th>`).join('')}</tr>${rows.slice(0, 1500).map(([p, d]) => `<tr data-pid="${p.pid}" class="${p.pid === selPid ? 'sel' : ''} ${p.pid === data.self ? 'self' : ''}">
        <td class="num c-dim">${p.pid}</td><td style="padding-left:${8 + d * 12}px">${d ? '<span class="c-mute">└ </span>' : ''}${esc(p.name)}</td><td class="c-dim">${esc(p.user)}</td>
        <td class="num ${p.cpu > 50 ? 'c-red' : p.cpu > 10 ? 'c-amber' : p.cpu > 0.5 ? 'c-acc' : 'c-dim'}">${p.cpu.toFixed(1)}</td><td class="num">${p.mem.toFixed(1)}</td><td class="num">${bytes(p.rss)}</td>
        <td class="num c-dim">${p.threads ?? ''}</td><td class="${/^R/.test(p.state) ? 'c-acc' : /^Z/.test(p.state) ? 'c-red' : 'c-dim'}">${esc(p.state)}</td><td class="c-dim cmd" title="${esc(p.command)}">${esc(p.command)}</td></tr>`).join('')}</table>`;
      table.scrollTop = sc;
      const cpuTotal = data.procs.reduce((a, p) => a + p.cpu, 0);
      stats.textContent = `${data.total} processes · ${data.running} running · Σcpu ${cpuTotal.toFixed(0)}% · showing ${Math.min(rows.length, 1500)}${paused ? ' · PAUSED' : ''}`;
      killBtn.disabled = !selPid;
    }

    table.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]');
      if (th) { const k = th.dataset.k; if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = ['cpu', 'mem', 'rss', 'threads'].includes(k) ? -1 : 1; } render(); win.save(); return; }
      const tr = e.target.closest('tr[data-pid]'); if (!tr) return;
      selPid = Number(tr.dataset.pid); render(); showDetail();
    });
    table.addEventListener('contextmenu', (e) => {
      const tr = e.target.closest('tr[data-pid]'); if (!tr) return; e.preventDefault();
      selPid = Number(tr.dataset.pid); render(); showDetail();
      const p = data.procs.find((x) => x.pid === selPid);
      menu(e.clientX, e.clientY, [
        { header: `${p.name} (${p.pid})` },
        { label: platform === 'win32' ? 'End process' : 'Terminate (SIGTERM)', key: 'Del', danger: true, action: () => kill('SIGTERM') },
        { label: 'End process tree', key: '⇧Del', danger: true, action: async () => { if (await endProcess(p, 'tree')) pollH.now(); } },
        ...(platform === 'win32' ? [] : [
          { label: 'Kill (SIGKILL)', danger: true, action: () => kill('SIGKILL') },
          { label: 'Interrupt (SIGINT)', action: () => kill('SIGINT') },
          { label: 'Suspend (SIGSTOP)', action: () => kill('SIGSTOP') },
          { label: 'Continue (SIGCONT)', action: () => kill('SIGCONT') },
          { label: 'Hang up (SIGHUP)', action: () => kill('SIGHUP') }]),
        '-',
        { label: 'Show sockets', action: () => wm.open('net', { state: { tab: 'conns', filter: String(p.pid) } }) },
        { label: 'Filter to children', action: () => { tree = true; treeBtn.classList.add('on'); render(); } },
        { label: 'Copy command line', action: () => navigator.clipboard.writeText(p.command) },
        { label: 'Copy PID', action: () => navigator.clipboard.writeText(String(p.pid)) }
      ]);
    });

    async function showDetail() {
      const p = data && data.procs.find((x) => x.pid === selPid);
      if (!p) { detail.innerHTML = ''; return; }
      detail.innerHTML = `<div class="kv"><span>pid / ppid</span><span>${p.pid} / ${p.ppid}</span><span>command</span><span class="sel-text">${esc(p.command)}</span></div>`;
      try {
        const d = await call('proc:details', p.pid);
        if (selPid !== p.pid) return;
        detail.innerHTML = `<div class="kv"><span>pid / ppid</span><span>${p.pid} / ${p.ppid} · ${esc(p.user)}</span>${d.exe ? `<span>exe</span><span class="sel-text">${esc(d.exe)}</span>` : ''}${d.cwd ? `<span>cwd</span><span class="sel-text">${esc(d.cwd)}</span>` : ''}${d.started ? `<span>started</span><span>${new Date(d.started).toLocaleString()} (${dur(Date.now() - d.started)} ago)</span>` : ''}${d.fds != null ? `<span>open fds</span><span>${d.fds}</span>` : ''}${d.readBytes != null && !isNaN(d.readBytes) ? `<span>io</span><span>read ${bytes(d.readBytes)} · write ${bytes(d.writeBytes)}</span>` : ''}<span>command</span><span class="sel-text">${esc(p.command)}</span></div>`;
      } catch { /* exited / permission */ }
    }

    async function kill(sig) {
      const p = data && data.procs.find((x) => x.pid === selPid); if (!p) return;
      const destructive = sig === 'SIGKILL' || sig === 'SIGTERM';
      if (destructive && !(await confirm(sig === 'SIGKILL' ? 'Kill process' : 'Terminate process', `Send ${sig} to ${p.name} (pid ${p.pid}, user ${p.user})?\n${p.command.slice(0, 200)}${sig === 'SIGKILL' ? '\n\nSIGKILL cannot be caught — unsaved work in that process will be lost.' : ''}`, { danger: true, ok: sig }))) return;
      try { await call('proc:kill', p.pid, sig); toast(`${sig} → ${p.name} (${p.pid})`); pollH.now(); } catch (e) { fail(e, 'SIGNAL'); }
    }

    table.tabIndex = 0;
    table.addEventListener('keydown', async (e) => {
      if (e.key !== 'Delete' || !selPid) return;
      e.preventDefault();
      if (e.shiftKey) { const p = data && data.procs.find((x) => x.pid === selPid); if (await endProcess(p, 'tree')) pollH.now(); } else kill('SIGTERM');
    });
    filterInp.addEventListener('input', () => { filter = filterInp.value; render(); win.save(); });
    const pollH = poll('proc:list', 2000, (d) => { if (paused) return; data = d; render(); }).when(() => win.visible).onError((e) => { stats.textContent = e.message; });
    return { serialize: () => ({ sortKey, sortDir, filter, tree, mine }), destroy: () => pollH.stop() };
  }
};
