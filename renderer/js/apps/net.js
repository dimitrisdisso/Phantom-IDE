// Network monitor: per-interface throughput, live sockets, listening ports, interfaces.
import { h, esc, rate, bytes } from '../core/dom.js';
import { call, poll, onTelemetry, telemetry } from '../core/api.js';
import { plot, cssVar } from '../core/graph.js';
import { menu, confirm, toast, fail } from '../core/ui.js';
import { wm } from '../core/wm.js';

export default {
  id: 'net', title: 'Network', icon: 'net', desc: 'Traffic, sockets, listening ports', size: [720, 520], min: [380, 240],
  create(win, state) {
    let tab = state.tab || 'traffic';
    let conns = []; let filter = state.filter || ''; let sortKey = 'state'; let sortDir = 1;
    const tabs = h('div.tabs');
    const tabDefs = [['traffic', 'TRAFFIC'], ['conns', 'CONNECTIONS'], ['listen', 'LISTENING'], ['ifaces', 'INTERFACES']];
    const body = h('div.fill.scroll');
    const filterInp = h('input.inp', { placeholder: 'filter by address, port, process, state…', value: filter, style: { flex: 1 } });
    const summary = h('span.c-dim');
    const tb = h('div.toolbar', filterInp, summary);
    win.body.append(tabs, tb, body);

    const renderTabs = () => {
      tabs.innerHTML = '';
      for (const [k, l] of tabDefs) {
        const n = k === 'conns' ? conns.length : k === 'listen' ? conns.filter((c) => c.state === 'LISTEN').length : null;
        tabs.appendChild(h('button.tab' + (tab === k ? '.on' : ''), { on: { click: () => { tab = k; renderTabs(); render(); win.save(); } }, html: `${l}${n !== null ? ` <span class="cnt">${n}</span>` : ''}` }));
      }
      tb.style.display = tab === 'conns' || tab === 'listen' ? '' : 'none';
    };

    const ifaceCanvases = new Map();
    function renderTraffic() {
      const hist = telemetry.history.slice(-120); const s = hist[hist.length - 1];
      if (!s) { body.innerHTML = '<div class="empty">collecting…</div>'; return; }
      if (!body.querySelector('.nt-traffic')) { body.innerHTML = ''; body.appendChild(h('div.nt-traffic')); ifaceCanvases.clear(); }
      const wrap = body.querySelector('.nt-traffic');
      const ifaces = s.net.ifaces.filter((i) => i.rx_bytes > 0 || i.tx_bytes > 0);
      for (const i of ifaces) {
        let c = ifaceCanvases.get(i.iface);
        if (!c) {
          const cv = h('canvas.g'); const lbl = h('div.hdr');
          wrap.appendChild(h('div.sm-panel', lbl, cv));
          c = { cv, lbl }; ifaceCanvases.set(i.iface, c);
        }
        c.lbl.innerHTML = `${esc(i.iface)}<span class="sp"></span><span class="c-cyan">↓ ${rate(i.rx_sec)}</span>&nbsp;&nbsp;<span class="c-violet">↑ ${rate(i.tx_sec)}</span>&nbsp;&nbsp;<span class="c-dim">total ↓${bytes(i.rx_bytes)} ↑${bytes(i.tx_bytes)}</span>`;
        const series = (k) => hist.map((x) => ((x.net.ifaces.find((y) => y.iface === i.iface) || {})[k]) || 0);
        plot(c.cv, [{ data: series('rx_sec'), color: cssVar('--cyan') }, { data: series('tx_sec'), color: cssVar('--violet') }], { points: 120 });
      }
    }

    const match = (c) => !filter || `${c.proto} ${c.local}:${c.lport} ${c.remote}:${c.rport} ${c.state} ${c.process || ''} ${c.pid || ''}`.toLowerCase().includes(filter.toLowerCase());
    function renderConns(listenOnly) {
      let rows = conns.filter((c) => (listenOnly ? c.state === 'LISTEN' : true) && match(c));
      rows.sort((a, b) => { const x = a[sortKey] ?? ''; const y = b[sortKey] ?? ''; return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sortDir; });
      const cols = listenOnly ? [['proto', 'PROTO'], ['local', 'ADDRESS'], ['lport', 'PORT'], ['process', 'PROCESS'], ['pid', 'PID']] : [['proto', 'PROTO'], ['local', 'LOCAL'], ['lport', 'LPORT'], ['remote', 'REMOTE'], ['rport', 'RPORT'], ['state', 'STATE'], ['process', 'PROCESS'], ['pid', 'PID']];
      const stCls = (s) => s === 'ESTABLISHED' ? 'c-acc' : s === 'LISTEN' ? 'c-cyan' : /WAIT|CLOS/.test(s) ? 'c-amber' : 'c-dim';
      const t = h('table.grid', { html:
        `<tr>${cols.map(([k, l]) => `<th class="sort ${['lport', 'rport', 'pid'].includes(k) ? 'num' : ''} ${sortKey === k ? (sortDir > 0 ? 'asc' : 'desc') : ''}" data-k="${k}">${l}</th>`).join('')}</tr>` +
        rows.slice(0, 2000).map((c, i) => `<tr data-i="${conns.indexOf(c)}">${cols.map(([k]) => {
          const v = c[k];
          if (k === 'state') return `<td class="${stCls(v)}">${esc(v)}</td>`;
          if (k === 'lport' || k === 'rport' || k === 'pid') return `<td class="num">${v || (k === 'pid' ? '<span class="c-mute">—</span>' : v)}</td>`;
          if (k === 'process') return `<td>${v ? esc(v) : '<span class="c-dim">?</span>'}</td>`;
          if (k === 'proto') return `<td class="c-dim">${esc(v)}</td>`;
          return `<td>${esc(v)}</td>`;
        }).join('')}</tr>`).join('') });
      t.addEventListener('click', (e) => { const th = e.target.closest('th[data-k]'); if (th) { const k = th.dataset.k; if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; } render(); } });
      t.addEventListener('contextmenu', (e) => {
        const tr = e.target.closest('tr[data-i]'); if (!tr) return; e.preventDefault();
        const c = conns[Number(tr.dataset.i)];
        const local = ['0.0.0.0', '127.0.0.1', '::', '::1', '*'].includes(c.local) || c.local.startsWith('127.');
        menu(e.clientX, e.clientY, [
          { header: `${c.proto} ${c.local}:${c.lport}` },
          c.state === 'LISTEN' && c.proto.startsWith('tcp') && local ? { label: `Open http://localhost:${c.lport} in API tester`, action: () => wm.open('api', { state: { req: { method: 'GET', url: `http://localhost:${c.lport}/` } } }) } : null,
          c.state === 'LISTEN' && c.proto.startsWith('tcp') && local ? { label: 'Probe port', action: async () => { try { const r = await call('net:probe', c.lport); toast(`${c.lport}: ${r.open ? 'open' : 'closed'} (${r.ms}ms)`); } catch (er) { fail(er); } } } : null,
          c.pid ? { label: `Show process ${c.pid}`, action: () => wm.open('procs', { state: { filter: String(c.pid) } }) } : null,
          c.pid ? { label: `Terminate ${c.process || c.pid}`, danger: true, action: async () => { if (await confirm('Terminate process', `Send SIGTERM to ${c.process} (pid ${c.pid})?`, { danger: true, ok: 'SIGTERM' })) call('proc:kill', c.pid, 'SIGTERM').then(() => toast('signal sent')).catch(fail); } } : null,
          { label: 'Copy local address', action: () => navigator.clipboard.writeText(`${c.local}:${c.lport}`) },
          !listenOnly ? { label: 'Copy remote address', action: () => navigator.clipboard.writeText(`${c.remote}:${c.rport}`) } : null
        ]);
      });
      const sc = body.scrollTop; body.innerHTML = ''; body.appendChild(t); body.scrollTop = sc;
      const est = conns.filter((c) => c.state === 'ESTABLISHED').length;
      summary.textContent = `${rows.length} shown · ${est} established · ${conns.filter((c) => c.state === 'LISTEN').length} listening`;
    }

    async function renderIfaces() {
      const list = await call('net:interfaces');
      body.innerHTML = `<table class="grid"><tr><th>IFACE</th><th>FAMILY</th><th>ADDRESS</th><th>CIDR</th><th>MAC</th><th></th></tr>${list.map((i) => `<tr><td>${esc(i.iface)}</td><td class="c-dim">${esc(i.family)}</td><td class="c-acc sel-text">${esc(i.address)}</td><td class="c-dim">${esc(i.cidr || '')}</td><td class="c-dim">${esc(i.mac)}</td><td>${i.internal ? '<span class="pill c-dim">loopback</span>' : ''}</td></tr>`).join('')}</table>`;
    }

    function render() {
      if (tab === 'traffic') renderTraffic();
      else if (tab === 'conns') renderConns(false);
      else if (tab === 'listen') renderConns(true);
      else renderIfaces();
    }
    filterInp.addEventListener('input', () => { filter = filterInp.value; render(); win.save(); });

    const p = poll('net:connections', 3000, (c) => { conns = c; renderTabs(); if (tab === 'conns' || tab === 'listen') render(); }).when(() => win.visible).onError((e) => { summary.textContent = e.message; });
    const off = onTelemetry(() => { if (win.visible && tab === 'traffic') renderTraffic(); });
    win.onResize(() => { if (tab === 'traffic') renderTraffic(); });
    renderTabs(); render();
    return { serialize: () => ({ tab, filter }), destroy() { p.stop(); off(); }, onShow: render };
  }
};
