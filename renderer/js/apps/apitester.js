// API tester: requests with params/headers/body/auth, {{env}} variables, history & saved collection.
import { h, esc, bytes, dur, copy } from '../core/dom.js';
import { call } from '../core/api.js';
import { prompt, toast, fail, menu, splitter } from '../core/ui.js';
import { wm } from '../core/wm.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const blank = () => ({ method: 'GET', url: 'http://localhost:3000/', params: [], headers: [['Accept', 'application/json']], bodyType: 'none', body: '', auth: { type: 'none', token: '', user: '', pass: '' } });

function kvEditor(rows, onChange) {
  const el = h('div.kv-ed');
  const render = () => {
    el.innerHTML = '';
    rows.forEach((r, i) => {
      const on = h('input', { type: 'checkbox', checked: r[2] !== false });
      const k = h('input.inp', { value: r[0] || '', placeholder: 'key', spellcheck: false });
      const v = h('input.inp', { value: r[1] || '', placeholder: 'value', spellcheck: false });
      const del = h('button.btn.ghost.icon', { html: '×', on: { click: () => { rows.splice(i, 1); render(); onChange(); } } });
      const upd = () => { rows[i] = [k.value, v.value, on.checked]; onChange(); };
      [k, v].forEach((x) => x.addEventListener('input', upd)); on.addEventListener('change', upd);
      el.appendChild(h('div.kv-row', h('label.chk', on), k, v, del));
    });
    el.appendChild(h('button.btn.ghost', { on: { click: () => { rows.push(['', '', true]); render(); onChange(); } } }, '+ add'));
  };
  render();
  return { el, render };
}

