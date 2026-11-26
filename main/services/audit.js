'use strict';
// Security auditing: dependency vulnerabilities (via the ecosystem's own audit tools),
// committed-secret detection, and risky-configuration checks. All local.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { abs, run, which, walk, isBinary, exists } = require('../util');

const SECRET_RULES = [
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'critical'],
  ['AWS secret key', /aws(.{0,20})?(secret|private)?.{0,20}['"][0-9a-zA-Z/+]{40}['"]/i, 'critical'],
  ['Private key block', /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/, 'critical'],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'critical'],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20}\b/, 'critical'],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'high'],
  ['Slack webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/, 'high'],
  ['Stripe live key', /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/, 'critical'],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/, 'high'],
  ['OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/, 'high'],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/, 'high'],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, 'medium'],
  ['Database URL with password', /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s]+/i, 'high'],
  ['Generic secret assignment', /\b(api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s$<{]{12,}['"]/i, 'medium']
];
const SEV_ORDER = { critical: 4, high: 3, moderate: 2, medium: 2, low: 1, info: 0 };

function mask(s) {
  return s.replace(/([A-Za-z0-9_\-/+]{4})([A-Za-z0-9_\-/+]{6,})([A-Za-z0-9_\-/+]{2})/g, (_m, a, b, c) => a + '•'.repeat(Math.min(b.length, 12)) + c);
}

module.exports = (core) => {
  async function npmAudit(root) {
    const lock = ['package-lock.json', 'npm-shrinkwrap.json'].find((f) => fs.existsSync(path.join(root, f)));
    const isPnpm = fs.existsSync(path.join(root, 'pnpm-lock.yaml'));
    const isYarn = fs.existsSync(path.join(root, 'yarn.lock'));
    if (!fs.existsSync(path.join(root, 'package.json'))) return null;
    const findings = [];
    if (isPnpm && which('pnpm')) {
      const r = await run('pnpm', ['audit', '--json'], { cwd: root, timeout: 120000 });
      try {
        const j = JSON.parse(r.stdout);
        for (const a of Object.values(j.advisories || {})) findings.push({ tool: 'pnpm audit', package: a.module_name, severity: a.severity, title: a.title, url: a.url, range: a.vulnerable_versions, fix: a.patched_versions });
      } catch { return { tool: 'pnpm audit', error: (r.stderr || r.stdout).slice(0, 400), findings: [] }; }
      return { tool: 'pnpm audit', findings };
    }
    if (!lock && isYarn) return { tool: 'npm audit', error: 'yarn.lock found — run `yarn npm audit` (yarn berry) in a terminal; npm audit needs package-lock.json', findings: [] };
    if (!lock) return { tool: 'npm audit', error: 'No package-lock.json — run `npm install` to generate one', findings: [] };
    if (!which('npm')) return { tool: 'npm audit', error: 'npm not found on PATH', findings: [] };
    const r = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], { cwd: root, timeout: 120000, shell: process.platform === 'win32' });
    let j; try { j = JSON.parse(r.stdout); } catch { return { tool: 'npm audit', error: (r.stderr || r.stdout).slice(0, 400) || 'npm audit failed', findings: [] }; }
    if (j.error) return { tool: 'npm audit', error: j.error.summary || j.error.code, findings: [] };
    for (const [name, v] of Object.entries(j.vulnerabilities || {})) {
      const via = (v.via || []).filter((x) => typeof x === 'object');
      if (!via.length) findings.push({ tool: 'npm audit', package: name, severity: v.severity, title: `via ${(v.via || []).join(', ')}`, range: v.range, fix: v.fixAvailable ? (v.fixAvailable === true ? 'npm audit fix' : `${v.fixAvailable.name}@${v.fixAvailable.version}`) : null, direct: v.isDirect });
      for (const a of via) findings.push({ tool: 'npm audit', package: name, severity: a.severity || v.severity, title: a.title, url: a.url, range: a.range, fix: v.fixAvailable ? (v.fixAvailable === true ? 'npm audit fix' : `${v.fixAvailable.name}@${v.fixAvailable.version}`) : null, direct: v.isDirect });
    }
    return { tool: 'npm audit', findings, meta: j.metadata && j.metadata.dependencies };
  }

  async function pipAudit(root) {
    const req = ['requirements.txt', 'pyproject.toml', 'Pipfile.lock', 'poetry.lock'].find((f) => fs.existsSync(path.join(root, f)));
    if (!req) return null;
    if (!which('pip-audit')) return { tool: 'pip-audit', error: 'Python project detected — install pip-audit (`pipx install pip-audit`) to scan it', findings: [] };
    const args = ['-f', 'json', '--progress-spinner', 'off'];
    if (req === 'requirements.txt') args.push('-r', 'requirements.txt');
    const r = await run('pip-audit', args, { cwd: root, timeout: 180000 });
    let j; try { j = JSON.parse(r.stdout); } catch { return { tool: 'pip-audit', error: (r.stderr || '').slice(0, 400), findings: [] }; }
    const deps = Array.isArray(j) ? j : j.dependencies || [];
    const findings = [];
    for (const d of deps) for (const v of d.vulns || []) findings.push({ tool: 'pip-audit', package: `${d.name}@${d.version}`, severity: 'high', title: `${v.id}${v.description ? ': ' + v.description.slice(0, 140) : ''}`, fix: (v.fix_versions || []).join(', ') || null, url: v.id && v.id.startsWith('GHSA') ? `https://github.com/advisories/${v.id}` : `https://osv.dev/vulnerability/${v.id}` });
    return { tool: 'pip-audit', findings };
  }

  async function cargoAudit(root) {
    if (!fs.existsSync(path.join(root, 'Cargo.lock'))) return null;
    if (!which('cargo-audit') && !which('cargo')) return { tool: 'cargo audit', error: 'cargo not found', findings: [] };
    const r = await run('cargo', ['audit', '--json'], { cwd: root, timeout: 180000 });
    let j; try { j = JSON.parse(r.stdout); } catch { return { tool: 'cargo audit', error: /no such (sub)?command/i.test(r.stderr) ? 'install with `cargo install cargo-audit`' : r.stderr.slice(0, 300), findings: [] }; }
    const findings = (j.vulnerabilities && j.vulnerabilities.list || []).map((v) => ({ tool: 'cargo audit', package: `${v.package.name}@${v.package.version}`, severity: (v.advisory.cvss ? 'high' : 'medium'), title: `${v.advisory.id}: ${v.advisory.title}`, url: v.advisory.url, fix: (v.versions && v.versions.patched || []).join(', ') || null }));
    return { tool: 'cargo audit', findings };
  }

  async function goAudit(root) {
    if (!fs.existsSync(path.join(root, 'go.mod'))) return null;
    if (!which('govulncheck')) return { tool: 'govulncheck', error: 'Go module detected — install govulncheck (`go install golang.org/x/vuln/cmd/govulncheck@latest`)', findings: [] };
    const r = await run('govulncheck', ['-format', 'json', './...'], { cwd: root, timeout: 300000 });
    const findings = []; const osv = new Map();
    for (const chunk of r.stdout.split(/\n(?=\{)/)) {
      try {
        const j = JSON.parse(chunk);
        if (j.osv) osv.set(j.osv.id, j.osv);
        if (j.finding && j.finding.trace && j.finding.trace[0]) {
          const o = osv.get(j.finding.osv) || {};
          const t = j.finding.trace[0];
          if (!findings.some((f) => f.title.startsWith(j.finding.osv))) findings.push({ tool: 'govulncheck', package: `${t.module}@${t.version || ''}`, severity: 'high', title: `${j.finding.osv}: ${o.summary || ''}`, fix: j.finding.fixed_version || null, url: `https://pkg.go.dev/vuln/${j.finding.osv}` });
        }
      } catch { /* partial */ }
    }
    return { tool: 'govulncheck', findings };
  }

  async function secrets(root) {
    const files = await walk(root, { maxFiles: 40000 });
    const findings = []; let scanned = 0;
    for (const f of files) {
      if (/\.(png|jpe?g|gif|ico|woff2?|ttf|eot|pdf|zip|gz|mp4|mp3|wasm|lock|min\.js|map)$/i.test(f)) continue;
      if (/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)) continue;
      let buf;
      try { const st = await fsp.stat(f); if (st.size > 1024 * 1024) continue; buf = await fsp.readFile(f); } catch { continue; }
      if (isBinary(buf)) continue;
      scanned++;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 2000) continue;
        for (const [rule, re, sev] of SECRET_RULES) {
          const m = re.exec(line);
          if (!m) continue;
          if (/example|dummy|placeholder|changeme|xxxx|your[_-]?(api|key|token)/i.test(line)) continue;
          findings.push({ file: f, line: i + 1, rule, severity: sev, preview: mask(line.trim()).slice(0, 160) });
          break;
        }
        if (findings.length > 1000) break;
      }
    }
    return { scanned, findings };
  }

  async function config(root) {
    const out = [];
    const add = (severity, title, detail, file) => out.push({ severity, title, detail, file });
    const isRepo = await exists(path.join(root, '.git'));
    // env files tracked or not ignored
    const envs = (await walk(root, { maxFiles: 20000, filter: (_f, n) => /^\.env(\..+)?$/.test(n) && !/\.(example|sample|template)$/.test(n) }));
    for (const e of envs) {
      if (isRepo) {
        const tracked = await run('git', ['ls-files', '--error-unmatch', e], { cwd: root });
        if (tracked.code === 0) { add('critical', 'Environment file is committed to git', path.relative(root, e) + ' is tracked — rotate any secrets inside and remove it from history', e); continue; }
        const ign = await run('git', ['check-ignore', '-q', e], { cwd: root });
        if (ign.code !== 0) add('high', 'Environment file is not git-ignored', path.relative(root, e) + ' could be committed by accident — add it to .gitignore', e);
      }
    }
    // package.json risks
    const pj = path.join(root, 'package.json');
    if (await exists(pj)) {
      try {
        const j = JSON.parse(await fsp.readFile(pj, 'utf8'));
        for (const [k, v] of Object.entries(j.scripts || {})) {
          if (/(curl|wget)[^|]*\|\s*(ba|z)?sh/.test(v)) add('high', `Script "${k}" pipes a download into a shell`, v, pj);
          if (/^(pre|post)?install$/.test(k)) add('low', `Lifecycle script "${k}" runs on every install`, v, pj);
        }
        const deps = { ...j.dependencies, ...j.devDependencies };
        for (const [n, v] of Object.entries(deps)) {
          if (/^(git|http|https|github):|^[\w-]+\/[\w.-]+(#.*)?$/.test(String(v))) add('medium', `Dependency "${n}" is installed from a URL/git ref`, `${n}: ${v} bypasses registry integrity checks`, pj);
          if (v === '*' || v === 'latest') add('medium', `Dependency "${n}" is unpinned`, `${n}: ${v}`, pj);
        }
        if (!(await exists(path.join(root, 'package-lock.json'))) && !(await exists(path.join(root, 'yarn.lock'))) && !(await exists(path.join(root, 'pnpm-lock.yaml')))) add('medium', 'No lockfile', 'Builds are not reproducible and audits cannot run', pj);
      } catch { add('low', 'package.json could not be parsed', '', pj); }
    }
    // Dockerfiles
    for (const d of await walk(root, { maxFiles: 20000, filter: (_f, n) => /^Dockerfile(\..+)?$|\.dockerfile$/i.test(n) })) {
      const txt = await fsp.readFile(d, 'utf8').catch(() => '');
      if (!/^\s*USER\s+(?!root\b)/mi.test(txt)) add('medium', 'Container runs as root', `${path.relative(root, d)} has no non-root USER instruction`, d);
      if (/^\s*FROM\s+\S+:latest\b/mi.test(txt) || /^\s*FROM\s+[^:\s]+\s*$/mi.test(txt)) add('low', 'Unpinned base image', `${path.relative(root, d)} uses :latest or no tag`, d);
      if (/^\s*ADD\s+https?:/mi.test(txt)) add('medium', 'Remote ADD in Dockerfile', 'Prefer curl with checksum verification', d);
    }
    // World-writable files (posix)
    if (process.platform !== 'win32') {
      let ww = 0;
      for (const f of await walk(root, { maxFiles: 30000 })) {
        try { const st = await fsp.stat(f); if (st.mode & 0o002) { ww++; if (ww <= 20) add('medium', 'World-writable file', path.relative(root, f), f); } } catch { /* ignore */ }
      }
    }
    // Private keys lying around
    for (const k of await walk(root, { maxFiles: 30000, filter: (_f, n) => /^(id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i.test(n) })) {
      add('high', 'Key material in project tree', path.relative(root, k), k);
    }
    return out;
  }

  return {
    'audit:deps': async (root) => {
      root = abs(root);
      const results = (await Promise.all([npmAudit(root), pipAudit(root), cargoAudit(root), goAudit(root)])).filter(Boolean);
      for (const r of results) r.findings.sort((a, b) => (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0));
      const n = results.reduce((a, r) => a + r.findings.length, 0);
      core.event('SEC', `dependency audit: ${n} finding(s) from ${results.map((r) => r.tool).join(', ') || 'no supported manifests'}`, n ? 'warn' : 'info');
      return results;
    },
    'audit:secrets': async (root) => {
      const r = await secrets(abs(root));
      core.event('SEC', `secret scan: ${r.findings.length} finding(s) in ${r.scanned} files`, r.findings.length ? 'warn' : 'info');
      return r;
    },
    'audit:config': async (root) => {
      const r = await config(abs(root));
      r.sort((a, b) => (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0));
      core.event('SEC', `config audit: ${r.length} finding(s)`, r.length ? 'warn' : 'info');
      return r;
    }
  };
};
