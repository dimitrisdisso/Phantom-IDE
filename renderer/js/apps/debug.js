// Debugger (Node.js / Chrome DevTools Protocol): breakpoints, stepping, call stack, scopes, eval console.
import { h, icon, esc, basename, rel } from '../core/dom.js';
import { call, on, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { breakpoints, toggleBreakpoint, clearBreakpoints, setDebugLoc, docs } from '../core/docs.js';
import { prompt, fail, toast } from '../core/ui.js';
import { wm } from '../core/wm.js';

export default {
  id: 'debug', title: 'Debugger', icon: 'debug', desc: 'Node.js debugger', size: [560, 640], min: [360, 300],
  async create(win, state) {
    let session = null; let paused = null; let frameIdx = 0; const offs = [];
    const program = h('input.inp', { value: state.program || '', placeholder: 'program to debug (.js / .mjs)', style: { flex: 1 }, spellcheck: false });
    const args = h('input.inp', { value: state.args || '', placeholder: 'args', style: { width: '120px' }, spellcheck: false });
    const stopEntry = h('input', { type: 'checkbox', checked: !!state.stopOnEntry });
    const B = (name, title, fn) => h('button.btn.icon', { title, html: icon(name), on: { click: fn } });
    const startBtn = h('button.btn.primary', { on: { click: () => (session ? (paused ? act('resume') : null) : start()) }, html: icon('play') + 'START' });
    const ctl = {
      pause: B('pause', 'Pause', () => act('pause')),
      over: B('stepover', 'Step over (F10)', () => act('stepOver')),
      into: B('stepinto', 'Step into (F11)', () => act('stepInto')),
      out: B('stepout', 'Step out (Shift+F11)', () => act('stepOut')),
      stop: h('button.btn.icon.danger', { title: 'Stop', html: icon('stop'), on: { click: () => session && call('debug:stop', session.id) } })
    };
    const status = h('span.dbg-status');
    const stack = h('div.dbg-stack'); const vars = h('div.dbg-vars'); const bpList = h('div.dbg-bps');
    const out = h('div.dbg-out.sel-text'); const evalInp = h('input.inp', { placeholder: '› evaluate expression in selected frame', spellcheck: false });
    const pane = (title, el, extra) => h('div.dbg-pane', h('div.hdr', title, h('span.sp'), extra || null), el);
    win.body.append(
      h('div.toolbar', program, h('button.btn.ghost', { title: 'Use active editor file', on: { click: useActive } }, '⌖'), args),
      h('div.toolbar', startBtn, ctl.pause, ctl.over, ctl.into, ctl.out, ctl.stop, h('label.chk', stopEntry, 'stop on entry'), h('span.sp'), status),
      h('div.dbg-panes.fill.scroll', pane('CALL STACK', stack), pane('VARIABLES', vars), pane('BREAKPOINTS', bpList, h('button.btn.ghost', { on: { click: clearBreakpoints } }, 'clear all')), pane('CONSOLE', out, null)),
      h('div.toolbar', evalInp)
    );

    function useActive() {
      const ed = wm.recent('editor');
      const s = ed && ed.instance && ed.instance.serialize && ed.instance.serialize();
      const f = s && s.groups && s.groups[0] && s.groups[0].active;
      if (f) { program.value = f; win.save(); } else toast('no active editor file', 'warn');
    }
    function setUi() {
      const live = !!session;
      startBtn.innerHTML = icon('play') + (live ? (paused ? 'CONTINUE' : 'RUNNING') : 'START');
      startBtn.disabled = live && !paused;
      ctl.pause.disabled = !live || !!paused;
      ctl.over.disabled = ctl.into.disabled = ctl.out.disabled = !paused;
      ctl.stop.disabled = !live;
      status.innerHTML = !live ? '<span class="c-dim">idle</span>' : paused ? `<span class="c-amber">● paused</span> <span class="c-dim">${esc(paused.hit && paused.hit.length ? 'breakpoint' : paused.reason === 'other' ? 'step' : paused.reason)}</span>` : '<span class="c-acc">● running</span>';
      win.setBadge(live ? (paused ? 'paused' : 'run') : '');
      if (paused) document.body.dataset.debugPaused = '1'; else delete document.body.dataset.debugPaused;
      if (live) document.body.dataset.debugActive = '1'; else delete document.body.dataset.debugActive;
    }
    function log(text, cls = '') { out.appendChild(h('div' + (cls ? '.' + cls : ''), text)); if (out.childNodes.length > 2000) out.firstChild.remove(); out.scrollTop = out.scrollHeight; }

    async function start() {
      let file = program.value.trim();
      if (!file) { useActive(); file = program.value.trim(); }
      if (!file) { file = await prompt('Program to debug', project.root ? project.root + '/index.js' : '', { select: false }); if (!file) return; program.value = file; }
      if (!/^([a-zA-Z]:)?[\\/]/.test(file) && project.root) file = project.root + '/' + file;
      // Save dirty buffers first, like any debugger would.
      for (const d of docs.values()) if (d.dirty && d.path === file) { const { saveDoc } = await import('../core/docs.js'); await saveDoc(d); }
      out.innerHTML = ''; vars.innerHTML = ''; stack.innerHTML = '';
      log(`▶ node --inspect-brk ${basename(file)} ${args.value}`, 'c-dim');
      try {
        session = await call('debug:start', { program: file, cwd: project.root && file.startsWith(project.root) ? project.root : undefined, args: args.value.trim() ? args.value.trim().split(/\s+/) : [], stopOnEntry: stopEntry.checked });
        win.setSub(`${basename(file)} · pid ${session.pid}`);
      } catch (e) { log(e.message, 'c-red'); session = null; }
      paused = null; setUi(); win.save();
    }
    async function act(kind) { if (!session) return; try { await call('debug:' + kind, session.id); } catch (e) { fail(e); } }

    function renderStack() {
      stack.innerHTML = '';
      if (!paused) return;
      paused.frames.forEach((f, i) => {
        const row = h('div.dbg-frame' + (i === frameIdx ? '.sel' : ''), { html: `<span class="fn">${esc(f.fn)}</span><span class="c-dim">${esc(f.file ? rel(project.root, f.file) : f.url || '<internal>')}:${f.line}</span>` });
        row.addEventListener('click', () => { frameIdx = i; renderStack(); showFrame(); });
        stack.appendChild(row);
      });
    }
    async function showFrame() {
      const f = paused && paused.frames[frameIdx]; if (!f) return;
      if (f.file) { setDebugLoc(f.file, f.line); bus.emit('open-file', f.file, { line: f.line }); }
      vars.innerHTML = '';
      for (const sc of f.scopes.filter((s) => s.type !== 'global' || f.scopes.length === 1)) {
        vars.appendChild(varNode(`${sc.type}${sc.name ? ' ' + sc.name : ''}`, '', sc.objectId, sc.type === 'local' || sc.type === 'block' || sc.type === 'closure' && false, true));
      }
    }
    function varNode(name, value, objectId, open, isScope) {
      const kids = h('div.vk');
      const row = h('div.vr' + (isScope ? '.scope' : ''), { html: `<span class="tw">${objectId ? '▸' : ' '}</span><span class="${isScope ? 'c-dim' : 'vn'}">${esc(name)}</span>${value !== '' ? `<span class="c-mute">: </span><span class="vv">${esc(value)}</span>` : ''}` });
      let loaded = false; let isOpen = false;
      const toggle = async () => {
        if (!objectId) return;
        isOpen = !isOpen; row.querySelector('.tw').textContent = isOpen ? '▾' : '▸';
        kids.style.display = isOpen ? '' : 'none';
        if (isOpen && !loaded) {
          loaded = true;
          try {
            const props = await call('debug:properties', session.id, objectId);
            for (const p of props) kids.appendChild(varNode(p.name, p.value, p.objectId, false, false));
            if (!props.length) kids.appendChild(h('div.c-mute', '(empty)'));
          } catch (e) { kids.appendChild(h('div.c-red', e.message)); }
        }
      };
      row.addEventListener('click', toggle);
      const wrap = h('div.vnode', row, kids);
      if (open) toggle();
      return wrap;
    }
    function renderBps() {
      bpList.innerHTML = '';
      const all = [...breakpoints].flatMap(([p, set]) => [...set].sort((a, b) => a - b).map((l) => [p, l]));
      if (!all.length) { bpList.appendChild(h('div.c-mute', { style: { padding: '0 8px' } }, 'click the editor gutter or press F9')); return; }
      for (const [p, l] of all) {
        const row = h('div.dbg-bp', { html: `<span class="c-red">●</span> ${esc(basename(p))}<span class="c-dim">:${l}</span>` });
        row.appendChild(h('button.btn.ghost.icon', { html: '×', on: { click: (e) => { e.stopPropagation(); toggleBreakpoint(p, l); } } }));
        row.addEventListener('click', () => bus.emit('open-file', p, { line: l }));
        bpList.appendChild(row);
      }
    }

    offs.push(on('debug:paused', (p) => { if (!session || p.id !== session.id) return; paused = p; frameIdx = 0; setUi(); renderStack(); showFrame(); wm.restore(win); }));
    offs.push(on('debug:resumed', (p) => { if (!session || p.id !== session.id) return; paused = null; setUi(); renderStack(); vars.innerHTML = ''; setDebugLoc(null, null); }));
    offs.push(on('debug:output', (p) => { if (session && p.id === session.id) for (const line of p.data.replace(/\n$/, '').split('\n')) log(line, p.stream === 'err' ? 'c-red' : p.stream === 'console' ? 'c-cyan' : ''); }));
    offs.push(on('debug:ended', (p) => { if (!session || p.id !== session.id) return; log(`■ process exited (${p.signal || p.code})`, 'c-dim'); session = null; paused = null; setUi(); setDebugLoc(null, null); win.setSub(''); }));
    offs.push(bus.on('bp:changed', renderBps));
    evalInp.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !evalInp.value.trim()) return;
      const expr = evalInp.value; evalInp.value = '';
      log('› ' + expr, 'c-acc');
      if (!session) { log('no active session', 'c-red'); return; }
      try {
        const f = paused && paused.frames[frameIdx];
        const r = await call('debug:evaluate', session.id, f ? f.id : null, expr);
        if (r.error) log(r.error, 'c-red');
        else if (r.objectId) out.appendChild(varNode('←', r.value, r.objectId, false, false));
        else log('← ' + r.value);
        out.scrollTop = out.scrollHeight;
      } catch (er) { log(er.message, 'c-red'); }
    });
    // F5 continue/pause, F10 step over, F11 step in, Shift+F11 step out — global while a session is live.
    // Starting (F5 / Ctrl+F5), stop (Shift+F5) and restart are handled by core/run.js.
    const keys = (e) => {
      if (!session || e.ctrlKey || e.metaKey) return;
      if (e.key === 'F5' && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); paused ? act('resume') : act('pause'); }
      else if (e.key === 'F10' && paused) { e.preventDefault(); e.stopImmediatePropagation(); act('stepOver'); }
      else if (e.key === 'F11' && paused) { e.preventDefault(); e.stopImmediatePropagation(); act(e.shiftKey ? 'stepOut' : 'stepInto'); }
    };
    document.addEventListener('keydown', keys, true);
    offs.push(() => document.removeEventListener('keydown', keys, true));
    program.addEventListener('change', () => win.save());

    setUi(); renderBps();
    log('Set breakpoints in any editor (gutter / F9), then START. F5 continue · F10 over · F11 into.', 'c-dim');
    if (state.autostart && state.program) setTimeout(start, 50);
    return {
      serialize: () => ({ program: program.value, args: args.value, stopOnEntry: stopEntry.checked }),
      apply: (s) => { if (s.program) program.value = s.program; if (s.autostart && !session) start(); },
      isActive: () => !!session,
      stop: () => session && call('debug:stop', session.id),
      destroy() { offs.forEach((f) => f()); if (session) call('debug:stop', session.id).catch(() => {}); setDebugLoc(null, null); delete document.body.dataset.debugPaused; delete document.body.dataset.debugActive; }
    };
  }
};
