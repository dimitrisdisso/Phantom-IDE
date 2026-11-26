'use strict';
// HTTP client for the API tester. Runs in the main process (no CORS), user-initiated only.
const MAX_BODY = 8 * 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

module.exports = (core) => {
  const inflight = new Map();
  return {
    'http:request': async (req = {}) => {
      const method = String(req.method || 'GET').toUpperCase();
      if (!METHODS.has(method)) throw new Error('Unsupported method');
      let url;
      try { url = new URL(req.url); } catch { throw new Error('Invalid URL'); }
      if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https are supported');
      const headers = {};
      for (const [k, v] of Object.entries(req.headers || {})) if (k && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) headers[k] = String(v);
      const ctrl = new AbortController();
      const id = req.id || Math.random().toString(36).slice(2);
      inflight.set(id, ctrl);
      const timeout = setTimeout(() => ctrl.abort(new Error('timeout')), Math.min(Number(req.timeoutMs) || 30000, 300000));
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method, headers, signal: ctrl.signal,
          body: method === 'GET' || method === 'HEAD' ? undefined : (req.body ?? undefined),
          redirect: req.followRedirects === false ? 'manual' : 'follow'
        });
        const ttfb = performance.now() - t0;
        const reader = res.body ? res.body.getReader() : null;
        const chunks = []; let size = 0; let truncated = false;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size <= MAX_BODY) chunks.push(value); else { truncated = true; }
          }
        }
        const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        const ctype = res.headers.get('content-type') || '';
        const textual = /json|text|xml|javascript|html|csv|yaml|graphql|x-www-form-urlencoded/i.test(ctype) || !ctype;
        const hdrs = []; res.headers.forEach((v, k) => hdrs.push([k, v]));
        core.event('NET', `${method} ${url.host}${url.pathname} → ${res.status} (${Math.round(performance.now() - t0)}ms)`);
        return {
          status: res.status, statusText: res.statusText, headers: hdrs, url: res.url, redirected: res.redirected,
          body: textual ? buf.toString('utf8') : null,
          base64: textual ? null : buf.toString('base64').slice(0, 2 * 1024 * 1024),
          contentType: ctype, size, truncated, timeMs: performance.now() - t0, ttfbMs: ttfb
        };
      } catch (e) {
        const cause = e.cause ? ` (${e.cause.code || e.cause.message})` : '';
        throw new Error((ctrl.signal.aborted ? 'Request aborted/timed out' : e.message) + cause);
      } finally {
        clearTimeout(timeout);
        inflight.delete(id);
      }
    },
    'http:cancel': async (id) => { const c = inflight.get(id); if (c) c.abort(); return !!c; }
  };
};
