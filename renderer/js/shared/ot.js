/*
 * PHANTOM operational transformation engine (plain-text).
 * Loaded by the renderer as a classic script (window.PhantomOT) and by the main process via require().
 *
 * An operation is a list of components applied left-to-right over the document:
 *   positive integer  → retain n characters
 *   string            → insert the string
 *   negative integer  → delete n characters
 * transform(a, b) returns [a', b'] with apply(apply(S, a), b') === apply(apply(S, b), a').
 * On ties, a's inserts go first; the server and clients both pass the client op first, keeping order consistent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhantomOT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const isRetain = (c) => typeof c === 'number' && c > 0;
  const isInsert = (c) => typeof c === 'string';
  const isDelete = (c) => typeof c === 'number' && c < 0;

  class TextOperation {
    constructor() { this.ops = []; this.baseLength = 0; this.targetLength = 0; }

    retain(n) {
      if (!Number.isInteger(n) || n < 0) throw new Error('retain expects a non-negative integer');
      if (n === 0) return this;
      this.baseLength += n; this.targetLength += n;
      const last = this.ops.length - 1;
      if (isRetain(this.ops[last])) this.ops[last] += n; else this.ops.push(n);
      return this;
    }

    insert(str) {
      if (typeof str !== 'string') throw new Error('insert expects a string');
      if (str === '') return this;
      this.targetLength += str.length;
      const ops = this.ops; const n = ops.length;
      if (isInsert(ops[n - 1])) ops[n - 1] += str;
      else if (isDelete(ops[n - 1])) {
        // Keep the canonical form "insert before delete" so equal states compare equal.
        if (isInsert(ops[n - 2])) ops[n - 2] += str;
        else { ops[n] = ops[n - 1]; ops[n - 1] = str; }
      } else ops.push(str);
      return this;
    }

    delete(n) {
      if (typeof n === 'string') n = n.length;
      if (!Number.isInteger(n)) throw new Error('delete expects an integer');
      if (n === 0) return this;
      if (n > 0) n = -n;
      this.baseLength -= n;
      const last = this.ops.length - 1;
      if (isDelete(this.ops[last])) this.ops[last] += n; else this.ops.push(n);
      return this;
    }

    isNoop() { return this.ops.length === 0 || (this.ops.length === 1 && isRetain(this.ops[0])); }

    apply(str) {
      if (str.length !== this.baseLength) throw new Error(`operation base length ${this.baseLength} does not match document length ${str.length}`);
      const out = []; let i = 0;
      for (const c of this.ops) {
        if (isRetain(c)) { if (i + c > str.length) throw new Error('retain past end'); out.push(str.slice(i, i + c)); i += c; }
        else if (isInsert(c)) out.push(c);
        else i -= c;
      }
      if (i !== str.length) throw new Error('operation did not cover the whole document');
      return out.join('');
    }

    /** a.compose(b): one operation equivalent to applying a then b. */
    compose(op2) {
      if (this.targetLength !== op2.baseLength) throw new Error('compose: length mismatch');
      const op = new TextOperation();
      const o1 = this.ops; const o2 = op2.ops;
      let i1 = 0; let i2 = 0; let a = o1[i1++]; let b = o2[i2++];
      for (;;) {
        if (a === undefined && b === undefined) break;
        if (isDelete(a)) { op.delete(a); a = o1[i1++]; continue; }
        if (isInsert(b)) { op.insert(b); b = o2[i2++]; continue; }
        if (a === undefined) throw new Error('compose: first operation too short');
        if (b === undefined) throw new Error('compose: first operation too long');
        if (isRetain(a) && isRetain(b)) {
          if (a > b) { op.retain(b); a -= b; b = o2[i2++]; } else if (a === b) { op.retain(a); a = o1[i1++]; b = o2[i2++]; } else { op.retain(a); b -= a; a = o1[i1++]; }
        } else if (isInsert(a) && isDelete(b)) {
          if (a.length > -b) { a = a.slice(-b); b = o2[i2++]; } else if (a.length === -b) { a = o1[i1++]; b = o2[i2++]; } else { b += a.length; a = o1[i1++]; }
        } else if (isInsert(a) && isRetain(b)) {
          if (a.length > b) { op.insert(a.slice(0, b)); a = a.slice(b); b = o2[i2++]; } else if (a.length === b) { op.insert(a); a = o1[i1++]; b = o2[i2++]; } else { op.insert(a); b -= a.length; a = o1[i1++]; }
        } else if (isRetain(a) && isDelete(b)) {
          if (a > -b) { op.delete(b); a += b; b = o2[i2++]; } else if (a === -b) { op.delete(b); a = o1[i1++]; b = o2[i2++]; } else { op.delete(a); b += a; a = o1[i1++]; }
        } else throw new Error('compose: unexpected components');
      }
      return op;
    }

    static transform(op1, op2) {
      if (op1.baseLength !== op2.baseLength) throw new Error('transform: base length mismatch');
      const p1 = new TextOperation(); const p2 = new TextOperation();
      const o1 = op1.ops; const o2 = op2.ops;
      let i1 = 0; let i2 = 0; let a = o1[i1++]; let b = o2[i2++];
      for (;;) {
        if (a === undefined && b === undefined) break;
        if (isInsert(a)) { p1.insert(a); p2.retain(a.length); a = o1[i1++]; continue; }
        if (isInsert(b)) { p1.retain(b.length); p2.insert(b); b = o2[i2++]; continue; }
        if (a === undefined) throw new Error('transform: first operation too short');
        if (b === undefined) throw new Error('transform: first operation too long');
        let m;
        if (isRetain(a) && isRetain(b)) {
          if (a > b) { m = b; a -= b; b = o2[i2++]; } else if (a === b) { m = b; a = o1[i1++]; b = o2[i2++]; } else { m = a; b -= a; a = o1[i1++]; }
          p1.retain(m); p2.retain(m);
        } else if (isDelete(a) && isDelete(b)) {
          if (-a > -b) { a -= b; b = o2[i2++]; } else if (a === b) { a = o1[i1++]; b = o2[i2++]; } else { b -= a; a = o1[i1++]; }
        } else if (isDelete(a) && isRetain(b)) {
          if (-a > b) { m = b; a += b; b = o2[i2++]; } else if (-a === b) { m = b; a = o1[i1++]; b = o2[i2++]; } else { m = -a; b += a; a = o1[i1++]; }
          p1.delete(m);
        } else if (isRetain(a) && isDelete(b)) {
          if (a > -b) { m = -b; a += b; b = o2[i2++]; } else if (a === -b) { m = a; a = o1[i1++]; b = o2[i2++]; } else { m = a; b += a; a = o1[i1++]; }
          p2.delete(m);
        } else throw new Error('transform: unexpected components');
      }
      return [p1, p2];
    }

    /** Where does a caret at `index` end up after this operation? */
    transformIndex(index) {
      let newIndex = index; let rest = index;
      for (const c of this.ops) {
        if (isRetain(c)) rest -= c;
        else if (isInsert(c)) newIndex += c.length;
        else { newIndex -= Math.min(rest, -c); rest += c; }
        if (rest < 0) break;
      }
      return newIndex;
    }

    toJSON() { return this.ops; }

    static fromJSON(ops, maxLen = 20 * 1024 * 1024) {
      if (!Array.isArray(ops) || ops.length > 200000) throw new Error('invalid operation');
      const op = new TextOperation();
      for (const c of ops) {
        if (typeof c === 'string') { if (c.length > maxLen) throw new Error('insert too large'); op.insert(c); }
        else if (Number.isInteger(c) && c !== 0) { if (c > 0) op.retain(c); else op.delete(c); }
        else throw new Error('invalid operation component');
      }
      return op;
    }

    /** Operation turning oldText into newText (single contiguous change). */
    static fromDiff(oldText, newText) {
      let p = 0; const max = Math.min(oldText.length, newText.length);
      while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
      let s = 0;
      while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;
      return new TextOperation().retain(p).insert(newText.slice(p, newText.length - s)).delete(oldText.length - p - s).retain(s);
    }
  }

  /**
   * Client-side state machine (synchronized → awaiting confirm → awaiting with buffer).
   * `send(rev, op)` transmits to the server; `apply(op)` applies a remote op to the local document.
   */
  class OTClient {
    constructor(revision, send, apply) { this.revision = revision; this.outstanding = null; this.buffer = null; this.send = send; this.apply = apply; }
    applyClient(op) {
      if (!this.outstanding) { this.outstanding = op; this.send(this.revision, op); }
      else if (!this.buffer) this.buffer = op;
      else this.buffer = this.buffer.compose(op);
    }
    serverAck() {
      this.revision++;
      if (this.buffer) { this.outstanding = this.buffer; this.buffer = null; this.send(this.revision, this.outstanding); }
      else this.outstanding = null;
    }
    applyServer(op) {
      this.revision++;
      if (this.outstanding) {
        const [o, op1] = TextOperation.transform(this.outstanding, op);
        this.outstanding = o; op = op1;
        if (this.buffer) { const [b, op2] = TextOperation.transform(this.buffer, op); this.buffer = b; op = op2; }
      }
      this.apply(op);
      return op;
    }
    /** Transform a caret position received from the server so it matches the local document. */
    transformRemoteIndex(i) {
      if (this.outstanding) i = this.outstanding.transformIndex(i);
      if (this.buffer) i = this.buffer.transformIndex(i);
      return i;
    }
    get synced() { return !this.outstanding; }
  }

  /** Authoritative document held by the session host. */
  class OTServer {
    constructor(text) { this.text = text; this.history = []; }
    get revision() { return this.history.length; }
    receive(revision, op) {
      if (!Number.isInteger(revision) || revision < 0 || revision > this.history.length) throw new Error('revision out of range');
      for (const concurrent of this.history.slice(revision)) op = TextOperation.transform(op, concurrent)[0];
      this.text = op.apply(this.text);
      this.history.push(op);
      return op;
    }
  }

  return { TextOperation, OTClient, OTServer };
});
