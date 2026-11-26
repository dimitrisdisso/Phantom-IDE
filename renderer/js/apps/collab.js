// Live Session: host / join a real-time collaboration session, participants, shared files, chat.
import { h, esc, time, copy, basename } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import * as live from '../core/collab.js';
import { wm } from '../core/wm.js';
import { toast, fail, confirm } from '../core/ui.js';

export default {
  id: 'collab', title: 'Live Session', icon: 'collab', desc: 'Real-time collaborative editing', size: [460, 620], min: [340, 360], singleton: true,
  async create(win) {
    const saved = (await call('store:get', 'collab', {}).catch(() => ({}))) || {};
    const info = await call('app:info').catch(() => ({ user: '' }));
    const root = h('div.live-root.fill.scroll');
    win.body.appendChild(root);
    let busy = false;

    const remember = (patch) => { Object.assign(saved, patch); call('store:set', 'collab', saved).catch(() => {}); };
    const field = (label, inp) => h('label.live-field', h('span', label), inp);

    function renderIdle() {
      root.innerHTML = '';
      const name = h('input.inp', { value: saved.name || info.user || '', placeholder: 'your display name', spellcheck: false });
      const port = h('input.inp', { value: saved.port || '7457', spellcheck: false, style: { width: '90px' } });
      const addr = h('input.inp', { value: saved.address || '', placeholder: '192.168.1.20:7457', spellcheck: false });
      const code = h('input.inp.live-code-in', { placeholder: 'XXXX-XXXX-XXXX-XXXX', spellcheck: false });
      const hostBtn = h('button.btn.primary', { on: { click: async () => {
        if (busy) return; busy = true; hostBtn.disabled = true;
        remember({ name: name.value.trim(), port: port.value.trim() });
        try { await live.host({ name: name.value.trim(), port: Number(port.value) || 7457 }); } catch (e) { fail(e, 'HOST'); }
        busy = false; hostBtn.disabled = false;
      } } }, '▶ START SESSION');
      const joinBtn = h('button.btn.primary', { on: { click: async () => {
        if (busy) return; busy = true; joinBtn.disabled = true; joinBtn.textContent = 'CONNECTING…';
        remember({ name: name.value.trim(), address: addr.value.trim() });
        try { await live.join({ address: addr.value.trim(), code: code.value.trim(), name: name.value.trim() }); } catch (e) { fail(e, 'JOIN'); }
        busy = false; joinBtn.disabled = false; joinBtn.textContent = 'JOIN';
      } } }, 'JOIN');
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
      code.addEventListener('paste', (e) => {
        // Accept a pasted invite ("… 192.168.1.20:7457 … ABCD-EFGH-…") and split it into both fields.
        const t = (e.clipboardData || {}).getData ? e.clipboardData.getData('text') : '';
        const c = /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/i.exec(t); const a = /\b(\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)\b/.exec(t);
        if (c && a) { e.preventDefault(); code.value = c[0].toUpperCase(); addr.value = a[1]; }
      });
      root.append(
        h('div.live-intro', { html: 'Edit the same file at the same time, with live cursors and chat. Connections go <b>directly between your computers</b> (no cloud). Everything is encrypted with the session code.' }),
        field('DISPLAY NAME', name),
        h('div.live-card',
          h('div.hdr', 'HOST A SESSION'),
          h('div.c-dim.live-help', 'You share files from your project; collaborators connect to your computer.'),
          h('div.live-row', field('PORT', port), h('span.sp'), hostBtn)),
        h('div.live-card',
          h('div.hdr', 'JOIN A SESSION'),
          h('div.c-dim.live-help', 'Ask the host for their address and session code (or paste their invite into the code box).'),
          field('HOST ADDRESS', addr), field('SESSION CODE', code), h('div.live-row', h('span.sp'), joinBtn)),
        h('div.c-mute.live-help', { html: 'Same network: works out of the box (allow PHANTOM through the firewall when asked).<br>Over the internet: use a VPN like Tailscale/ZeroTier, or forward the port on the host\'s router.' })
      );
      win.setSub('offline'); win.setBadge('');
    }

    function renderLive() {
      const s = live.session;
      root.innerHTML = '';
      // header
      const head = h('div.live-card.live-head');
      if (s.role === 'host') {
        const inviteText = () => `Join my PHANTOM live session\naddress: ${s.addresses.length ? s.addresses.map((a) => `${a.address}:${s.port}`).join('  or  ') : 'localhost:' + s.port}\ncode: ${s.code}`;
        head.append(
          h('div.hdr', 'HOSTING', h('span.sp'), h('span.pill.c-acc', '● live')),
          h('div.live-code', { title: 'click to copy', on: { click: () => { copy(s.code); toast('session code copied'); } } }, s.code),
          h('div.c-dim.live-help', 'Collaborators join with one of these addresses + the code:'),
          h('div.live-addrs', s.addresses.length ? s.addresses.map((a) => h('span.live-addr', { title: a.iface, on: { click: () => { copy(`${a.address}:${s.port}`); toast('address copied'); } } }, `${a.address}:${s.port}`)) : h('span.c-amber', `no network interface found — localhost:${s.port} only`)),
          h('div.live-row', h('button.btn', { on: { click: () => { copy(inviteText()); toast('invite copied — send it to your collaborator'); } } }, 'COPY INVITE'), h('span.sp'), h('button.btn.danger', { on: { click: async () => { if (await confirm('End session', 'End the live session for everyone?', { danger: true, ok: 'END SESSION' })) live.leave(); } } }, 'END SESSION'))
        );
      } else {
        head.append(
          h('div.hdr', 'CONNECTED', h('span.sp'), h('span.pill.c-acc', '● live')),
          h('div', { html: `${esc(s.hostName)}'s session <span class="c-dim">at ${esc(s.host)}</span>` }),
          h('div.live-row', h('span.sp'), h('button.btn.danger', { on: { click: () => live.leave() } }, 'LEAVE'))
        );
      }
      // people
      const people = h('div.live-card', h('div.hdr', `PEOPLE (${s.peers.length})`),
        ...s.peers.map((p) => h('div.live-peer', { html: `<i class="live-dot c${p.color}"></i><b>${esc(p.name)}</b>${p.id === (s.me && s.me.id) ? ' <span class="c-dim">(you)</span>' : ''}${p.host ? ' <span class="pill c-dim">host</span>' : ''}` })));
      // files
      const files = h('div.live-card', h('div.hdr', `SHARED FILES (${s.docs.length})`, h('span.sp'), h('button.btn.primary', { on: { click: shareCurrent } }, '+ SHARE CURRENT FILE')));
      if (!s.docs.length) files.appendChild(h('div.c-mute.live-help', 'Nothing shared yet. Open a file in the editor and click “share current file”, or right-click a file in the explorer.'));
      for (const d of s.docs) {
        const mine = d.owner === (s.me && s.me.id);
        const row = h('div.live-file', { html: `<span class="nm">${esc(d.name)}</span><span class="c-dim">${mine ? 'yours' : esc(d.ownerName)}</span>` });
        row.appendChild(h('button.btn', { on: { click: () => openShared(d) } }, 'OPEN'));
        if (mine) row.appendChild(h('button.btn.ghost', { title: 'Stop sharing', on: { click: () => live.unshare(d.id) } }, '×'));
        files.appendChild(row);
      }
      // chat
      const log = h('div.live-chat-log.sel-text');
      for (const m of s.chat) log.appendChild(chatLine(m));
      const inp = h('input.inp', { placeholder: 'message…  (Enter to send)', spellcheck: true });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { live.sendChat(inp.value); inp.value = ''; } });
      const chat = h('div.live-card.live-chat', h('div.hdr', 'CHAT'), log, inp);
      root.append(head, people, files, chat);
      log.scrollTop = log.scrollHeight;
      s.unread = 0;
      win.setSub(s.role === 'host' ? `hosting · ${s.peers.length} in session` : `with ${s.hostName}`);
      win.setBadge('');
    }
    function chatLine(m) {
      const p = live.peerById(m.peer);
      return h('div.live-msg', { html: `<span class="c-mute">${time(m.ts).slice(0, 5)}</span> <b class="live-fg c${p ? p.color : 0}">${esc(m.name)}</b> ${esc(m.text)}` });
    }

    async function shareCurrent() {
      const ed = wm.recent('editor');
      const f = ed && ed.instance && ed.instance.activeFile && ed.instance.activeFile();
      if (!f) { toast('open a file in an editor first', 'warn'); return; }
      try { await live.share(f); } catch (e) { fail(e, 'SHARE'); }
    }
    function openShared(d) {
      // Owners edit their real file; everyone else gets a live virtual copy.
      bus.emit('open-file', live.pathOf(d.id) || live.virtualPath(d.id, d.name), {});
    }

    const render = () => (live.session.role ? renderLive() : renderIdle());
    const offs = [
      bus.on('collab:changed', render),
      bus.on('collab:chat', (m) => {
        if (!win.visible || !win.focused) { win.setBadge(String(live.session.unread)); if (!win.visible) toast(`${m.name}: ${m.text}`, 'info', 'LIVE CHAT', 4000); }
      })
    ];
    render();
    return { onFocus: () => { live.session.unread = 0; win.setBadge(''); }, destroy: () => offs.forEach((f) => f()) };
  }
};
export { basename };
