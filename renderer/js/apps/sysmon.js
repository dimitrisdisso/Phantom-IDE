// System monitor: CPU, per-core, memory, swap, disk I/O, network, filesystems, top processes.
import { h, esc, bytes, rate, pct, dur } from '../core/dom.js';
import { onTelemetry, telemetry, poll } from '../core/api.js';
import { plot, bars, cssVar } from '../core/graph.js';
import { wm } from '../core/wm.js';
import { menu } from '../core/ui.js';
import { endProcess } from '../core/procctl.js';
import { platform } from '../core/api.js';

export default {
  id: 'sysmon', title: 'System Monitor', icon: 'sysmon', desc: 'Live CPU / RAM / disk / network', size: [560, 600], min: [360, 300],
  create(win, state) {
    const el = h('div.sysmon.scroll.fill');
    win.body.appendChild(el);
    const panel = (title, extra) => { const v = h('span.v'); const c = h('canvas.g'); const p = h('div.sm-panel', h('div.hdr', title, h('span.sp'), v), c, extra || null); return { p, v, c }; };
    const head = h('div.sm-head');
    const cpu = panel('CPU'); const cores = h('canvas.cores'); cpu.p.appendChild(cores);
    const memBar = h('div.bar.cyan', h('i')); const swapBar = h('div.bar.amber', h('i')); const memInfo = h('div.sm-kv');
    const mem = panel('MEMORY', h('div', memInfo, memBar, h('div.sm-lbl', 'swap'), swapBar));
    const disk = panel('DISK I/O');
    const net = panel('NETWORK');
    const fsList = h('div.sm-fs');
    const top = h('table.grid.sm-top');
    // Top processes: sortable, filterable, and each row can be ended (button, Delete key or right-click).
    let topN = state.topN || 10; let topSort = state.topSort || 'cpu'; let topFilter = ''; let selPid = null; let lastProcs = [];
    const filterInp = h('input.inp.sm-filter', { placeholder: 'filter…', spellcheck: false });
    const nSel = h('select.inp.sm-sel', [8, 10, 20, 40].map((n) => h('option', { value: n, selected: n === topN }, `top ${n}`)));
    const sortSel = h('select.inp.sm-sel', [['cpu', 'by CPU'], ['rss', 'by memory']].map(([v, l]) => h('option', { value: v, selected: v === topSort }, l)));
    const endBtn = h('button.btn.danger', { disabled: true, title: 'End the selected process (Delete)', on: { click: () => endSel('end') } }, 'END PROCESS');
    filterInp.addEventListener('input', () => { topFilter = filterInp.value.trim().toLowerCase(); renderTop(); });
    nSel.addEventListener('change', () => { topN = Number(nSel.value); renderTop(); win.save(); });
    sortSel.addEventListener('change', () => { topSort = sortSel.value; renderTop(); win.save(); });
    el.append(head, cpu.p, mem.p, h('div.sm-row', disk.p, net.p), h('div.sm-panel', h('div.hdr', 'FILESYSTEMS'), fsList),
      h('div.sm-panel', h('div.hdr', 'PROCESSES', h('span.sp'), filterInp, sortSel, nSel, endBtn, h('button.btn.ghost', { on: { click: () => wm.open('procs') } }, 'manager →')), top));

    const draw = (s, hist) => {
      if (!win.visible) return;
      const st = telemetry.static;
      head.innerHTML = st ? `<b>${esc(st.hostname)}</b> <span class="c-dim">${esc(st.distro)} · ${esc(st.kernel)} · ${esc(st.arch)}</span><span class="sp"></span><span class="c-dim">up</span> ${dur(s.uptime * 1000)} <span class="c-dim">load</span> ${s.load.map((x) => x.toFixed(2)).join(' ')}${s.temp ? ` <span class="c-dim">temp</span> <span class="${s.temp.main > 80 ? 'c-red' : 'c-amber'}">${s.temp.main.toFixed(0)}°C</span>` : ''}` : '';
      const H = hist.slice(-120);
      cpu.v.innerHTML = `<b class="c-acc">${pct(s.cpu.load, 1)}</b> <span class="c-dim">${st ? esc(st.cpuModel) + ' · ' : ''}${s.cpu.cores.length} threads${s.cpu.speed ? ' · ' + s.cpu.speed + 'MHz' : ''}</span>`;
      plot(cpu.c, [{ data: H.map((x) => x.cpu.load) }], { max: 100, points: 120 });
      bars(cores, s.cpu.cores);
      const m = s.mem;
      mem.v.innerHTML = `<b class="c-cyan">${bytes(m.used)}</b> <span class="c-dim">/ ${bytes(m.total)} (${pct((m.used / m.total) * 100)})</span>`;
      memInfo.innerHTML = `<span>available <b>${bytes(m.available)}</b></span><span>cache <b>${bytes(m.cached)}</b></span><span>swap <b>${bytes(m.swapUsed)}</b> / ${bytes(m.swapTotal)}</span>`;
      memBar.firstChild.style.width = (m.used / m.total) * 100 + '%';
      swapBar.firstChild.style.width = (m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0) + '%';
      plot(mem.c, [{ data: H.map((x) => (x.mem.used / x.mem.total) * 100), color: cssVar('--cyan') }], { max: 100, points: 120 });
      disk.v.innerHTML = `<span class="c-acc">R ${rate(s.disk.rx_sec)}</span> <span class="c-amber">W ${rate(s.disk.wx_sec)}</span>`;
      plot(disk.c, [{ data: H.map((x) => x.disk.rx_sec) }, { data: H.map((x) => x.disk.wx_sec), color: cssVar('--amber') }], { points: 120 });
      net.v.innerHTML = `<span class="c-cyan">↓ ${rate(s.net.rx_sec)}</span> <span class="c-violet">↑ ${rate(s.net.tx_sec)}</span>`;
      plot(net.c, [{ data: H.map((x) => x.net.rx_sec), color: cssVar('--cyan') }, { data: H.map((x) => x.net.tx_sec), color: cssVar('--violet') }], { points: 120 });
      fsList.innerHTML = s.fs.map((f) => `<div class="sm-fsrow"><span class="mnt" title="${esc(f.fs)}">${esc(f.mount)}</span><div class="bar ${f.use > 90 ? 'red' : f.use > 75 ? 'amber' : ''}"><i style="width:${f.use}%"></i></div><span class="c-dim">${bytes(f.used)} / ${bytes(f.size)}</span><b>${pct(f.use)}</b></div>`).join('') || '<div class="c-dim">no filesystem data</div>';
    };
    const off = onTelemetry(draw);
    let selfPid = null;
    function renderTop() {
      const q = topFilter;
      const list = lastProcs.filter((p) => !q || `${p.pid} ${p.name} ${p.user}`.toLowerCase().includes(q)).sort((a, b) => b[topSort] - a[topSort]).slice(0, topN);
      if (selPid && !lastProcs.some((p) => p.pid === selPid)) selPid = null;
      top.innerHTML = '<tr><th class="num">PID</th><th>NAME</th><th>USER</th><th class="num">CPU</th><th class="num">MEM</th><th></th></tr>' +
        list.map((p) => `<tr data-pid="${p.pid}" class="${p.pid === selPid ? 'sel' : ''}"><td class="num c-dim">${p.pid}</td><td>${esc(p.name)}${p.pid === selfPid ? ' <span class="c-mute">(phantom)</span>' : ''}</td><td class="c-dim">${esc(p.user)}</td><td class="num ${p.cpu > 50 ? 'c-red' : p.cpu > 10 ? 'c-amber' : ''}">${p.cpu.toFixed(1)}</td><td class="num">${bytes(p.rss)}</td><td class="sm-end">${p.pid === selfPid || p.pid <= 4 ? '' : '<button class="btn ghost sm-x" data-end="1" title="End process">✕</button>'}</td></tr>`).join('');
      endBtn.disabled = !selPid || selPid === selfPid;
    }
    const procById = (pid) => lastProcs.find((p) => p.pid === pid);
    async function endSel(mode, pid = selPid) {
      const p = procById(pid); if (!p) return;
      if (await endProcess(p, mode)) { if (selPid === pid) selPid = null; procPoll.now(); }
    }
    top.tabIndex = 0;
    top.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-pid]'); if (!tr) return;
      const pid = Number(tr.dataset.pid);
      if (e.target.closest('[data-end]')) { endSel('end', pid); return; }
      selPid = pid === selPid ? null : pid; renderTop(); top.focus();
    });
    top.addEventListener('keydown', (e) => { if (e.key === 'Delete' && selPid) { e.preventDefault(); endSel(e.shiftKey ? 'tree' : 'end'); } });
    top.addEventListener('contextmenu', (e) => {
      const tr = e.target.closest('tr[data-pid]'); if (!tr) return; e.preventDefault();
      selPid = Number(tr.dataset.pid); renderTop();
      const p = procById(selPid); if (!p) return;
      const self = p.pid === selfPid;
      menu(e.clientX, e.clientY, [
        { header: `${p.name} (${p.pid})` },
        { label: 'End process', key: 'Del', danger: true, disabled: self, action: () => endSel('end', p.pid) },
        { label: 'End process tree', key: '⇧Del', danger: true, disabled: self, action: () => endSel('tree', p.pid) },
        platform !== 'win32' ? { label: 'Force kill (SIGKILL)', danger: true, disabled: self, action: () => endSel('kill', p.pid) } : null,
        '-',
        { label: 'Show in process manager', action: () => wm.open('procs', { state: { filter: String(p.pid) } }) },
        { label: 'Show sockets', action: () => wm.open('net', { state: { tab: 'conns', filter: String(p.pid) } }) },
        { label: 'Copy PID', action: () => navigator.clipboard.writeText(String(p.pid)) }
      ]);
    });
    const procPoll = poll('proc:list', 2500, (r) => { lastProcs = r.procs; selfPid = r.self; renderTop(); }).when(() => win.visible);
    win.onResize(() => { const hh = telemetry.history; if (hh.length) draw(hh[hh.length - 1], hh); });
    return {
      serialize: () => ({ topN, topSort }),
      onShow: () => { const hh = telemetry.history; if (hh.length) draw(hh[hh.length - 1], hh); },
      destroy() { off(); procPoll.stop(); }
    };
  }
};
