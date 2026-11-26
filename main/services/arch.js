'use strict';
// Builds a module dependency graph by statically parsing imports (JS/TS, Python, Go, Rust,
// CSS). Also detects circular dependencies via Tarjan's SCC.
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { abs, walk } = require('../util');

const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];
const SRC_EXT = new Set([...JS_EXT, '.py', '.go', '.rs', '.css', '.scss', '.less']);

function tarjan(nodes, adj) {
  let index = 0; const stack = []; const on = new Set(); const idx = new Map(); const low = new Map(); const out = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (adj.get(v) || new Set()).has(v)) out.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);
  return out;
}

module.exports = () => ({
  'arch:graph': async (root, opts = {}) => {
    root = abs(root);
    const files = await walk(root, { maxFiles: opts.maxFiles || 4000, filter: (f) => SRC_EXT.has(path.extname(f)) && !/\.(d\.ts|min\.js)$/.test(f) });
    const set = new Set(files);
    let goModule = null;
    try { goModule = (/^module\s+(\S+)/m.exec(fs.readFileSync(path.join(root, 'go.mod'), 'utf8')) || [])[1] || null; } catch { /* no go */ }
    // tsconfig "paths" alias support (common "@/…" style)
    const aliases = [];
    try {
      const ts = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8').replace(/\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
      const base = path.join(root, (ts.compilerOptions && ts.compilerOptions.baseUrl) || '.');
      for (const [k, v] of Object.entries((ts.compilerOptions && ts.compilerOptions.paths) || {})) aliases.push([k.replace(/\*$/, ''), path.join(base, String(v[0]).replace(/\*$/, ''))]);
    } catch { /* none */ }
    if (!aliases.length && fs.existsSync(path.join(root, 'src'))) aliases.push(['@/', path.join(root, 'src') + path.sep], ['~/', path.join(root, 'src') + path.sep]);

    const resolveJs = (from, spec) => {
      let base = null;
      if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
      else for (const [a, target] of aliases) if (spec.startsWith(a)) { base = path.join(target, spec.slice(a.length)); break; }
      if (!base) return null;
      const cands = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => path.join(base, 'index' + e))];
      if (/\.js$/.test(base)) cands.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
      for (const c of cands) if (set.has(c)) return c;
      return null;
    };
    const resolvePy = (from, mod) => {
      const dots = (mod.match(/^\.+/) || [''])[0].length;
      const rest = mod.slice(dots).split('.').filter(Boolean).join('/');
      let base;
      if (dots) { base = path.dirname(from); for (let i = 1; i < dots; i++) base = path.dirname(base); if (rest) base = path.join(base, rest); }
      else base = path.join(root, rest);
      const cands = [base + '.py', path.join(base, '__init__.py')];
      if (!dots) cands.push(path.join(root, 'src', rest) + '.py', path.join(root, 'src', rest, '__init__.py'));
      for (const c of cands) if (set.has(c)) return c;
      return null;
    };

    const nodes = new Map(); const edges = []; const externals = new Map();
    const node = (f, lines) => {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (!nodes.has(f)) nodes.set(f, { id: rel, path: f, dir: rel.includes('/') ? rel.split('/')[0] : '.', ext: path.extname(f).slice(1), lines: lines || 0, in: 0, out: 0 });
      return nodes.get(f);
    };
    const addExt = (from, pkg) => {
      if (!opts.externals) return;
      const name = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
      if (!name || name.startsWith('node:')) return;
      const key = 'pkg:' + name;
      if (!externals.has(key)) externals.set(key, { id: key, path: null, dir: '(external)', ext: 'pkg', lines: 0, in: 0, out: 0, external: true });
      edges.push([from, key]);
    };

    for (const f of files) {
      let txt; try { txt = await fsp.readFile(f, 'utf8'); } catch { continue; }
      if (txt.length > 800000) continue;
      const lines = txt.split('\n').length;
      node(f, lines);
      const ext = path.extname(f);
      const targets = new Set(); const pkgs = new Set();
      if (JS_EXT.includes(ext)) {
        for (const m of txt.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"\n]+)['"]|require\(\s*['"]([^'"\n]+)['"]\s*\)|import\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
          const spec = m[1] || m[2] || m[3];
          const r = resolveJs(f, spec);
          if (r) targets.add(r); else if (!spec.startsWith('.')) pkgs.add(spec);
        }
      } else if (ext === '.py') {
        for (const m of txt.matchAll(/^\s*(?:from\s+([.\w]+)\s+import\s+([\w*, ]+)|import\s+([\w., ]+))/gm)) {
          if (m[1]) {
            const r = resolvePy(f, m[1]);
            if (r) targets.add(r);
            else { for (const n of m[2].split(',')) { const r2 = resolvePy(f, (m[1].endsWith('.') ? m[1] : m[1] + '.') + n.trim()); if (r2) targets.add(r2); } if (!m[1].startsWith('.') && !targets.size) pkgs.add(m[1].split('.')[0]); }
          } else for (const mod of m[3].split(',')) { const name = mod.trim().split(/\s+/)[0]; const r = resolvePy(f, name); if (r) targets.add(r); else pkgs.add(name.split('.')[0]); }
        }
      } else if (ext === '.go') {
        const block = txt.match(/import\s*\(([\s\S]*?)\)/); const specs = [];
        if (block) for (const m of block[1].matchAll(/"([^"]+)"/g)) specs.push(m[1]);
        for (const m of txt.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm)) specs.push(m[1]);
        for (const sp of specs) {
          if (goModule && sp.startsWith(goModule)) {
            const dir = path.join(root, sp.slice(goModule.length));
            for (const c of files) if (path.dirname(c) === dir && c.endsWith('.go') && !c.endsWith('_test.go')) { targets.add(c); break; }
          } else if (sp.includes('.')) pkgs.add(sp.split('/').slice(0, 3).join('/'));
        }
      } else if (ext === '.rs') {
        for (const m of txt.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
          const dir = path.basename(f) === 'mod.rs' || path.basename(f) === 'lib.rs' || path.basename(f) === 'main.rs' ? path.dirname(f) : path.join(path.dirname(f), path.basename(f, '.rs'));
          for (const c of [path.join(dir, m[1] + '.rs'), path.join(dir, m[1], 'mod.rs')]) if (set.has(c)) { targets.add(c); break; }
        }
      } else {
        for (const m of txt.matchAll(/@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]/g)) {
          const b = path.resolve(path.dirname(f), m[1]);
          for (const c of [b, b + '.css', b + '.scss', path.join(path.dirname(b), '_' + path.basename(b) + '.scss')]) if (set.has(c)) { targets.add(c); break; }
        }
      }
      targets.delete(f);
      for (const t of targets) edges.push([f, t]);
      for (const p of pkgs) { node(f); addExt(f, p); }
    }
    // normalize
    const out = [];
    for (const [a, b] of edges) {
      const na = nodes.get(a);
      if (!na) continue;
      if (typeof b === 'string' && b.startsWith('pkg:')) { const nb = externals.get(b); na.out++; nb.in++; out.push([na.id, nb.id]); continue; }
      if (!nodes.has(b)) node(b);
      const nb = nodes.get(b); na.out++; nb.in++;
      out.push([na.id, nb.id]);
    }
    const all = [...nodes.values(), ...externals.values()];
    const adj = new Map();
    for (const [a, b] of out) { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); }
    const cycles = tarjan(all.map((n) => n.id), adj).slice(0, 50);
    return { root, nodes: all, edges: out, cycles, truncated: files.length >= (opts.maxFiles || 4000) };
  }
});
