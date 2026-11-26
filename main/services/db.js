'use strict';
// Database explorer drivers: SQLite (node:sqlite, falling back to sql.js), PostgreSQL (pg),
// MySQL/MariaDB (mysql2). Credentials live only in memory for the life of a connection.
const fs = require('fs');
const path = require('path');
const { abs } = require('../util');

const MAX_ROWS = 5000;

function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return v;
}

/** Split a SQL script into statements, respecting quotes and comments. */
function splitSql(sql) {
  const out = []; let cur = ''; let q = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]; const n = sql[i + 1];
    if (!q && c === '-' && n === '-') { const e = sql.indexOf('\n', i); cur += sql.slice(i, e < 0 ? sql.length : e); i = e < 0 ? sql.length : e - 1; continue; }
    if (!q && c === '/' && n === '*') { const e = sql.indexOf('*/', i + 2); cur += sql.slice(i, e < 0 ? sql.length : e + 2); i = e < 0 ? sql.length : e + 1; continue; }
    if (q) { cur += c; if (c === q) { if (n === q) { cur += n; i++; } else q = null; } continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const returnsRows = (s) => /^\s*(--[^\n]*\n\s*)*(select|pragma|with|explain|values|show|describe|desc)\b/i.test(s) || /\breturning\b/i.test(s);

let nodeSqlite = null;
try { nodeSqlite = require('node:sqlite'); } catch { /* not in this runtime */ }

async function openSqlite(file, readonly) {
  file = abs(file);
  if (!fs.existsSync(file) && readonly) throw new Error('File not found');
  if (nodeSqlite) {
    const db = new nodeSqlite.DatabaseSync(file, { readOnly: !!readonly });
    return {
      kind: 'sqlite', label: path.basename(file), engine: 'node:sqlite',
      async query(sql) {
        let last = { columns: [], rows: [], changes: null };
        for (const stmt of splitSql(sql)) {
          const st = db.prepare(stmt);
          if (returnsRows(stmt)) {
            const rows = st.all();
            const columns = rows.length ? Object.keys(rows[0]) : (typeof st.columns === 'function' ? st.columns().map((c) => c.name) : []);
            last = { columns, rows: rows.slice(0, MAX_ROWS).map((r) => columns.map((c) => cell(r[c]))), total: rows.length, changes: null };
          } else {
            const r = st.run();
            last = { columns: [], rows: [], changes: Number(r.changes), lastInsertId: cell(r.lastInsertRowid) };
          }
        }
        return last;
      },
      async close() { db.close(); }
    };
  }
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  const data = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const db = new SQL.Database(data);
  let dirty = false;
  return {
    kind: 'sqlite', label: path.basename(file), engine: 'sql.js',
    async query(sql) {
      const res = db.exec(sql);
      const mod = db.getRowsModified();
      if (mod > 0 && !readonly) { dirty = true; fs.writeFileSync(file, Buffer.from(db.export())); dirty = false; }
      const lastRes = res[res.length - 1];
      if (!lastRes) return { columns: [], rows: [], changes: mod };
      return { columns: lastRes.columns, rows: lastRes.values.slice(0, MAX_ROWS).map((r) => r.map(cell)), total: lastRes.values.length, changes: null };
    },
    async close() { if (dirty) fs.writeFileSync(file, Buffer.from(db.export())); db.close(); }
  };
}

async function openPostgres(cfg) {
  const { Client } = require('pg');
  const client = new Client({ host: cfg.host || '127.0.0.1', port: Number(cfg.port) || 5432, user: cfg.user, password: cfg.password, database: cfg.database, ssl: cfg.ssl ? { rejectUnauthorized: cfg.sslVerify !== false } : undefined, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  await client.connect();
  return {
    kind: 'postgres', label: `${cfg.user || ''}@${cfg.host || 'localhost'}/${cfg.database || ''}`, engine: 'pg',
    async query(sql) {
      const r = await client.query({ text: sql, rowMode: 'array' });
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      const columns = (last.fields || []).map((f) => f.name);
      return { columns, rows: (last.rows || []).slice(0, MAX_ROWS).map((row) => row.map(cell)), total: (last.rows || []).length, changes: last.command !== 'SELECT' ? last.rowCount : null, command: last.command };
    },
    async close() { await client.end(); }
  };
}

async function openMysql(cfg) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: cfg.host || '127.0.0.1', port: Number(cfg.port) || 3306, user: cfg.user, password: cfg.password, database: cfg.database, connectTimeout: 8000, multipleStatements: false, rowsAsArray: true, ssl: cfg.ssl ? {} : undefined });
  return {
    kind: 'mysql', label: `${cfg.user || ''}@${cfg.host || 'localhost'}/${cfg.database || ''}`, engine: 'mysql2',
    async query(sql) {
      let last = { columns: [], rows: [] };
      for (const stmt of splitSql(sql)) {
        const [rows, fields] = await conn.query(stmt);
        if (Array.isArray(rows)) last = { columns: (fields || []).map((f) => f.name), rows: rows.slice(0, MAX_ROWS).map((r) => r.map(cell)), total: rows.length, changes: null };
        else last = { columns: [], rows: [], changes: rows.affectedRows, lastInsertId: rows.insertId };
      }
      return last;
    },
    async close() { await conn.end(); }
  };
}

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

