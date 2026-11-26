// Live system event stream: FS, GIT, PROC, NET, PTY, TASK, DEBUG, SEC, SYS, APP.
import { h, esc, time } from '../core/dom.js';
import { call, on } from '../core/api.js';
import { plot } from '../core/graph.js';

const SOURCES = ['FS', 'GIT', 'PROC', 'NET', 'PTY', 'TASK', 'DEBUG', 'SEC', 'DB', 'COLLAB', 'SYS', 'APP', 'UI'];

export default {
  id: 'events', title: 'Event Stream', icon: 'events', desc: 'Live system event feed', size: [680, 460], min: [360, 200],
  async create(win, state) {
    const muted = new Set(state.muted || []); let paused = false; let filter = ''; const events = []; const rate = new Array(60).fill(0); let bucket = 0;
    const chips = h('div.ev-chips');
    const filterInp = h('input.inp', { placeholder: 'filter…', style: { width: '160px' } });
    const pauseBtn = h('button.btn', { on: { click: () => { paused = !paused; pauseBtn.classList.toggle('on', paused); pauseBtn.textContent = paused ? 'RESUME' : 'PAUSE'; if (!paused) render(); } } }, 'PAUSE');
    const spark = h('canvas.ev-spark');
    const list = h('div.ev-list.fill.scroll.sel-text');
    const counter = h('span.c-dim');
    win.body.append(h('div.toolbar', chips, h('span.sp'), filterInp, pauseBtn, h('button.btn.ghost', { on: { click: () => { events.length = 0; render(); } } }, 'CLEAR')), h('div.ev-rate', spark, counter), list);

    const renderChips = () => {
      chips.innerHTML = '';
      for (const s of SOURCES) chips.appendChild(h('button.ev-chip.s-' + s + (muted.has(s) ? '.off' : ''), { on: { click: () => { muted.has(s) ? muted.delete(s) : muted.add(s); renderChips(); render(); win.save(); } } }, s));
    };
    const row = (e) => `<div class="ev ${esc(e.level)}"><span class="t">${time(e.ts)}</span><span class="src s-${esc(e.source)}">${esc(e.source)}</span><span class="m">${esc(e.message)}</span></div>`;
    const visible = (e) => !muted.has(e.source) && (!filter || `${e.source} ${e.message}`.toLowerCase().includes(filter));
    function render() {
      const shown = events.filter(visible).slice(-800);
      list.innerHTML = shown.map(row).join('') || '<div class="c-mute" style="padding:10px">waiting for events… (open files, run tasks, start servers, spawn processes)</div>';
      list.scrollTop = list.scrollHeight;
      counter.textContent = `${events.length} events · ${rate.slice(-10).reduce((a, b) => a + b, 0) / 10} /s`;
    }
    function add(e) {
      events.push(e); if (events.length > 5000) events.shift();
      bucket++;
      if (paused || !win.visible || !visible(e)) return;
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
      if (list.firstChild && list.firstChild.classList && list.firstChild.classList.contains('c-mute')) list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', row(e));
      if (list.childNodes.length > 1000) list.firstChild.remove();
      if (atBottom) list.scrollTop = list.scrollHeight;
    }
    const tick = setInterval(() => {
      rate.push(bucket); rate.shift(); bucket = 0;
      if (win.visible) { plot(spark, [{ data: rate }], { grid: false, points: 60 }); counter.textContent = `${events.length} events · ${(rate.slice(-10).reduce((a, b) => a + b, 0) / 10).toFixed(1)}/s`; }
    }, 1000);
    const off = on('events:event', add);
    const recent = await call('events:subscribe').catch(() => []);
    events.push(...recent);
    filterInp.addEventListener('input', () => { filter = filterInp.value.toLowerCase(); render(); });
    renderChips(); render();
    return { serialize: () => ({ muted: [...muted] }), onShow: render, destroy() { clearInterval(tick); off(); call('events:unsubscribe').catch(() => {}); } };
  }
};
