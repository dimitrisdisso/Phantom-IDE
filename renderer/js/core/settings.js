// Settings + theme engine. Themes drive CSS variables, Monaco and xterm palettes.
import { call, bus } from './api.js';

export const THEMES = {
  phantom: { name: 'PHANTOM', desc: 'neon green on void', bg: '#050807', bg1: '#08100c', bg2: '#0b1510', bg3: '#102019', line: '#10261a', line2: '#1b4630', line3: '#2a6b49', fg: '#c5e8d2', fgHi: '#eafff2', dim: '#6b8f7a', mute: '#3f5a4b', accent: '#00ff66', cyan: '#00e5ff', amber: '#ffb000', red: '#ff3b5c', violet: '#b78cff' },
  fsociety: { name: 'FSOCIETY', desc: 'red alert, white noise', bg: '#070505', bg1: '#0e0808', bg2: '#140b0b', bg3: '#1e1010', line: '#2a1414', line2: '#4a1f22', line3: '#7a2b31', fg: '#e8d6d6', fgHi: '#ffffff', dim: '#957474', mute: '#5c4242', accent: '#ff2e4d', cyan: '#e6e6e6', amber: '#ffb000', red: '#ff5470', violet: '#ff8fb1' },
  ecorp: { name: 'E CORP', desc: 'corporate ice blue', bg: '#04070b', bg1: '#070c13', bg2: '#0a121c', bg3: '#0f1b29', line: '#122236', line2: '#1d3a5c', line3: '#2b5687', fg: '#cfdcec', fgHi: '#f0f6ff', dim: '#6e86a3', mute: '#3e5068', accent: '#4da3ff', cyan: '#5ff2ff', amber: '#ffc35a', red: '#ff4f6d', violet: '#a99bff' },
  amber: { name: 'AMBER CRT', desc: '1983 phosphor terminal', bg: '#080602', bg1: '#0e0b04', bg2: '#141006', bg3: '#1e1709', line: '#2a200b', line2: '#4a3812', line3: '#7a5c1a', fg: '#f0d9a8', fgHi: '#fff3d6', dim: '#a08650', mute: '#5f4f2e', accent: '#ffb000', cyan: '#ffd36b', amber: '#ff7a1a', red: '#ff4d3d', violet: '#e6a95c' },
  darkarmy: { name: 'DARK ARMY', desc: 'violet ops, crimson alerts', bg: '#060509', bg1: '#0b0910', bg2: '#100d18', bg3: '#171222', line: '#1f1830', line2: '#352854', line3: '#54408a', fg: '#dcd3ee', fgHi: '#f6f1ff', dim: '#8a7ba8', mute: '#4f456a', accent: '#b36bff', cyan: '#ff3d7f', amber: '#ffb347', red: '#ff3d5a', violet: '#7ad7ff' },
  ice: { name: 'ICEBREAKER', desc: 'cyan grid, deep sea', bg: '#030809', bg1: '#061011', bg2: '#081719', bg3: '#0c2124', line: '#0e2b2f', line2: '#164a51', line3: '#20727c', fg: '#c6eaee', fgHi: '#ecfdff', dim: '#679499', mute: '#3b5a5e', accent: '#00e5ff', cyan: '#00ff9c', amber: '#ffcc33', red: '#ff4b6e', violet: '#9d8cff' },
  ghost: { name: 'GHOST', desc: 'monochrome, low glare', bg: '#060606', bg1: '#0b0b0b', bg2: '#111111', bg3: '#181818', line: '#1f1f1f', line2: '#333333', line3: '#555555', fg: '#cfcfcf', fgHi: '#ffffff', dim: '#8a8a8a', mute: '#505050', accent: '#e8e8e8', cyan: '#9fd8ff', amber: '#e8c36a', red: '#ff6b6b', violet: '#c7a8ff' }
};

export const DEFAULTS = {
  theme: 'phantom', accent: '', glow: 1, scanlines: false, grid: true, uiFontSize: 12,
  editorFontSize: 13, terminalFontSize: 13, minimap: true, wordWrap: false, tabSize: 2, autosave: false,
  reduceMotion: false, snap: true, magnet: 10, ctrlArrowSnap: true, boot: true, shell: '', cursorBlink: true, fontLigatures: true
};

export const settings = { ...DEFAULTS };

const hexRgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`; };

export function theme() {
  const t = { ...(THEMES[settings.theme] || THEMES.phantom) };
  if (settings.accent && /^#[0-9a-f]{6}$/i.test(settings.accent)) t.accent = settings.accent;
  return t;
}

export function applyTheme() {
  const t = theme();
  const r = document.documentElement.style;
  const map = { bg: '--bg', bg1: '--bg1', bg2: '--bg2', bg3: '--bg3', line: '--line', line2: '--line2', line3: '--line3', fg: '--fg', fgHi: '--fg-hi', dim: '--dim', mute: '--mute', accent: '--accent', cyan: '--cyan', amber: '--amber', red: '--red', violet: '--violet' };
  for (const [k, v] of Object.entries(map)) r.setProperty(v, t[k]);
  r.setProperty('--accent-rgb', hexRgb(t.accent)); r.setProperty('--cyan-rgb', hexRgb(t.cyan));
  r.setProperty('--amber-rgb', hexRgb(t.amber)); r.setProperty('--red-rgb', hexRgb(t.red));
  r.setProperty('--glow-k', String(settings.glow));
  r.setProperty('--fs', settings.uiFontSize + 'px'); r.setProperty('--fs-s', (settings.uiFontSize - 1) + 'px'); r.setProperty('--fs-xs', (settings.uiFontSize - 2) + 'px');
  document.body.classList.toggle('scanlines', !!settings.scanlines);
  document.body.classList.toggle('grid-on', !!settings.grid);
  document.body.classList.toggle('reduce-motion', !!settings.reduceMotion);
  if (window.monaco) defineMonacoTheme(window.monaco);
  bus.emit('theme:changed', t);
}

export function defineMonacoTheme(monaco) {
  const t = theme();
  const s = (c) => c.replace('#', '');
  monaco.editor.defineTheme('phantom', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: s(t.fg) },
      { token: 'comment', foreground: s(t.mute), fontStyle: 'italic' },
      { token: 'keyword', foreground: s(t.accent) },
      { token: 'keyword.control', foreground: s(t.accent) },
      { token: 'storage', foreground: s(t.accent) },
      { token: 'string', foreground: s(t.amber) },
      { token: 'string.escape', foreground: s(t.red) },
      { token: 'regexp', foreground: s(t.red) },
      { token: 'number', foreground: s(t.cyan) },
      { token: 'constant', foreground: s(t.cyan) },
      { token: 'type', foreground: s(t.violet) },
      { token: 'type.identifier', foreground: s(t.violet) },
      { token: 'identifier', foreground: s(t.fg) },
      { token: 'delimiter', foreground: s(t.dim) },
      { token: 'operator', foreground: s(t.dim) },
      { token: 'tag', foreground: s(t.accent) },
      { token: 'attribute.name', foreground: s(t.cyan) },
      { token: 'attribute.value', foreground: s(t.amber) },
      { token: 'key', foreground: s(t.cyan) },
      { token: 'string.key.json', foreground: s(t.cyan) },
      { token: 'string.value.json', foreground: s(t.amber) },
      { token: 'variable', foreground: s(t.fgHi) },
      { token: 'variable.predefined', foreground: s(t.violet) },
      { token: 'annotation', foreground: s(t.violet) },
      { token: 'metatag', foreground: s(t.violet) }
    ],
    colors: {
      'editor.background': t.bg, 'editor.foreground': t.fg, 'editorLineNumber.foreground': t.mute, 'editorLineNumber.activeForeground': t.accent,
      'editorCursor.foreground': t.accent, 'editor.selectionBackground': t.accent + '33', 'editor.inactiveSelectionBackground': t.accent + '1a',
      'editor.lineHighlightBackground': t.bg2, 'editor.lineHighlightBorder': t.bg2, 'editorIndentGuide.background1': t.line, 'editorIndentGuide.activeBackground1': t.line3,
      'editorWhitespace.foreground': t.line2, 'editor.findMatchBackground': t.amber + '55', 'editor.findMatchHighlightBackground': t.amber + '22',
      'editorBracketMatch.background': t.accent + '22', 'editorBracketMatch.border': t.accent + '88',
      'editorGutter.background': t.bg, 'editorWidget.background': t.bg1, 'editorWidget.border': t.line3, 'editorSuggestWidget.background': t.bg1,
      'editorSuggestWidget.border': t.line3, 'editorSuggestWidget.selectedBackground': t.accent + '22', 'editorSuggestWidget.highlightForeground': t.accent,
      'editorHoverWidget.background': t.bg1, 'editorHoverWidget.border': t.line3, 'scrollbarSlider.background': t.line2 + 'aa', 'scrollbarSlider.hoverBackground': t.line3,
      'minimap.background': t.bg, 'editorOverviewRuler.border': t.bg, 'diffEditor.insertedTextBackground': t.accent + '1f', 'diffEditor.removedTextBackground': t.red + '24',
      'diffEditor.insertedLineBackground': t.accent + '12', 'diffEditor.removedLineBackground': t.red + '14',
      'input.background': t.bg, 'input.border': t.line2, 'focusBorder': t.accent, 'list.hoverBackground': t.bg3, 'list.activeSelectionBackground': t.accent + '22',
      'peekView.border': t.accent, 'peekViewEditor.background': t.bg1, 'peekViewResult.background': t.bg1
    }
  });
  monaco.editor.setTheme('phantom');
}

export function xtermTheme() {
  const t = theme();
  return {
    background: t.bg, foreground: t.fg, cursor: t.accent, cursorAccent: t.bg, selectionBackground: t.accent + '44',
    black: '#1a1f1c', red: t.red, green: t.accent, yellow: t.amber, blue: '#5aa8ff', magenta: t.violet, cyan: t.cyan, white: t.fg,
    brightBlack: t.mute, brightRed: '#ff7a8f', brightGreen: '#6bffa8', brightYellow: '#ffd36b', brightBlue: '#8cc4ff', brightMagenta: '#d4b8ff', brightCyan: '#7af3ff', brightWhite: t.fgHi
  };
}

export async function loadSettings() {
  try { Object.assign(settings, await call('store:get', 'settings', {})); } catch { /* defaults */ }
  applyTheme();
}
let saveTimer;
export function setSetting(key, value) {
  settings[key] = value;
  applyTheme();
  bus.emit('settings:changed', key, value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => call('store:set', 'settings', settings).catch(() => {}), 300);
}
