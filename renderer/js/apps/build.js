// Build monitor: detected tasks (npm/make/cargo/go/python/docker), live runs, output, error counts, history.
import { h, esc, ansiToHtml, dur, time } from '../core/dom.js';
import { call, on, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { prompt, fail } from '../core/ui.js';

export default {
  id: 'build', title: 'Build Monitor', icon: 'build', desc: 'Run tasks & monitor builds', size: [760, 520], min: [420, 260],
  async create(win, state) {
    let tasks = []; const runs = []; let sel = null; const offs = [];
    const list = h('div.bld-tasks.scroll');
    const runsEl = h('div.bld-runs');
    const out = h('pre.bld-out.fill.scroll.sel-text');
    const head = h('div.toolbar.bld-head');
    list.style.flex = '0 0 230px';
    win.body.appendChild(h('div.split-h.fill', list, h('div.gutter-x'), h('div.split-v.fill', runsEl, head, out)));

    async function detect() {
      list.innerHTML = '';
      if (!project.root) { list.appendChild(h('div.empty', 'open a project')); return; }
      tasks = await call('tasks:detect', project.root).catch(() => []);
      const groups = {};
      for (const t of tasks) (groups[t.group] = groups[t.group] || []).push(t);
      list.appendChild(h('div.toolbar', h('button.btn', { on: { click: custom } }, '+ CUSTOM'), h('span.sp'), h('button.btn.ghost', { on: { click: detect } }, '⟳')));
      for (const t of state.custom || []) (groups.custom = groups.custom || []).push(t);
      for (const [g, ts] of Object.entries(groups)) {
        list.appendChild(h('div.hdr', g));
        for (const t of ts) {
          const row = h('div.bld-task', { title: t.detail || t.command, html: `<span class="k k-${esc(t.kind || 'run')}">${esc((t.kind || 'run').slice(0, 1).toUpperCase())}</span><span class="nm">${esc(t.name)}</span>` });
          row.appendChild(h('button.btn.ghost.icon', { title: 'Run', html: '▶', on: { click: (e) => { e.stopPropagation(); runTask(t); } } }));
          row.addEventListener('dblclick', () => runTask(t));
          list.appendChild(row);
        }
      }
      if (!tasks.length && !(state.custom || []).length) list.appendChild(h('div.c-mute', { style: { padding: '8px' } }, 'no tasks detected (package.json scripts, Makefile, Cargo, go.mod, pyproject, Dockerfile)'));
    }
    async function custom() {
      const c = await prompt('Custom task', '', { placeholder: 'e.g. npm run build -- --watch' });
      if (!c) return;
      state.custom = [...(state.custom || []), { group: 'custom', name: c, command: c, kind: 'run' }];
      win.save(); detect();
    }
    async function runTask(t) {
      try {
        const r = await call('tasks:run', { root: project.root, command: t.command, label: t.name });
        const run = { ...r, task: t, out: '', status: 'running', errors: 0, warnings: 0 };
        runs.unshift(run); if (runs.length > 30) runs.pop();
        sel = run; bus.emit('tasks:started'); renderRuns(); renderOut(true);
      } catch (e) { fail(e); }
    }
    function renderRuns() {
      runsEl.innerHTML = '';
      for (const r of runs.slice(0, 12)) {
        const c = r.status === 'running' ? 'run' : r.code === 0 ? 'ok' : 'bad';
        const chip = h('button.bld-chip.' + c + (r === sel ? '.sel' : ''), { html: `${c === 'run' ? '<span class="spin"></span>' : c === 'ok' ? '✓' : '✗'} ${esc(r.task.name)} <span class="c-dim">${r.ms != null ? dur(r.ms) : dur(Date.now() - r.started)}</span>${r.errors ? ` <span class="c-red">${r.errors}E</span>` : ''}${r.warnings ? ` <span class="c-amber">${r.warnings}W</span>` : ''}` });
        chip.addEventListener('click', () => { sel = r; renderRuns(); renderOut(true); });
        runsEl.appendChild(chip);
      }
      const running = runs.filter((r) => r.status === 'running').length;
      win.setBadge(running ? `${running} running` : '');
    }
    function renderOut(full) {
      head.innerHTML = '';
      if (!sel) { out.innerHTML = '<span class="c-mute">double-click a task to run it. Output, timing, errors and warnings stream here.</span>'; return; }
      head.append(h('b', sel.task.name), h('span.c-dim', sel.task.command), h('span.sp'), h('span.c-dim', `started ${time(sel.started).slice(0, 8)}`));
      if (sel.status === 'running') head.appendChild(h('button.btn.danger', { on: { click: () => call('tasks:kill', sel.runId) } }, '■ STOP'));
      else head.appendChild(h('button.btn', { on: { click: () => runTask(sel.task) } }, '↻ RERUN'));
      if (full) { out.innerHTML = ansiToHtml(sel.out.slice(-400000)); out.scrollTop = out.scrollHeight; }
    }
    offs.push(on('tasks:output', (p) => {
      const r = runs.find((x) => x.runId === p.runId); if (!r) return;
      r.out += p.data;
      for (const l of p.data.split('\n')) { if (/\b(error|ERR!|failed|fatal)\b/i.test(l) && !/\b0 errors?\b/i.test(l)) r.errors++; else if (/\bwarn(ing)?\b/i.test(l) && !/\b0 warnings?\b/i.test(l)) r.warnings++; }
      if (r === sel) { const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 30; out.insertAdjacentHTML('beforeend', ansiToHtml(p.data)); if (atBottom) out.scrollTop = out.scrollHeight; }
    }));
    offs.push(on('tasks:exit', (p) => {
      const r = runs.find((x) => x.runId === p.runId); if (!r) return;
      r.status = 'done'; r.code = p.code; r.ms = p.ms;
      r.out += `\n\x1b[${p.code === 0 ? '32' : '31'}m── exited ${p.signal || p.code} in ${dur(p.ms)} ──\x1b[0m\n`;
      renderRuns(); if (r === sel) renderOut(true);
    }));
    const tick = setInterval(() => { if (runs.some((r) => r.status === 'running') && win.visible) renderRuns(); }, 1000);
    offs.push(() => clearInterval(tick));
    offs.push(bus.on('project:changed', detect));
    renderOut(); await detect();
    return { serialize: () => ({ custom: state.custom || [] }), destroy: () => offs.forEach((f) => f()) };
  }
};