export default {
  id: 'api', title: 'API Tester', icon: 'api', desc: 'HTTP client & collections', size: [940, 600], min: [480, 300],
  async create(win, state) {
    let req = { ...blank(), ...(state.req || {}) };
    let reqTab = 'params'; let resTab = 'body'; let res = null; let sending = false; let reqId = null;
    let env = (await call('store:get', 'api-env', null)) || [['baseUrl', 'http://localhost:3000', true]];
    let history = (await call('store:get', 'api-history', [])) || [];
    let saved = (await call('store:get', 'api-saved', [])) || [];

    const method = h('select.inp.api-method', METHODS.map((m) => h('option', { value: m, selected: m === req.method }, m)));
    const url = h('input.inp.api-url', { value: req.url, spellcheck: false, placeholder: 'https://api.example.com/v1/items?limit=10  ·  {{baseUrl}}/path' });
    const send = h('button.btn.primary', { on: { click: () => (sending ? cancel() : doSend()) } }, 'SEND');
    const saveBtn = h('button.btn', { on: { click: saveReq } }, 'SAVE');
    const reqTabs = h('div.tabs'); const reqBody = h('div.api-reqbody.scroll');
    const resHead = h('div.api-reshead'); const resTabs = h('div.tabs'); const resBody = h('div.fill.scroll.api-resbody.sel-text');
    const side = h('div.api-side.scroll');
    const reqPane = h('div.split-v', h('div.toolbar.api-line', method, url, send, saveBtn), reqTabs, reqBody);
    const resPane = h('div.split-v.fill', resHead, resTabs, resBody);
    const gutY = h('div.gutter-y');
    const main = h('div.split-v.fill', reqPane, gutY, resPane);
    reqPane.style.flex = '0 0 230px';
    splitter(gutY, reqPane, { axis: 'y', min: 120 });
    const gutX = h('div.gutter-x');
    side.style.flex = '0 0 210px';
    win.body.appendChild(h('div.split-h.fill', side, gutX, main));
    splitter(gutX, side, { min: 140 });

    const vars = () => Object.fromEntries(env.filter((r) => r[2] !== false && r[0]).map((r) => [r[0], r[1]]));
    const subst = (s) => String(s).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (vars()[k] ?? m));

    // keep params table and URL in sync
    function paramsFromUrl() {
      try { const u = new URL(subst(url.value)); req.params = [...u.searchParams].map(([k, v]) => [k, v, true]); } catch { /* partial url */ }
    }
    function urlFromParams() {
      const base = url.value.split('?')[0];
      const q = req.params.filter((p) => p[2] !== false && p[0]).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      url.value = q ? `${base}?${q}` : base; req.url = url.value;
    }
    url.addEventListener('input', () => { req.url = url.value; paramsFromUrl(); if (reqTab === 'params') renderReq(); win.save(); });
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
    method.addEventListener('change', () => { req.method = method.value; win.save(); });

    function renderReqTabs() {
      reqTabs.innerHTML = '';
      const n = { params: req.params.length, headers: req.headers.length };
      for (const [k, l] of [['params', 'PARAMS'], ['headers', 'HEADERS'], ['body', 'BODY'], ['auth', 'AUTH'], ['env', 'ENV']]) reqTabs.appendChild(h('button.tab' + (reqTab === k ? '.on' : ''), { html: `${l}${n[k] ? ` <span class="cnt">${n[k]}</span>` : ''}`, on: { click: () => { reqTab = k; renderReqTabs(); renderReq(); } } }));
    }
    function renderReq() {
      reqBody.innerHTML = '';
      if (reqTab === 'params') reqBody.appendChild(kvEditor(req.params, () => { urlFromParams(); win.save(); }).el);
      else if (reqTab === 'headers') reqBody.appendChild(kvEditor(req.headers, () => { renderReqTabs(); win.save(); }).el);
      else if (reqTab === 'env') reqBody.append(h('div.c-dim', { style: { padding: '2px 0 6px' } }, 'Variables are substituted as {{name}} in URL, headers, body and auth. Stored locally.'), kvEditor(env, () => call('store:set', 'api-env', env).catch(() => {})).el);
      else if (reqTab === 'body') {
        const type = h('select.inp', ['none', 'json', 'text', 'form'].map((t) => h('option', { value: t, selected: req.bodyType === t }, t === 'form' ? 'x-www-form-urlencoded' : t)));
        const ta = h('textarea.inp.api-body', { spellcheck: false, placeholder: req.bodyType === 'form' ? 'a=1&b=2' : '{\n  "key": "value"\n}' }, req.body);
        const fmt = h('button.btn.ghost', { on: { click: () => { try { ta.value = JSON.stringify(JSON.parse(subst(ta.value)), null, 2); req.body = ta.value; } catch (e) { toast('invalid JSON: ' + e.message, 'warn'); } } } }, 'prettify');
        type.addEventListener('change', () => { req.bodyType = type.value; renderReq(); win.save(); });
        ta.addEventListener('input', () => { req.body = ta.value; win.save(); });
        reqBody.append(h('div.toolbar', { style: { border: 0, padding: '0 0 6px', background: 'none' } }, type, req.bodyType === 'json' ? fmt : null));
        if (req.bodyType !== 'none') reqBody.appendChild(ta);
      } else if (reqTab === 'auth') {
        const a = req.auth;
        const type = h('select.inp', [['none', 'No auth'], ['bearer', 'Bearer token'], ['basic', 'Basic auth']].map(([v, l]) => h('option', { value: v, selected: a.type === v }, l)));
        type.addEventListener('change', () => { a.type = type.value; renderReq(); win.save(); });
        reqBody.appendChild(type);
        const field = (k, ph, t = 'text') => { const i = h('input.inp', { value: a[k] || '', placeholder: ph, type: t, spellcheck: false, style: { width: '100%', marginTop: '6px' } }); i.addEventListener('input', () => { a[k] = i.value; win.save(); }); return i; };
        if (a.type === 'bearer') reqBody.appendChild(field('token', 'token or {{var}}'));
        if (a.type === 'basic') reqBody.append(field('user', 'username'), field('pass', 'password', 'password'));
        reqBody.appendChild(h('div.c-mute', { style: { marginTop: '8px' } }, 'Auth values live only in this window and are never written to layouts or history. To reuse a token, reference an ENV variable like {{token}}.'));
      }
    }

    function build() {
      const headers = {};
      for (const [k, v, on] of req.headers) if (on !== false && k) headers[subst(k)] = subst(v);
      let body;
      if (req.bodyType !== 'none' && !['GET', 'HEAD'].includes(req.method)) {
        body = subst(req.body);
        const ct = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
        if (!ct) headers['Content-Type'] = req.bodyType === 'json' ? 'application/json' : req.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain';
      }
      if (req.auth.type === 'bearer' && req.auth.token) headers.Authorization = 'Bearer ' + subst(req.auth.token);
      if (req.auth.type === 'basic') headers.Authorization = 'Basic ' + btoa(unescape(encodeURIComponent(`${subst(req.auth.user)}:${subst(req.auth.pass)}`)));
      return { method: req.method, url: subst(url.value.trim()), headers, body };
    }

    async function doSend() {
      const r = build();
      if (!r.url) return;
      sending = true; send.textContent = 'CANCEL'; send.classList.remove('primary'); send.classList.add('danger');
      resHead.innerHTML = '<span class="spin"></span> <span class="c-dim">sending…</span>';
      reqId = Math.random().toString(36).slice(2);
      const t0 = Date.now();
      try {
        res = await call('http:request', { ...r, id: reqId });
        history.unshift({ ts: t0, method: r.method, url: url.value, status: res.status, ms: Math.round(res.timeMs), req: JSON.parse(JSON.stringify({ ...req, url: url.value, auth: { type: 'none' } })) });
        history = history.slice(0, 100);
        call('store:set', 'api-history', history).catch(() => {});
      } catch (e) { res = { error: e.message, timeMs: Date.now() - t0 }; }
      sending = false; send.textContent = 'SEND'; send.classList.add('primary'); send.classList.remove('danger');
      renderRes(); renderSide();
    }
    function cancel() { if (reqId) call('http:cancel', reqId); }

    function renderRes() {
      if (!res) { resHead.innerHTML = '<span class="c-mute">no response yet — Enter in the URL bar sends</span>'; resTabs.innerHTML = ''; resBody.innerHTML = ''; return; }
      if (res.error) { resHead.innerHTML = `<span class="pill c-red">ERROR</span> <span class="c-red">${esc(res.error)}</span>`; resTabs.innerHTML = ''; resBody.innerHTML = ''; return; }
      const sc = res.status < 300 ? 'c-acc' : res.status < 400 ? 'c-cyan' : res.status < 500 ? 'c-amber' : 'c-red';
      resHead.innerHTML = `<span class="pill ${sc}">${res.status} ${esc(res.statusText)}</span><span>${dur(res.timeMs)}</span><span class="c-dim">ttfb ${dur(res.ttfbMs)}</span><span>${bytes(res.size)}</span><span class="c-dim">${esc(res.contentType)}</span>${res.redirected ? '<span class="c-cyan">redirected</span>' : ''}${res.truncated ? '<span class="c-amber">truncated</span>' : ''}`;
      resTabs.innerHTML = '';
      for (const [k, l] of [['body', 'BODY'], ['raw', 'RAW'], ['headers', `HEADERS ${res.headers.length}`]]) resTabs.appendChild(h('button.tab' + (resTab === k ? '.on' : ''), { on: { click: () => { resTab = k; renderRes(); } } }, l));
      resTabs.appendChild(h('span', { style: { flex: 1 } }));
      if (res.body && /json/.test(res.contentType)) resTabs.appendChild(h('button.btn.ghost', { on: { click: () => wm.open('json', { state: { text: res.body, title: url.value } }) } }, 'open in JSON viewer'));
      resTabs.appendChild(h('button.btn.ghost', { on: { click: () => copy(res.body || '') } }, 'copy'));
      if (resTab === 'headers') resBody.innerHTML = `<div class="kv" style="padding:8px">${res.headers.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>`;
      else if (res.body === null) resBody.innerHTML = `<div class="empty">binary response (${bytes(res.size)})</div>`;
      else if (resTab === 'raw') resBody.innerHTML = `<pre class="mono-pre" style="padding:8px">${esc(res.body)}</pre>`;
      else {
        let html = esc(res.body);
        try { if (/json/.test(res.contentType) || /^\s*[{[]/.test(res.body)) html = highlightJson(JSON.stringify(JSON.parse(res.body), null, 2)); } catch { /* not json */ }
        resBody.innerHTML = `<pre class="mono-pre" style="padding:8px">${html}</pre>`;
      }
    }

    function renderSide() {
      side.innerHTML = '';
      const item = (it, i, kind) => {
        const r = h('div.api-hist', { title: it.url, html: `<span class="m m-${esc(it.method)}">${esc(it.method)}</span><span class="u">${esc(it.name || it.url.replace(/^https?:\/\//, ''))}</span>${it.status ? `<span class="${it.status < 400 ? 'c-acc' : 'c-red'}">${it.status}</span>` : ''}` });
        r.addEventListener('click', () => { req = JSON.parse(JSON.stringify({ ...blank(), ...it.req })); method.value = req.method; url.value = req.url; renderReqTabs(); renderReq(); win.save(); });
        r.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
          { label: 'Open in new window', action: () => wm.open('api', { state: { req: it.req } }) },
          { label: 'Copy as cURL', action: () => copy(curl(it.req)) },
          { label: 'Delete', danger: true, action: () => { (kind === 'saved' ? saved : history).splice(i, 1); call('store:set', kind === 'saved' ? 'api-saved' : 'api-history', kind === 'saved' ? saved : history); renderSide(); } }
        ]); });
        return r;
      };
      side.appendChild(h('div.hdr', 'SAVED'));
      saved.forEach((s, i) => side.appendChild(item({ ...s, method: s.req.method, url: s.req.url }, i, 'saved')));
      if (!saved.length) side.appendChild(h('div.c-mute', { style: { padding: '0 8px 6px' } }, 'none'));
      side.appendChild(h('div.hdr', 'HISTORY', h('span.sp'), history.length ? h('button.btn.ghost', { on: { click: () => { history = []; call('store:set', 'api-history', []); renderSide(); } } }, 'clear') : null));
      history.forEach((x, i) => side.appendChild(item(x, i, 'history')));
    }
    async function saveReq() {
      const name = await prompt('Save request', `${req.method} ${url.value.replace(/^https?:\/\/[^/]+/, '') || '/'}`);
      if (!name) return;
      saved.unshift({ name, req: JSON.parse(JSON.stringify({ ...req, url: url.value, auth: { ...req.auth, token: /\{\{/.test(req.auth.token || '') ? req.auth.token : '', pass: '' } })) });
      await call('store:set', 'api-saved', saved); renderSide();
    }
    function curl(r) {
      const parts = [`curl -X ${r.method}`, `'${(r.url || '').replace(/'/g, "'\\''")}'`];
      for (const [k, v, on] of r.headers || []) if (on !== false && k) parts.push(`-H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
      if (r.body && r.bodyType !== 'none') parts.push(`--data '${r.body.replace(/'/g, "'\\''")}'`);
      return parts.join(' \\\n  ');
    }

    renderReqTabs(); renderReq(); renderRes(); renderSide(); win.setSub(req.url);
    return { serialize: () => ({ req: { ...req, url: url.value, auth: { ...req.auth, token: /\{\{/.test(req.auth.token || '') ? req.auth.token : '', pass: '' } } }), apply: (s) => { if (s.req) { req = { ...blank(), ...s.req }; method.value = req.method; url.value = req.url; renderReq(); } } };
  }
};

export function highlightJson(s) {
  return esc(s).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, kw, num) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (kw) return `<span class="j-kw">${kw}</span>`;
    if (num) return `<span class="j-num">${num}</span>`;
    return m;
  });
}
