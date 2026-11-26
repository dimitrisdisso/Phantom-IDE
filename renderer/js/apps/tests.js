// Test runner: detects the framework, runs the suite, parses results, tracks history.
import { h, esc, ansiToHtml, dur, time } from '../core/dom.js';
import { call, on, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { fail } from '../core/ui.js';

/** Parse common runner summaries into {passed, failed, skipped, total}. */
export function parseResults(text) {
  const r = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [] };
  const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : 0; };
  let m;
  if ((m = /Tests:\s+(.*?)\s*(\d+) total/i.exec(text))) { // jest
    r.passed = num(/Tests:.*?(\d+) passed/i); r.failed = num(/Tests:.*?(\d+) failed/i); r.skipped = num(/Tests:.*?(\d+) (?:skipped|todo)/i); r.total = Number(m[2]);
  } else if (/Test Files .*\n?\s*Tests\s+/i.test(text)) { // vitest
    const line = (/^\s*Tests\s+(.*)$/im.exec(text) || [])[1] || '';
    r.passed = Number((/(\d+) passed/.exec(line) || [])[1] || 0);
    r.failed = Number((/(\d+) failed/.exec(line) || [])[1] || 0); r.skipped = Number((/(\d+) skipped/.exec(line) || [])[1] || 0);
    r.total = Number((/\((\d+)\)/.exec(line) || [])[1] || r.passed + r.failed + r.skipped);
  } else if (/\d+ passing/.test(text)) { // mocha
    r.passed = num(/(\d+) passing/); r.failed = num(/(\d+) failing/); r.skipped = num(/(\d+) pending/); r.total = r.passed + r.failed + r.skipped;
  } else if ((m = /=+ (.*?) in [\d.]+s/.exec(text)) && /(passed|failed|error)/.test(m[1])) { // pytest
    r.passed = Number((/(\d+) passed/.exec(m[1]) || [])[1] || 0); r.failed = Number((/(\d+) failed/.exec(m[1]) || [])[1] || 0) + Number((/(\d+) error/.exec(m[1]) || [])[1] || 0);
    r.skipped = Number((/(\d+) skipped/.exec(m[1]) || [])[1] || 0); r.total = r.passed + r.failed + r.skipped;
  } else if (/test result: /.test(text)) { // cargo (sum across crates)
    for (const x of text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) { r.passed += +x[1]; r.failed += +x[2]; r.skipped += +x[3]; }
    r.total = r.passed + r.failed + r.skipped;
  } else if (/^(ok|FAIL|---)\s/m.test(text)) { // go
    r.passed = (text.match(/^--- PASS/gm) || []).length || (text.match(/^ok\s/gm) || []).length; r.failed = (text.match(/^--- FAIL/gm) || []).length || (text.match(/^FAIL\s/gm) || []).length; r.skipped = (text.match(/^--- SKIP/gm) || []).length; r.total = r.passed + r.failed + r.skipped;
  } else if ((m = /# pass (\d+)/.exec(text))) { // node:test / TAP
    r.passed = Number(m[1]); r.failed = num(/# fail (\d+)/); r.skipped = num(/# skip (\d+)/) + num(/# todo (\d+)/); r.total = num(/# tests (\d+)/) || r.passed + r.failed;
  } else if ((m = /Ran (\d+) tests? in/.exec(text))) { // unittest
    r.total = Number(m[1]); r.failed = num(/failures=(\d+)/) + num(/errors=(\d+)/); r.skipped = num(/skipped=(\d+)/); r.passed = r.total - r.failed - r.skipped;
  }
  for (const line of text.split('\n')) {
    const l = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^\s*(✕|×|✗|✖|FAIL\b|--- FAIL|not ok \d|FAILED |●\s)/.test(l) && r.failures.length < 100) r.failures.push(l.trim());
  }
  return r;
}

