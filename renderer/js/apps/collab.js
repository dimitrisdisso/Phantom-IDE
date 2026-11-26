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
    const KIND = { lan: 'same network', vpn: 'VPN (Tailscale/ZeroTier)', public: 'public', virtual: 'virtual adapter' };

    // Windows Firewall: shows whether other computers can reach this one, with a one-click fix.
    let fw = null;
    function firewallBox() {
      const box = h('div.live-fw');
      const draw = () => {
        box.innerHTML = '';
        if (!fw || !fw.supported) return;
        if (fw.allowed) { box.appendChild(h('div.c-acc.live-help', '✓ Windows Firewall allows direct connections to PHANTOM.')); return; }
        const btn = h('button.btn.primary', { on: { click: async () => {
          btn.disabled = true; btn.textContent = 'WAITING FOR WINDOWS…';
          try { fw = await call('collab:allowFirewall'); toast('PHANTOM is now allowed through Windows Firewall', 'info', 'FIREWALL'); } catch (e) { fail(e, 'FIREWALL'); }
          draw();
        } } }, 'ALLOW THROUGH FIREWALL');
        box.append(h('div.c-dim.live-help', { html: 'Windows Firewall blocks <b>direct</b> same-network connections to this computer. Joining with the code over the internet works anyway; allow it only if you want direct connections (needs an administrator prompt, once).' }), h('div.live-row', h('span.sp'), btn));
      };
      if (fw) draw(); else call('collab:firewall').then((r) => { fw = r; draw(); }).catch(() => {});
      return box;
    }
    const extractAddrs = (t) => [...String(t).matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?\b/g)].filter((m) => !/^(169\.254|127)\./.test(m[1])).map((m) => m[1] + (m[2] ? ':' + m[2] : ''));

    function renderIdle() {
      root.innerHTML = '';
      const name = h('input.inp', { value: saved.name || info.user || '', placeholder: 'your display name', spellcheck: false });
      const port = h('input.inp', { value: saved.port || '7457', spellcheck: false, style: { width: '90px' } });
      const addr = h('input.inp', { value: saved.address || '', placeholder: '192.168.1.20  (several? separate with commas)', spellcheck: false });
      const code = h('input.inp.live-code-in', { placeholder: 'XXXX-XXXX-XXXX-XXXX', spellcheck: false });
      const hostBtn = h('button.btn.primary', { on: { click: async () => {
        if (busy) return; busy = true; hostBtn.disabled = true;
        remember({ name: name.value.trim(), port: port.value.trim() });
        try { await live.host({ name: name.value.trim(), port: Number(port.value) || 7457 }); } catch (e) { fail(e, 'HOST'); }
        busy = false; hostBtn.disabled = false;
      } } }, '▶ START SESSION');
      const joinBtn = h('button.btn.primary', { on: { click: async () => {
        if (busy) return;
        if (!/^[A-Z2-9]{16}$/i.test(code.value.replace(/[^A-Z0-9]/gi, ''))) { toast('Type the 16-character session code the host sent you (XXXX-XXXX-XXXX-XXXX)', 'warn', 'JOIN'); code.focus(); return; }
        busy = true; joinBtn.disabled = true; joinBtn.textContent = 'FINDING THE HOST…';
        remember({ name: name.value.trim(), address: addr.value.trim() });
        try { await live.join({ address: addr.value.trim(), code: code.value.trim(), name: name.value.trim() }); } catch (e) { fail(e, 'JOIN'); }
        busy = false; joinBtn.disabled = false; joinBtn.textContent = 'JOIN';
      } } }, 'JOIN');
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
      // Accept a pasted invite ("… 192.168.1.20:7457 or 100.x.y.z:7457 … ABCD-EFGH-…") in either box and
      // split it into both fields. Every address is kept: JOIN tries them all and uses whichever answers.
      const onPaste = (e) => {
        const t = (e.clipboardData || {}).getData ? e.clipboardData.getData('text') : '';
        const c = /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/i.exec(t); const a = extractAddrs(t);
        // The code alone is enough (found over the internet); same-network addresses are a bonus.
        if (c) { e.preventDefault(); code.value = c[0].toUpperCase(); addr.value = a.join(', '); toast('code pasted: click JOIN', 'info', 'LIVE', 1800); }
      };
      code.addEventListener('paste', onPaste); addr.addEventListener('paste', onPaste);
      // LAN discovery
      const found = h('div.live-found');
      const findBtn = h('button.btn', { title: 'Look for PHANTOM sessions on this network', on: { click: async () => {
        findBtn.disabled = true; findBtn.textContent = 'SEARCHING…'; found.innerHTML = '';
        try {
          const list = await call('collab:discover', { ms: 1600 });
          if (!list.length) found.appendChild(h('div.c-amber.live-help', 'No sessions answered on this network. That\'s fine: joining with just the code works over the internet.'));
          for (const x of list) {
            const it = h('button.live-found-it', { on: { click: () => {
              addr.value = `${x.address}:${x.port}`;
              [...found.children].forEach((c) => c.classList.remove('on')); it.classList.add('on');
              code.focus(); toast(`selected ${x.name}'s session: now type the session code`, 'info', 'LIVE', 2500);
            } } }, h('b', x.name), h('span.c-dim', `${x.host ? x.host + ' · ' : ''}${x.address}:${x.port} · ${x.peers} in session${x.local ? ' · this computer' : ''}`));
            found.appendChild(it);
          }
        } catch (e) { fail(e, 'FIND'); }
        findBtn.disabled = false; findBtn.textContent = 'FIND SESSIONS';
      } } }, 'FIND SESSIONS');
      root.append(
        h('div.live-intro', { html: 'Edit the same file together from <b>anywhere</b>, with live cursors and chat. The host starts a session and sends the code; the others join with <b>just the code</b>. No accounts, VPN or port forwarding: computers connect peer-to-peer, encrypted with the code.' }),
        field('DISPLAY NAME', name),
        h('div.live-card',
          h('div.hdr', 'HOST A SESSION'),
          h('div.c-dim.live-help', 'Start a session, then send the code to your collaborators. You share files from your project.'),
          h('div.live-row', h('span.sp'), hostBtn),
          h('details.live-adv', h('summary', 'Same-network options'),
            h('div.c-dim.live-help', 'Direct port for people on your network (used alongside the internet connection).'),
            h('div.live-row', field('PORT', port)),
            firewallBox())),
        h('div.live-card',
          h('div.hdr', 'JOIN A SESSION'),
          h('div.c-dim.live-help', 'Paste or type the code the host sent you, then click JOIN.'),
          field('SESSION CODE', code), h('div.live-row', h('span.sp'), joinBtn),
          h('details.live-adv', { open: !!addr.value }, h('summary', 'Same-network options'),
            h('div.c-dim.live-help', 'Optional. On the same network you can also connect directly; JOIN tries this and the internet at the same time.'),
            h('div.live-row', h('span.sp'), findBtn), found, field('HOST ADDRESS (optional)', addr)))
      );
      win.setSub('offline'); win.setBadge('');
    }

    function renderLive() {
      const s = live.session;
      root.innerHTML = '';
      // header
      const head = h('div.live-card.live-head');
      if (s.role === 'host') {
        const reachable = s.addresses.filter((a) => a.kind !== 'virtual');
        const lan = s.port ? (reachable.length ? reachable : s.addresses).map((a) => `${a.address}:${s.port}`).join(', ') : '';
        const inviteText = () => `Join my PHANTOM live session: open PHANTOM → Live Session, paste this and click JOIN.\ncode: ${s.code}${lan ? `\n(same network: ${lan})` : ''}`;
        // Internet reachability = direct peer-to-peer OR the relay; either one is enough.
        const st = [s.p2p, s.relay];
        const overall = st.includes('online') ? 'online' : st.includes('connecting') ? 'connecting' : st.includes('error') ? 'error' : 'off';
        const routes = [s.p2p === 'online' ? 'direct' : null, s.relay === 'online' ? 'relay' : null].filter(Boolean).join(' + ');
        const net = h('div.live-net-box',
          {
            connecting: h('div.c-dim.live-help.live-net', '◌ Going online so others can join from anywhere…'),
            online: h('div.c-acc.live-help.live-net', `✓ Online: anyone with the code can join from anywhere. `, h('span.c-mute', `(${routes})`)),
            error: h('div.c-amber.live-help.live-net', `⚠ Not reachable over the internet yet. ${s.relayError || s.p2pError || ''} People on your network can still join.`),
            off: h('div.c-amber.live-help.live-net', 'Internet joining is unavailable in this build: people on your network can still join.')
          }[overall],
          s.relay === 'off' && overall !== 'off' ? h('div.c-mute.live-help', 'No relay configured: people on strict networks (mobile data, some ISPs) may not be able to connect. See relay/README.md.') : null);
        head.append(
          h('div.hdr', 'HOSTING', h('span.sp'), h('span.pill.c-acc', '● live')),
          h('div.live-code', { title: 'click to copy', on: { click: () => { copy(s.code); toast('session code copied'); } } }, s.code),
          h('div.c-dim.live-help', 'Send this code to your collaborators. They open Live Session, paste it and click JOIN.'),
          net,
          h('div.live-row', h('button.btn.primary', { on: { click: () => { copy(inviteText()); toast('invite copied: send it to your collaborator'); } } }, 'COPY INVITE'), h('span.sp'), h('button.btn.danger', { on: { click: async () => { if (await confirm('End session', 'End the live session for everyone?', { danger: true, ok: 'END SESSION' })) live.leave(); } } }, 'END SESSION')),
          h('details.live-adv', h('summary', 'Same-network details'),
            s.port ? h('div.live-addrs', s.addresses.length ? s.addresses.map((a, i) => h('span.live-addr' + (a.kind === 'virtual' ? '.virt' : ''), { title: `${a.iface} · click to copy`, on: { click: () => { copy(`${a.address}:${s.port}`); toast('address copied'); } } }, `${a.address}:${s.port}`, h('small', ` ${i === 0 ? 'best · ' : ''}${KIND[a.kind] || a.kind}`))) : h('span.c-amber', 'no network connection found')) : h('div.c-amber.live-help', 'The direct port was busy, so only internet joining is active.'),
            h('div.c-mute.live-help', 'People on your network connect directly to these addresses (or via FIND SESSIONS), which is a little faster.'),
            firewallBox())
        );
      } else {
        head.append(
          h('div.hdr', 'CONNECTED', h('span.sp'), h('span.pill.c-acc', '● live')),
          h('div', { html: `${esc(s.hostName)}'s session <span class="c-dim">${/internet/.test(s.host || '') ? '· peer-to-peer over the internet' : 'at ' + esc(s.host)}</span>` }),
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
