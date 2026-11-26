// SSH: saved host profiles, ~/.ssh/config import, quick connect — sessions open as terminal windows.
import { h, esc } from '../core/dom.js';
import { call } from '../core/api.js';
import { form, confirm, toast, fail, menu } from '../core/ui.js';
import { wm } from '../core/wm.js';

export default {
  id: 'ssh', title: 'SSH', icon: 'ssh', desc: 'Remote shells via OpenSSH', size: [560, 480], min: [340, 220],
  async create(win) {
    let profiles = []; let configHosts = [];
    const quick = h('input.inp', { placeholder: 'quick connect: user@host[:port]', style: { flex: 1 }, spellcheck: false });
    const list = h('div.fill.scroll.ssh-list');
    win.body.append(h('div.toolbar', quick, h('button.btn.primary', { on: { click: quickConnect } }, 'CONNECT'), h('button.btn', { on: { click: () => edit() } }, '+ PROFILE')), list,
      h('div.toolbar.pr-foot', h('span.c-dim', 'Sessions use your system OpenSSH client: keys, ssh-agent, known_hosts and ~/.ssh/config apply. Passwords are typed in the terminal and never stored.')));

    async function load() {
      profiles = await call('ssh:list').catch(() => []);
      configHosts = await call('ssh:configHosts').catch(() => []);
      render();
    }
    function render() {
      list.innerHTML = '';
      list.appendChild(h('div.hdr', `PROFILES (${profiles.length})`));
      if (!profiles.length) list.appendChild(h('div.c-mute', { style: { padding: '2px 10px 8px' } }, 'no saved hosts yet'));
      for (const p of profiles) {
        const row = h('div.ssh-row', { html: `<span class="dot"></span><b>${esc(p.name)}</b><span class="c-dim">${esc(p.alias ? 'config:' + p.alias : `${p.user ? p.user + '@' : ''}${p.host}${p.port ? ':' + p.port : ''}`)}</span>${p.jump ? `<span class="pill c-violet">via ${esc(p.jump)}</span>` : ''}${(p.forwards || []).map((f) => `<span class="pill c-cyan">${esc(f)}</span>`).join('')}<span class="sp"></span>` });
        row.appendChild(h('button.btn.primary', { on: { click: (e) => { e.stopPropagation(); connect(p); } } }, 'CONNECT'));
        row.addEventListener('dblclick', () => connect(p));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
          { label: 'Connect', action: () => connect(p) },
          { label: 'Edit…', action: () => edit(p) },
          { label: 'Duplicate', action: () => edit({ ...p, id: undefined, name: p.name + ' copy' }) },
          { label: 'Delete', danger: true, action: async () => { if (await confirm('Delete profile', `Delete "${p.name}"?`, { danger: true, ok: 'DELETE' })) { await call('ssh:delete', p.id); load(); } } }
        ]); });
        list.appendChild(row);
      }
      if (configHosts.length) {
        list.appendChild(h('div.hdr', `~/.ssh/config (${configHosts.length})`));
        for (const c of configHosts) {
          const row = h('div.ssh-row', { html: `<span class="dot cfg"></span><b>${esc(c.alias)}</b><span class="c-dim">${esc([c.user, c.host].filter(Boolean).join('@'))}${c.port ? ':' + esc(c.port) : ''}</span><span class="sp"></span>` });
          row.append(h('button.btn.ghost', { on: { click: () => edit({ name: c.alias, alias: c.alias }) } }, 'save'), h('button.btn', { on: { click: () => connect({ name: c.alias, alias: c.alias }) } }, 'CONNECT'));
          row.addEventListener('dblclick', () => connect({ name: c.alias, alias: c.alias }));
          list.appendChild(row);
        }
      }
    }
    async function connect(p) {
      try {
        const cmd = await call('ssh:command', p);
        await wm.open('terminal', { state: { shell: cmd.shell, args: cmd.args, title: 'SSH · ' + cmd.title } });
      } catch (e) { fail(e, 'SSH'); }
    }
    function quickConnect() {
      const m = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/.exec(quick.value.trim());
      if (!m) { toast('format: user@host[:port]', 'warn'); return; }
      connect({ name: quick.value.trim(), user: m[1], host: m[2], port: m[3] });
    }
    quick.addEventListener('keydown', (e) => { if (e.key === 'Enter') quickConnect(); });
    async function edit(p = {}) {
      const r = await form(p.id ? 'Edit SSH profile' : 'New SSH profile', [
        { key: 'name', label: 'Name', value: p.name || '' },
        { key: 'alias', label: 'ssh config alias (leave empty to use host/user)', value: p.alias || '' },
        { key: 'host', label: 'Host', value: p.host || '', placeholder: 'server.example.com' },
        { key: 'user', label: 'User', value: p.user || '' },
        { key: 'port', label: 'Port', value: p.port || '', placeholder: '22' },
        { key: 'identityFile', label: 'Identity file (optional)', value: p.identityFile || '', placeholder: '~/.ssh/id_ed25519' },
        { key: 'jump', label: 'Jump host (ProxyJump, optional)', value: p.jump || '', placeholder: 'user@bastion' },
        { key: 'forwards', label: 'Port forwards (comma separated)', value: (p.forwards || []).join(', '), placeholder: 'L:8080:localhost:80, D:1080' }
      ]);
      if (!r) return;
      try { await call('ssh:save', { ...r, id: p.id }); toast('profile saved'); load(); } catch (e) { fail(e, 'SSH PROFILE'); }
    }
    await load();
    return {};
  }
};