export default {
  id: 'tests', title: 'Test Runner', icon: 'tests', desc: 'Run & monitor test suites', size: [640, 520], min: [360, 260],
  async create(win, state) {
    let run = null; let output = ''; let history = state.history || []; const offs = [];
    const cmd = h('input.inp', { value: state.command || '', placeholder: 'test command (auto-detected)', style: { flex: 1 }, spellcheck: false });
    const fw = h('span.pill.c-cyan', '—');
    const runBtn = h('button.btn.primary', { on: { click: () => (run ? stop() : start()) } }, '▶ RUN');
    const watch = h('input', { type: 'checkbox', checked: !!state.watch });
    const counters = h('div.tst-counters');
    const bar = h('div.tst-bar', h('i.p'), h('i.f'), h('i.s'));
    const failures = h('div.tst-fail.scroll');
    const out = h('pre.tst-out.fill.scroll.sel-text');
    const hist = h('div.tst-hist');
    win.body.append(h('div.toolbar', fw, cmd, h('label.chk', { title: 'Re-run when project files change' }, watch, 'watch'), runBtn), counters, bar, hist, failures, out);

    async function detect() {
      if (!project.root) return;
      try { const d = await call('tasks:detectTests', project.root); fw.textContent = d.framework || 'none'; if (!cmd.value) cmd.value = d.command; } catch { /* ignore */ }
    }
    function renderCounts(r, running) {
      const t = r.total || r.passed + r.failed + r.skipped;
      counters.innerHTML = `<div><b class="c-acc">${r.passed}</b><span>passed</span></div><div><b class="${r.failed ? 'c-red' : 'c-dim'}">${r.failed}</b><span>failed</span></div><div><b class="c-amber">${r.skipped}</b><span>skipped</span></div><div><b>${t}</b><span>total</span></div><div><b class="c-dim">${running ? '<span class="spin"></span>' : run === null && history[0] ? dur(history[0].ms) : '—'}</b><span>${running ? 'running' : 'duration'}</span></div>`;
      const [p, f, s] = bar.children;
      p.style.width = t ? (r.passed / t) * 100 + '%' : '0'; f.style.width = t ? (r.failed / t) * 100 + '%' : '0'; s.style.width = t ? (r.skipped / t) * 100 + '%' : '0';
      bar.classList.toggle('running', !!running);
      failures.innerHTML = r.failures.length ? `<div class="hdr c-red">FAILURES</div>${r.failures.map((f) => `<div class="c-red">${esc(f)}</div>`).join('')}` : '';
    }
    function renderHist() {
      hist.innerHTML = history.slice(0, 24).map((x) => `<span class="${x.code === 0 ? 'ok' : 'bad'}" title="${esc(time(x.ts))} · ${x.passed}/${x.total} · ${dur(x.ms)}"></span>`).join('');
    }
    async function start() {
      if (!project.root) return;
      output = ''; out.innerHTML = '';
      renderCounts({ passed: 0, failed: 0, skipped: 0, total: 0, failures: [] }, true);
      runBtn.textContent = '■ STOP'; runBtn.classList.replace('primary', 'danger');
      try {
        run = await call('tasks:run', { root: project.root, command: cmd.value, label: 'tests', env: { CI: '1' } });
        bus.emit('tasks:started'); win.setBadge('…');
      } catch (e) { fail(e); finish(-1, 0); }
    }
    function stop() { if (run) call('tasks:kill', run.runId); }
    function finish(code, ms) {
      const r = parseResults(output);
      if (!r.total && code !== 0) r.failed = r.failed || 1;
      history.unshift({ ts: Date.now(), code, ms, passed: r.passed, total: r.total });
      history = history.slice(0, 50);
      run = null; runBtn.textContent = '▶ RUN'; runBtn.classList.replace('danger', 'primary');
      renderCounts(r, false); renderHist();
      win.setBadge(code === 0 ? '✓' : `✗ ${r.failed || ''}`);
      win.save();
    }
    let rt = 0;
    offs.push(on('tasks:output', (p) => {
      if (!run || p.runId !== run.runId) return;
      output += p.data;
      if (output.length > 2e6) output = output.slice(-1.5e6);
      out.insertAdjacentHTML('beforeend', ansiToHtml(p.data));
      if (out.childNodes.length > 4000) out.innerHTML = ansiToHtml(output.slice(-300000));
      out.scrollTop = out.scrollHeight;
      clearTimeout(rt); rt = setTimeout(() => renderCounts(parseResults(output), true), 200);
    }));
    offs.push(on('tasks:exit', (p) => { if (run && p.runId === run.runId) finish(p.code, p.ms); }));
    let wt = 0;
    offs.push(bus.on('fs:changed', (paths) => {
      if (!watch.checked || run || !paths.some((x) => !/[\\/](\.git|node_modules|coverage|dist)[\\/]/.test(x))) return;
      clearTimeout(wt); wt = setTimeout(start, 600);
    }));
    offs.push(bus.on('project:changed', () => { cmd.value = ''; detect(); }));
    cmd.addEventListener('change', () => win.save()); watch.addEventListener('change', () => win.save());
    renderCounts({ passed: 0, failed: 0, skipped: 0, total: 0, failures: [] }, false); renderHist();
    await detect();
    win.setSub(project.name || '');
    return { serialize: () => ({ command: cmd.value, watch: watch.checked, history }), destroy() { offs.forEach((f) => f()); stop(); } };
  }
};
