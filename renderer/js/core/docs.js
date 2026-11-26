// Shared document registry: one model per file, shared by every editor window.
// Also owns Monaco loading, breakpoints and the current debugger location.
import { call, bus } from './api.js';
import { defineMonacoTheme, settings } from './settings.js';
import { toast } from './ui.js';
import { basename } from './dom.js';

let monacoPromise = null;
export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve) => {
    if (!window.require || !window.require.config) return resolve(null);
    const timer = setTimeout(() => { console.warn('monaco load timeout'); resolve(null); }, 15000);
    window.require.config({ paths: { vs: 'vendor/monaco/vs' } });
    window.require(['vs/editor/editor.main'], (monaco) => {
      clearTimeout(timer);
      window.monaco = monaco;
      defineMonacoTheme(monaco);
      const ts = monaco.languages.typescript;
      const opts = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, allowJs: true, allowNonTsExtensions: true, jsx: ts.JsxEmit.Preserve, esModuleInterop: true, checkJs: false, strict: false, noEmit: true };
      ts.typescriptDefaults.setCompilerOptions(opts);
      ts.javascriptDefaults.setCompilerOptions(opts);
      ts.typescriptDefaults.setEagerModelSync(true);
      ts.javascriptDefaults.setEagerModelSync(true);
      ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      resolve(monaco);
    }, (err) => { clearTimeout(timer); console.warn('monaco failed', err); resolve(null); });
  });
  return monacoPromise;
}

/** Plain-text fallback model, used when Monaco is unavailable. */
class TextModel {
  constructor(text) { this.text = text; this.version = 1; this.fns = new Set(); }
  getValue() { return this.text; }
  setValue(t) { this.text = t; this.version++; for (const f of this.fns) f(); }
  getAlternativeVersionId() { return this.version; }
  onDidChangeContent(fn) { this.fns.add(fn); return { dispose: () => this.fns.delete(fn) }; }
  dispose() { this.fns.clear(); }
}