module.exports = (core) => {
  const conns = new Map();
  let next = 1;
  core.onShutdown(async () => { for (const c of conns.values()) await c.close().catch(() => {}); });
  const get = (id) => { const c = conns.get(id); if (!c) throw new Error('Connection closed'); return c; };

  return {
    'db:connect': async (cfg = {}) => {
      let c;
      if (cfg.type === 'sqlite') c = await openSqlite(cfg.file, cfg.readonly);
      else if (cfg.type === 'postgres') c = await openPostgres(cfg);
      else if (cfg.type === 'mysql') c = await openMysql(cfg);
      else throw new Error('Unknown database type');
      const id = next++;
      conns.set(id, c);
      core.event('DB', `connected ${c.kind} ${c.label} via ${c.engine}`);
      return { id, kind: c.kind, label: c.label, engine: c.engine };
    },
    'db:tables': async (id) => {
      const c = get(id);
      let r;
      if (c.kind === 'sqlite') r = await c.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
      else if (c.kind === 'postgres') r = await c.query("SELECT CASE WHEN table_schema='public' THEN table_name ELSE table_schema||'.'||table_name END, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 2,1");
      else r = await c.query('SHOW FULL TABLES');
      return r.rows.map((row) => ({ name: row[0], type: String(row[1] || 'table').toLowerCase().includes('view') ? 'view' : 'table' }));
    },
    'db:columns': async (id, table) => {
      const c = get(id);
      if (c.kind === 'sqlite') {
        const r = await c.query(`PRAGMA table_info(${q(table)})`);
        return r.rows.map((x) => ({ name: x[1], type: x[2], nullable: !x[3], pk: !!x[5], default: x[4] }));
      }
      if (c.kind === 'postgres') {
        const [schema, name] = table.includes('.') ? table.split('.') : ['public', table];
        const r = await c.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='${schema.replace(/'/g, "''")}' AND table_name='${name.replace(/'/g, "''")}' ORDER BY ordinal_position`);
        return r.rows.map((x) => ({ name: x[0], type: x[1], nullable: x[2] === 'YES', default: x[3] }));
      }
      const r = await c.query('SHOW COLUMNS FROM `' + String(table).replace(/`/g, '``') + '`');
      return r.rows.map((x) => ({ name: x[0], type: x[1], nullable: x[2] === 'YES', pk: x[3] === 'PRI', default: x[4] }));
    },
    'db:selectSql': async (id, table, limit = 200) => {
      const c = get(id);
      const ident = c.kind === 'mysql' ? '`' + table.replace(/`/g, '``') + '`' : table.split('.').map(q).join('.');
      return `SELECT * FROM ${ident} LIMIT ${Math.max(1, Math.min(MAX_ROWS, limit | 0))};`;
    },
    'db:query': async (id, sql) => {
      if (typeof sql !== 'string' || !sql.trim()) throw new Error('Empty query');
      const t0 = Date.now();
      const r = await get(id).query(sql);
      return { ...r, ms: Date.now() - t0, capped: (r.total || 0) > MAX_ROWS };
    },
    'db:close': async (id) => { const c = conns.get(id); if (c) { await c.close(); conns.delete(id); } return true; }
  };
};
module.exports.splitSql = splitSql;
