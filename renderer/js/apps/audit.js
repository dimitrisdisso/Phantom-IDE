// Security audit: dependency vulnerabilities, committed secrets, risky configuration, with a score.
import { h, esc, rel, dur } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { fail } from '../core/ui.js';

const W = { critical: 25, high: 10, moderate: 4, medium: 4, low: 1, info: 0 };

export default {
  id: 'audit', title: 'Security Audit', icon: 'audit', desc: 'Vulnerabilities, secrets, config risks', size: [820, 600], min: [440, 300],
  async create(win, state) {
    let tab = state.tab || 'summary'; let data = state.last || null; let running = false;
    const runBtn = h('button.btn.primary', { on: { click: runAll } }, '▶ RUN FULL AUDIT');
    const tabs = h('div.tabs');
    const body = h('div.fill.scroll.aud-body');
    const meta = h('span.c-dim');
    win.body.append(h('div.toolbar', runBtn, meta), tabs, body);

    function counts(list) { const c = { critical: 0, high: 0, medium: 0, low: 0 }; for (const f of list) { const s = f.severity === 'moderate' ? 'medium' : f.severity; if (c[s] !== undefined) c[s]++; } return c; }
    function all() { if (!data) return []; return [...(data.deps || []).flatMap((d) => d.findings), ...(data.secrets ? data.secrets.findings : []), ...(data.config || [])]; }
    function score() { const pts = all().reduce((a, f) => a + (W[f.severity] || 0), 0); const s = Math.max(0, 100 - pts); return { s, grade: s >= 95 ? 'A' : s >= 85 ? 'B' : s >= 70 ? 'C' : s >= 50 ? 'D' : 'F' }; }

    async function runAll() {
      if (!project.root || running) return;
      running = true; runBtn.disabled = true; const t0 = Date.now();
      data = { root: project.root, ts: Date.now() };
      body.innerHTML = '<div class="empty"><div><span class="spin"></span><br><br>scanning dependencies, secrets and configuration…</div></div>';
      const [deps, secrets, config] = await Promise.all([
        call('audit:deps', project.root).catch((e) => [{ tool: 'deps', error: e.message, findings: [] }]),
        call('audit:secrets', project.root).catch((e) => ({ scanned: 0, findings: [], error: e.message })),
        call('audit:config', project.root).catch(() => [])
      ]);
      Object.assign(data, { deps, secrets, config, ms: Date.now() - t0 });
      running = false; runBtn.disabled = false;
      render(); win.save();
      const c = counts(all()); win.setBadge(c.critical + c.high ? `${c.critical + c.high}!` : '✓');
    }

    function renderTabs() {
      tabs.innerHTML = '';
      const n = data ? { deps: (data.deps || []).reduce((a, d) => a + d.findings.length, 0), secrets: data.secrets ? data.secrets.findings.length : 0, config: (data.config || []).length } : {};
      for (const [k, l] of [['summary', 'SUMMARY'], ['deps', 'DEPENDENCIES'], ['secrets', 'SECRETS'], ['config', 'CONFIGURATION']]) tabs.appendChild(h('button.tab' + (tab === k ? '.on' : ''), { html: `${l}${n[k] ? ` <span class="cnt">${n[k]}</span>` : ''}`, on: { click: () => { tab = k; render(); win.save(); } } }));
    }
    const sev = (s) => `<span class="pill sev-${esc(s)}">${esc(s)}</span>`;
    function render() {
      renderTabs();
      if (!data || !data.deps) { body.innerHTML = `<div class="empty"><div><b>NO AUDIT YET</b>${project.root ? esc(project.root) : 'open a project'}<br><br>Runs npm/pnpm audit, pip-audit, cargo audit and govulncheck when available,<br>scans for committed secrets and checks risky configuration — all locally.</div></div>`; meta.textContent = ''; return; }
      meta.textContent = `${rel(project.home, data.root)} · ${new Date(data.ts).toLocaleString()} · ${dur(data.ms || 0)}`;
      if (tab === 'summary') {
        const sc = score(); const c = counts(all());
        const col = { A: 'c-acc', B: 'c-acc', C: 'c-amber', D: 'c-amber', F: 'c-red' }[sc.grade];
        body.innerHTML = `<div class="aud-sum"><div class="aud-grade ${col}">${sc.grade}<small>${sc.s}/100</small></div><div class="aud-counts">
          <div><b class="sev-critical">${c.critical}</b>critical</div><div><b class="sev-high">${c.high}</b>high</div><div><b class="sev-medium">${c.medium}</b>medium</div><div><b class="sev-low">${c.low}</b>low</div></div></div>
          <div class="hdr">SCANNERS</div>
          ${(data.deps || []).map((d) => `<div class="aud-tool"><b>${esc(d.tool)}</b> ${d.error ? `<span class="c-amber">${esc(d.error)}</span>` : `<span class="c-acc">${d.findings.length} finding(s)</span>`}</div>`).join('') || '<div class="aud-tool c-dim">no package manifests detected</div>'}
          <div class="aud-tool"><b>secret scan</b> <span class="${data.secrets.findings.length ? 'c-red' : 'c-acc'}">${data.secrets.findings.length} finding(s)</span> <span class="c-dim">in ${data.secrets.scanned} files</span></div>
          <div class="aud-tool"><b>configuration</b> <span class="${data.config.length ? 'c-amber' : 'c-acc'}">${data.config.length} finding(s)</span></div>
          <div class="hdr">TOP ISSUES</div>
          ${all().sort((a, b) => (W[b.severity] || 0) - (W[a.severity] || 0)).slice(0, 10).map((f) => `<div class="aud-row">${sev(f.severity)} <span>${esc(f.title || f.rule)}</span> <span class="c-dim">${esc(f.package || (f.file ? rel(project.root, f.file) + (f.line ? ':' + f.line : '') : ''))}</span></div>`).join('') || '<div class="c-acc" style="padding:6px 10px">nothing found ✓</div>'}`;
      } else if (tab === 'deps') {
        body.innerHTML = (data.deps || []).map((d) => `<div class="hdr">${esc(d.tool)}${d.error ? ` — <span class="c-amber">${esc(d.error)}</span>` : ''}</div>${d.findings.length ? `<table class="grid"><tr><th>SEVERITY</th><th>PACKAGE</th><th>ADVISORY</th><th>RANGE</th><th>FIX</th></tr>${d.findings.map((f) => `<tr><td>${sev(f.severity)}</td><td>${esc(f.package)}${f.direct ? ' <span class="c-dim">direct</span>' : ''}</td><td title="${esc(f.title)}">${f.url ? `<a href="#" data-url="${esc(f.url)}">${esc(f.title)}</a>` : esc(f.title)}</td><td class="c-dim">${esc(f.range || '')}</td><td class="c-acc">${esc(f.fix || '—')}</td></tr>`).join('')}</table>` : ''}`).join('') || '<div class="empty">no supported manifests</div>';
      } else if (tab === 'secrets') {
        const f = data.secrets.findings;
        body.innerHTML = f.length ? `<table class="grid"><tr><th>SEVERITY</th><th>RULE</th><th>LOCATION</th><th>PREVIEW (masked)</th></tr>${f.map((x) => `<tr class="aud-open" data-f="${esc(x.file)}" data-l="${x.line}"><td>${sev(x.severity)}</td><td>${esc(x.rule)}</td><td class="c-cyan">${esc(rel(project.root, x.file))}:${x.line}</td><td class="c-dim">${esc(x.preview)}</td></tr>`).join('')}</table><div class="c-dim" style="padding:8px">If a real credential was committed, rotate it — deleting the line does not remove it from git history.</div>` : '<div class="empty"><div><b class="c-acc">NO SECRETS FOUND</b>' + data.secrets.scanned + ' files scanned</div></div>';
      } else {
        const f = data.config;
        body.innerHTML = f.length ? f.map((x) => `<div class="aud-row ${x.file ? 'aud-open' : ''}" data-f="${esc(x.file || '')}">${sev(x.severity)} <b>${esc(x.title)}</b><div class="c-dim">${esc(x.detail)}</div></div>`).join('') : '<div class="empty"><div><b class="c-acc">NO CONFIGURATION RISKS</b></div></div>';
      }
    }
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); call('app:openExternal', a.dataset.url).catch(fail); return; }
      const o = e.target.closest('.aud-open'); if (o && o.dataset.f) bus.emit('open-file', o.dataset.f, { line: Number(o.dataset.l) || undefined });
    });
    const off = bus.on('project:changed', () => { data = null; render(); });
    render();
    return { serialize: () => ({ tab, last: data && data.root === project.root ? data : null }), destroy: off };
  }
};