// Virtual document providers keyed by URI scheme (e.g. collab://) — used for live-shared files.
const schemes = new Map();
export function registerScheme(name, provider) { schemes.set(name, provider); }
const schemeOf = (p) => { const m = /^([a-z]+):\/\//.exec(p); return m && schemes.has(m[1]) ? schemes.get(m[1]) : null; };

class Doc {
  constructor(path, model, mtime, eol, provider = null) {
    this.path = path; this.model = model; this.mtime = mtime; this.eol = eol; this.provider = provider;
    this.saved = model.getAlternativeVersionId(); this.refs = 0; this.conflict = false; this.lastDirty = false;
    this.sub = model.onDidChangeContent(() => {
      const d = this.dirty;
      if (d !== this.lastDirty) { this.lastDirty = d; bus.emit('doc:dirty', this); }
      bus.emit('doc:changed', this);
      if (settings.autosave && d) this.autosave();
    });
    this.autosaveT = null;
  }
  get dirty() { return !this.provider && this.model.getAlternativeVersionId() !== this.saved; }
  get virtual() { return !!this.provider; }
  get name() { return basename(this.path); }
  getValue() { return this.model.getValue(); }
  autosave() { clearTimeout(this.autosaveT); this.autosaveT = setTimeout(() => saveDoc(this).catch(() => {}), 1200); }
}

export const docs = new Map();

// Virtual documents (collab://id/name, …) keep their forward slashes: rewriting them to
// backslashes on Windows broke the scheme, so guests could never open a live-shared file.
const isVirtual = (p) => /^[a-z][a-z0-9+.-]+:\/\//i.test(p);
export const normPath = (p) => (window.phantom && window.phantom.platform === 'win32' && !isVirtual(String(p)) ? String(p).replace(/\//g, '\\').replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':') : String(p));

export async function openDoc(path) {
  const provider = schemeOf(path);
  if (!provider) path = normPath(path);
  let doc = docs.get(path);
  if (!doc && provider) {
    const v = await provider.open(path);
    doc = docs.get(path);
    if (!doc) {
      doc = new Doc(path, v.model || new TextModel(v.text), Date.now(), v.eol, provider);
      docs.set(path, doc);
      if (v.after) v.after(doc);
    }
  }
  if (!doc) {
    const r = await call('fs:read', path);
    if (r.binary) throw new Error(`${basename(path)} is a binary file (${r.size} bytes)`);
    const monaco = await loadMonaco();
    let model;
    if (monaco) {
      const uri = monaco.Uri.file(path);
      model = monaco.editor.getModel(uri) || monaco.editor.createModel(r.content, undefined, uri);
      if (model.getValue() !== r.content) model.setValue(r.content);
      model.updateOptions({ tabSize: settings.tabSize, insertSpaces: true });
      if (r.eol === 'CRLF') model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    } else model = new TextModel(r.content);
    doc = docs.get(path); // another caller may have won the race
    if (doc) { if (model !== doc.model) model.dispose(); }
    else { doc = new Doc(path, model, r.mtime, r.eol); docs.set(path, doc); }
  }
  doc.refs++;
  return doc;
}

export function releaseDoc(doc) {
  if (--doc.refs > 0) return;
  if (doc.provider && doc.provider.release) { try { doc.provider.release(doc); } catch (e) { console.error(e); } }
  docs.delete(doc.path);
  doc.sub.dispose();
  clearTimeout(doc.autosaveT);
  doc.model.dispose();
  bus.emit('doc:closed', doc);
}

export async function saveDoc(doc) {
  if (doc.provider) return doc.provider.save(doc);
  const content = doc.getValue();
  const version = doc.model.getAlternativeVersionId();
  const r = await call('fs:write', doc.path, content);
  doc.mtime = r.mtime; doc.saved = version; doc.conflict = false; doc.lastDirty = doc.dirty;
  bus.emit('doc:dirty', doc);
  bus.emit('doc:saved', doc);
  return r;
}

export function dirtyDocs() { return [...docs.values()].filter((d) => d.dirty); }

// External modification handling.
bus.on('fs:changed', async (paths) => {
  for (const p of paths.map(normPath)) {
    const doc = docs.get(p);
    if (!doc) continue;
    let st; try { st = await call('fs:stat', p); } catch { continue; }
    if (Math.abs(st.mtime - doc.mtime) < 1) continue; // our own write
    if (doc.dirty) {
      if (!doc.conflict) { doc.conflict = true; toast(`${doc.name} changed on disk while you have unsaved edits`, 'warn', 'CONFLICT'); bus.emit('doc:dirty', doc); }
      continue;
    }
    try {
      const r = await call('fs:read', p);
      if (r.content !== doc.getValue()) {
        if (window.monaco && doc.model.pushEditOperations) {
          doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: r.content }], () => null);
        } else doc.model.setValue(r.content);
      }
      doc.mtime = r.mtime; doc.saved = doc.model.getAlternativeVersionId(); doc.lastDirty = false;
      bus.emit('doc:dirty', doc);
    } catch { /* deleted */ }
  }
});

// ───────── breakpoints & debug location ─────────
export const breakpoints = new Map(); // path -> Set<line>
export async function loadBreakpoints() {
  const saved = (await call('store:get', 'breakpoints', {}).catch(() => ({}))) || {};
  for (const [p, lines] of Object.entries(saved)) { breakpoints.set(p, new Set(lines)); call('debug:setBreakpoints', p, lines).catch(() => {}); }
}
export function toggleBreakpoint(path, line) {
  path = normPath(path);
  const set = breakpoints.get(path) || new Set();
  set.has(line) ? set.delete(line) : set.add(line);
  if (set.size) breakpoints.set(path, set); else breakpoints.delete(path);
  call('debug:setBreakpoints', path, [...set]).catch(() => {});
  call('store:set', 'breakpoints', Object.fromEntries([...breakpoints].map(([k, v]) => [k, [...v]]))).catch(() => {});
  bus.emit('bp:changed', path);
}
export function clearBreakpoints() {
  for (const p of [...breakpoints.keys()]) { breakpoints.delete(p); call('debug:setBreakpoints', p, []).catch(() => {}); bus.emit('bp:changed', p); }
  call('store:set', 'breakpoints', {}).catch(() => {});
}
export const debugLoc = { path: null, line: null };
export function setDebugLoc(path, line) { debugLoc.path = path; debugLoc.line = line; bus.emit('debug:loc', debugLoc); }
