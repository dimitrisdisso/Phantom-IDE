'use strict';
// SSH connection profiles. Sessions run the system OpenSSH client inside a real PTY, so
// keys, agents, known_hosts, ProxyJump and ~/.ssh/config all behave exactly as in a shell.
// Passwords are never stored — OpenSSH prompts for them inside the terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJsonAtomic, which, abs } = require('../util');

const HOST_RE = /^(?!-)[A-Za-z0-9._:%[\]-]{1,253}$/;
const USER_RE = /^(?!-)[A-Za-z0-9._-]{1,64}$/;
const ALIAS_RE = /^(?!-)[A-Za-z0-9._*?-]{1,128}$/;

function validate(p) {
  const out = { id: p.id || crypto.randomUUID(), name: String(p.name || p.host || 'host').slice(0, 80) };
  if (p.alias) { if (!ALIAS_RE.test(p.alias)) throw new Error('Invalid ssh config alias'); out.alias = p.alias; }
  else {
    if (!HOST_RE.test(p.host || '')) throw new Error('Invalid host');
    out.host = p.host;
    if (p.user) { if (!USER_RE.test(p.user)) throw new Error('Invalid user'); out.user = p.user; }
  }
  if (p.port) { const n = Number(p.port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid port'); out.port = n; }
  if (p.identityFile) out.identityFile = abs(p.identityFile);
  if (p.jump) { if (!/^(?!-)[A-Za-z0-9._@:,[\]-]{1,300}$/.test(p.jump)) throw new Error('Invalid jump host'); out.jump = p.jump; }
  if (p.forwards) {
    out.forwards = String(p.forwards).split(',').map((s) => s.trim()).filter(Boolean);
    for (const f of out.forwards) if (!/^[LRD]:[\w.:[\]-]+$/.test(f)) throw new Error('Forward must look like L:8080:localhost:80 or D:1080');
  }
  out.tags = String(p.tags || '').slice(0, 120);
  return out;
}

module.exports = (core) => {
  const file = path.join(core.dataDir, 'ssh-profiles.json');
  const load = () => readJson(file, []);

  return {
    'ssh:list': load,
    'ssh:save': async (profile) => {
      const p = validate(profile || {});
      const list = await load();
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) list[i] = p; else list.push(p);
      await writeJsonAtomic(file, list);
      return p;
    },
    'ssh:delete': async (id) => { const list = (await load()).filter((x) => x.id !== id); await writeJsonAtomic(file, list); return true; },
    'ssh:configHosts': async () => {
      const cfg = path.join(os.homedir(), '.ssh', 'config');
      let txt = '';
      try { txt = fs.readFileSync(cfg, 'utf8'); } catch { return []; }
      const hosts = []; let cur = null;
      for (const raw of txt.split('\n')) {
        const l = raw.trim(); if (!l || l.startsWith('#')) continue;
        const m = /^(\S+)\s*=?\s*(.*)$/.exec(l); if (!m) continue;
        const k = m[1].toLowerCase();
        if (k === 'host') { for (const a of m[2].split(/\s+/)) if (!/[*?!]/.test(a)) { cur = { alias: a }; hosts.push(cur); } continue; }
        if (!cur) continue;
        if (k === 'hostname') cur.host = m[2]; else if (k === 'user') cur.user = m[2]; else if (k === 'port') cur.port = m[2];
      }
      return hosts;
    },
    // Returns the argv for a terminal session. The renderer spawns it through pty:spawn.
    'ssh:command': async (profile) => {
      const ssh = which('ssh');
      if (!ssh) throw new Error('OpenSSH client (ssh) not found on PATH');
      const p = validate(profile || {});
      const args = [];
      if (p.port) args.push('-p', String(p.port));
      if (p.identityFile) args.push('-i', p.identityFile);
      if (p.jump) args.push('-J', p.jump);
      for (const f of p.forwards || []) { const [t, spec] = [f[0], f.slice(2)]; args.push('-' + t, spec); }
      args.push('-o', 'ServerAliveInterval=30');
      args.push('--', p.alias || (p.user ? `${p.user}@${p.host}` : p.host));
      core.event('NET', `ssh → ${p.alias || p.host}`);
      return { shell: ssh, args, title: p.name };
    }
  };
};
