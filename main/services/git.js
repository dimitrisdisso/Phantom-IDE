'use strict';
// Git integration via the git CLI (execFile, never a shell). Network ops run with
// GIT_TERMINAL_PROMPT=0 so they can't hang waiting for credentials.
const path = require('path');
const { abs, run, which } = require('../util');

const REF_RE = /^(?!-)[\w./@{}^~+-]{1,200}$/;

module.exports = (core) => {
  const git = async (root, args, opts = {}) => {
    if (!which('git')) throw new Error('git is not installed or not on PATH');
    const r = await run('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
      cwd: abs(root), env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...opts.env }, timeout: opts.timeout || 120000
    });
    if (r.code !== 0 && !opts.allowFail) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed (${r.code})`);
    return r;
  };
  const files = (list) => {
    if (!Array.isArray(list)) throw new Error('files must be an array');
    return list.map((f) => { if (typeof f !== 'string' || !f) throw new Error('bad path'); return f; });
  };
  const ref = (r) => { if (typeof r !== 'string' || !REF_RE.test(r)) throw new Error('Invalid ref name'); return r; };

  return {
    'git:root': async (dir) => {
      const r = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
      return r.code === 0 ? path.resolve(r.stdout.trim()) : null;
    },
    'git:init': async (dir) => { await git(dir, ['init']); return true; },

    'git:status': async (root) => {
      const r = await git(root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
      const parts = r.stdout.split('\0');
      const out = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]; if (!p) continue;
        if (p.startsWith('## ')) {
          const h = p.slice(3).replace(/^(No commits yet on |Initial commit on )/, '');
          const bi = h.indexOf(' [');
          const left = bi >= 0 ? h.slice(0, bi) : h;
          const ab = bi >= 0 ? h.slice(bi) : '';
          const [br, up] = left.split('...');
          out.branch = br.startsWith('HEAD (no branch)') ? 'HEAD (detached)' : br;
          out.upstream = up || null;
          out.ahead = +((/ahead (\d+)/.exec(ab) || [])[1] || 0);
          out.behind = +((/behind (\d+)/.exec(ab) || [])[1] || 0);
          continue;
        }
        const x = p[0]; const y = p[1]; const file = p.slice(3);
        let orig = null;
        if (x === 'R' || x === 'C') orig = parts[++i];
        out.files.push({ path: file, orig, index: x, work: y, staged: x !== ' ' && x !== '?', unstaged: y !== ' ', untracked: x === '?', conflict: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D') });
      }
      return out;
    },

    'git:diff': async (root, file, staged = false) => {
      const args = ['diff', '--no-ext-diff', '-M'];
      if (staged) args.push('--cached');
      if (file) args.push('--', file);
      const r = await git(root, args);
      if (!r.stdout && file) {
        // untracked: show as all-added
        const u = await git(root, ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file], { allowFail: true });
        return u.stdout;
      }
      return r.stdout;
    },
    'git:show': async (root, hash) => {
      if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('Invalid commit');
      return (await git(root, ['show', '--stat', '--patch', '-M', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B', hash])).stdout;
    },
    'git:fileAt': async (root, file, rev = 'HEAD') => {
      if (rev !== '' && !REF_RE.test(rev)) throw new Error('Invalid rev');
      const r = await git(root, ['show', `${rev}:${file.split(path.sep).join('/')}`], { allowFail: true });
      return r.code === 0 ? r.stdout : '';
    },
    'git:stage': async (root, list) => { await git(root, ['add', '--', ...files(list)]); return true; },
    'git:stageAll': async (root) => { await git(root, ['add', '-A']); return true; },
    'git:unstage': async (root, list) => {
      const r = await git(root, ['restore', '--staged', '--', ...files(list)], { allowFail: true });
      if (r.code !== 0) await git(root, ['rm', '--cached', '-r', '--', ...files(list)]); // repo with no commits yet
      return true;
    },
    'git:discard': async (root, list) => { await git(root, ['restore', '--worktree', '--', ...files(list)]); return true; },
    'git:clean': async (root, list) => { await git(root, ['clean', '-f', '--', ...files(list)]); return true; },
    'git:commit': async (root, message, amend = false) => {
      if (typeof message !== 'string' || !message.trim()) throw new Error('Commit message required');
      const args = ['commit', '-m', message];
      if (amend) args.push('--amend');
      const r = await git(root, args);
      core.event('GIT', `commit: ${message.split('\n')[0]}`);
      return r.stdout.trim();
    },
    'git:log': async (root, limit = 300) => {
      const n = Math.max(1, Math.min(5000, Number(limit) || 300));
      const r = await git(root, ['log', '--graph', '--all', '--date=relative', `-n${n}`, '--pretty=format:\x1f%h\x1f%an\x1f%ad\x1f%D\x1f%s'], { allowFail: true });
      if (r.code !== 0) return [];
      return r.stdout.split('\n').map((line) => {
        const idx = line.indexOf('\x1f');
        if (idx < 0) return { graph: line };
        const [graph, hash, author, date, refs, subject] = line.split('\x1f');
        return { graph, hash, author, date, refs, subject };
      });
    },
    'git:branches': async (root) => {
      const r = await git(root, ['branch', '-a', '--format=%(HEAD)\x1f%(refname:short)\x1f%(objectname:short)\x1f%(upstream:short)\x1f%(committerdate:relative)\x1f%(refname)']);
      return r.stdout.split('\n').filter(Boolean).map((l) => {
        const [head, name, hash, upstream, date, full] = l.split('\x1f');
        return { current: head === '*', name, hash, upstream, date, remote: (full || '').startsWith('refs/remotes/') };
      }).filter((b) => !b.name.endsWith('/HEAD'));
    },
    'git:checkout': async (root, branch) => { await git(root, ['checkout', ref(branch)]); core.event('GIT', `checked out ${branch}`); return true; },
    'git:createBranch': async (root, name, checkout = true) => {
      await git(root, checkout ? ['checkout', '-b', ref(name)] : ['branch', ref(name)]);
      core.event('GIT', `created branch ${name}`);
      return true;
    },
    'git:fetch': async (root) => (await git(root, ['fetch', '--all', '--prune'], { timeout: 180000 })).stderr.trim() || 'fetched',
    'git:pull': async (root) => { const r = await git(root, ['pull', '--ff-only'], { timeout: 180000 }); core.event('GIT', 'pull complete'); return (r.stdout + r.stderr).trim(); },
    'git:push': async (root) => {
      let r = await git(root, ['push'], { allowFail: true, timeout: 180000 });
      if (r.code !== 0 && /no upstream branch|--set-upstream/.test(r.stderr)) {
        const b = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
        r = await git(root, ['push', '-u', 'origin', ref(b)], { timeout: 180000 });
      } else if (r.code !== 0) throw new Error(r.stderr.trim());
      core.event('GIT', 'push complete');
      return (r.stdout + r.stderr).trim();
    },
    'git:stash': async (root, pop = false) => (await git(root, pop ? ['stash', 'pop'] : ['stash', 'push', '-u'])).stdout.trim(),
    'git:blame': async (root, file) => {
      const r = await git(root, ['blame', '--line-porcelain', '--', file]);
      const out = []; let cur = null;
      for (const l of r.stdout.split('\n')) {
        if (/^[0-9a-f]{40} /.test(l)) { cur = { hash: l.slice(0, 8) }; continue; }
        if (!cur) continue;
        if (l.startsWith('author ')) cur.author = l.slice(7);
        else if (l.startsWith('author-time ')) cur.time = Number(l.slice(12)) * 1000;
        else if (l.startsWith('summary ')) cur.summary = l.slice(8);
        else if (l.startsWith('\t')) { out.push(cur); cur = null; }
      }
      return out;
    }
  };
};
