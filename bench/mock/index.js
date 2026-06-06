// forger-bench — hermetic, instrumented in-process InsForge mock.
//
// Mirrors the real @insforge/sdk surface (database / auth / storage / ai / realtime /
// functions) closely enough to run candidate solutions, while COUNTING every backend
// interaction into a `metrics` object. The counts are the benchmark's cost signal
// (see docs/DESIGN.md §2). Deterministic: same code -> same metrics, no Docker.
//
// createBackend() -> { insforge, metrics, admin }
//   insforge : the SDK-shaped client a candidate solution uses
//   metrics  : the live cost counters (read after running)
//   admin    : test-harness helpers to seed tables/files/users (not billed)
//
// All SDK methods return { data, error } (real SDK contract). Database inserts require
// the array form. Only the shapes documented in the InsForge skill are implemented.

'use strict';

function freshMetrics() {
  return {
    dbOps: 0, bytesRead: 0, rowsScanned: 0, rowsReturned: 0,
    writes: 0, bytesWritten: 0,
    storageOps: 0, storageBytes: 0,
    aiCalls: 0, aiTokens: 0,
    realtimeMsgs: 0, fnInvocations: 0,
    authOps: 0,
  };
}

// Rough byte size of a JS value as it would cross the wire (JSON).
function wireBytes(value) {
  if (value === undefined || value === null) return 0;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return 0; }
}

// Project a row down to a set of columns ('*' or 'a, b, c' or 'a,b').
function projectRow(row, cols) {
  if (!cols || cols === '*') return { ...row };
  const keep = cols.split(',').map((c) => c.trim()).filter((c) => c && c !== '*');
  // relationship embeds like "comments(id)" are handled separately; ignore here
  const flat = keep.filter((c) => !c.includes('('));
  if (flat.length === 0) return { ...row };
  const out = {};
  for (const k of flat) if (k in row) out[k] = row[k];
  return out;
}

// Parse the relationship embeds out of a select string: "*, comments(id, body)".
function parseEmbeds(cols) {
  if (!cols) return [];
  const embeds = [];
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(cols)) !== null) {
    embeds.push({ table: m[1], cols: m[2].split(',').map((s) => s.trim()).filter(Boolean) });
  }
  return embeds;
}

const FILTER_OPS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  like: (a, b) => new RegExp('^' + String(b).replace(/%/g, '.*').replace(/_/g, '.') + '$').test(String(a)),
  ilike: (a, b) => new RegExp('^' + String(b).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(String(a)),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  is: (a, b) => a === b,
};

function createBackend() {
  const metrics = freshMetrics();
  const tables = new Map();   // name -> { rows: [], schema: {} }
  const buckets = new Map();  // name -> Map<key, { bytes, contentType, meta }>
  const users = new Map();    // id -> { id, email, password, profile }
  const fns = new Map();      // slug -> async (body, ctx) => any
  const realtimeChannels = new Set();
  let currentUserId = null;

  // ---- admin (harness-only; NOT counted) ----------------------------------
  const admin = {
    createTable(name, schema = {}) { tables.set(name, { rows: [], schema }); },
    seed(name, rows) {
      if (!tables.has(name)) tables.set(name, { rows: [], schema: {} });
      tables.get(name).rows.push(...rows.map((r) => ({ ...r })));
    },
    createBucket(name) { if (!buckets.has(name)) buckets.set(name, new Map()); },
    putFile(bucket, key, bytes, contentType = 'application/octet-stream', meta = {}) {
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      buckets.get(bucket).set(key, { bytes, contentType, meta });
    },
    createUser({ id, email, password, profile = {} }) {
      users.set(id, { id, email, password, profile: { ...profile } });
      return users.get(id);
    },
    setCurrentUser(id) { currentUserId = id; },
    registerFunction(slug, handler) { fns.set(slug, handler); },
    registerChannel(pattern) { realtimeChannels.add(pattern); },
    rawRows(name) { return (tables.get(name) || { rows: [] }).rows; },
  };

  // ---- database -----------------------------------------------------------
  function makeQuery(tableName) {
    const t = tables.get(tableName) || { rows: [], schema: {} };
    const state = {
      action: 'select', cols: '*', filters: [], orderBy: null,
      limitN: null, rangeFrom: null, rangeTo: null, countMode: null,
      head: false, single: false, maybeSingle: false,
      payload: null, returnSelect: false,
    };

    function applyFilters(rows) {
      let out = rows;
      for (const f of state.filters) {
        out = out.filter((r) => FILTER_OPS[f.op](r[f.col], f.val));
      }
      return out;
    }

    const builder = {
      // filters
      eq(c, v) { state.filters.push({ op: 'eq', col: c, val: v }); return builder; },
      neq(c, v) { state.filters.push({ op: 'neq', col: c, val: v }); return builder; },
      gt(c, v) { state.filters.push({ op: 'gt', col: c, val: v }); return builder; },
      gte(c, v) { state.filters.push({ op: 'gte', col: c, val: v }); return builder; },
      lt(c, v) { state.filters.push({ op: 'lt', col: c, val: v }); return builder; },
      lte(c, v) { state.filters.push({ op: 'lte', col: c, val: v }); return builder; },
      like(c, v) { state.filters.push({ op: 'like', col: c, val: v }); return builder; },
      ilike(c, v) { state.filters.push({ op: 'ilike', col: c, val: v }); return builder; },
      in(c, v) { state.filters.push({ op: 'in', col: c, val: v }); return builder; },
      is(c, v) { state.filters.push({ op: 'is', col: c, val: v }); return builder; },
      // modifiers
      order(c, opts = {}) { state.orderBy = { col: c, asc: opts.ascending !== false }; return builder; },
      limit(n) { state.limitN = n; return builder; },
      range(from, to) { state.rangeFrom = from; state.rangeTo = to; return builder; },
      single() { state.single = true; return builder; },
      maybeSingle() { state.maybeSingle = true; return builder; },
      // terminal-ish for writes: .select() makes a write return rows
      select(cols = '*', opts = {}) {
        if (state.action === 'select') { state.cols = cols; if (opts.count) state.countMode = opts.count; if (opts.head) state.head = true; }
        else { state.returnSelect = true; state.cols = cols; }
        return builder;
      },
      insert(rows) { state.action = 'insert'; state.payload = rows; return builder; },
      update(patch) { state.action = 'update'; state.payload = patch; return builder; },
      delete() { state.action = 'delete'; return builder; },
      // thenable: awaiting the builder executes it
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };

    function execute() {
      metrics.dbOps += 1;                            // one round-trip per awaited query
      if (state.action === 'select') {
        // full table is "scanned"; filters reduce what's returned
        metrics.rowsScanned += t.rows.length;
        let rows = applyFilters(t.rows);
        if (state.orderBy) {
          const { col, asc } = state.orderBy;
          rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
        }
        const total = rows.length;
        if (state.rangeFrom !== null) rows = rows.slice(state.rangeFrom, state.rangeTo + 1);
        if (state.limitN !== null) rows = rows.slice(0, state.limitN);

        const embeds = parseEmbeds(state.cols);
        let projected;
        if (state.head) {
          projected = [];                            // head:true -> no rows, count only
        } else {
          projected = rows.map((r) => {
            const base = projectRow(r, state.cols);
            for (const e of embeds) {                // naive embed: join child by <table>_id
              const child = tables.get(e.table);
              if (child) {
                const fk = tableName.replace(/s$/, '') + '_id';
                base[e.table] = child.rows
                  .filter((cr) => cr[fk] === r.id)
                  .map((cr) => projectRow(cr, e.cols.join(',')));
              }
            }
            return base;
          });
        }
        metrics.rowsReturned += projected.length;
        metrics.bytesRead += wireBytes(projected);
        const count = state.countMode ? total : undefined;
        if (state.single) {
          if (projected.length !== 1) return { data: null, error: { message: 'not single' } };
          return { data: projected[0], error: null, count };
        }
        if (state.maybeSingle) return { data: projected[0] ?? null, error: null, count };
        return { data: projected, error: null, count };
      }

      if (state.action === 'insert') {
        const arr = Array.isArray(state.payload) ? state.payload : null;
        if (!arr) return { data: null, error: { message: 'insert requires array form' } };
        const inserted = arr.map((r, i) => ({ id: r.id ?? `${tableName}_${t.rows.length + i + 1}`, ...r }));
        t.rows.push(...inserted.map((r) => ({ ...r })));
        metrics.writes += inserted.length;
        metrics.bytesWritten += wireBytes(inserted);
        if (state.returnSelect) {
          metrics.rowsReturned += inserted.length;
          metrics.bytesRead += wireBytes(inserted.map((r) => projectRow(r, state.cols)));
          return { data: inserted.map((r) => projectRow(r, state.cols)), error: null };
        }
        return { data: null, error: null };
      }

      if (state.action === 'update') {
        metrics.rowsScanned += t.rows.length;
        const matched = applyFilters(t.rows);
        for (const r of matched) Object.assign(r, state.payload);
        metrics.writes += matched.length;
        metrics.bytesWritten += wireBytes(state.payload) * Math.max(matched.length, 1);
        if (state.returnSelect) {
          metrics.bytesRead += wireBytes(matched.map((r) => projectRow(r, state.cols)));
          return { data: matched.map((r) => projectRow(r, state.cols)), error: null };
        }
        return { data: null, error: null };
      }

      if (state.action === 'delete') {
        metrics.rowsScanned += t.rows.length;
        const keep = [], removed = [];
        for (const r of t.rows) (applyFilters([r]).length ? removed : keep).push(r);
        t.rows.length = 0; t.rows.push(...keep);
        metrics.writes += removed.length;
        return { data: null, error: null };
      }
      return { data: null, error: { message: 'unknown action' } };
    }

    return builder;
  }

  const database = {
    from(name) { return makeQuery(name); },
    async rpc(fnName, args = {}) {
      metrics.dbOps += 1;                            // an RPC is one server round-trip
      const handler = rpcRegistry.get(fnName);
      if (!handler) return { data: null, error: { message: `no rpc ${fnName}` } };
      const data = await handler(args, { tables, metrics });
      metrics.bytesRead += wireBytes(data);
      metrics.rowsReturned += Array.isArray(data) ? data.length : 1;
      return { data, error: null };
    },
  };
  const rpcRegistry = new Map();
  admin.registerRpc = (name, handler) => rpcRegistry.set(name, handler);

  // ---- auth ---------------------------------------------------------------
  const auth = {
    async getCurrentUser() {
      metrics.authOps += 1; metrics.dbOps += 1;
      const u = currentUserId ? users.get(currentUserId) : null;
      return { data: { user: u ? { id: u.id, email: u.email } : null }, error: null };
    },
    async signInWithPassword({ email, password }) {
      metrics.authOps += 1; metrics.dbOps += 1;
      const u = [...users.values()].find((x) => x.email === email && x.password === password);
      if (!u) return { data: null, error: { message: 'invalid', statusCode: 401 } };
      currentUserId = u.id;
      return { data: { user: { id: u.id, email: u.email }, accessToken: 'tok' }, error: null };
    },
    async getProfile(id) {
      metrics.authOps += 1; metrics.dbOps += 1;
      const u = users.get(id);
      return { data: u ? u.profile : null, error: null };
    },
    uid() { return currentUserId; },
  };

  // ---- storage ------------------------------------------------------------
  function storageFrom(bucketName) {
    if (!buckets.has(bucketName)) buckets.set(bucketName, new Map());
    const bucket = buckets.get(bucketName);
    return {
      async upload(key, file) {
        metrics.storageOps += 1;
        const bytes = file?.size ?? file?.length ?? wireBytes(file);
        bucket.set(key, { bytes, contentType: file?.type || 'application/octet-stream', meta: {} });
        metrics.storageBytes += bytes; metrics.bytesWritten += bytes;
        return { data: { key, url: `mock://${bucketName}/${key}` }, error: null };
      },
      async uploadAuto(file) {
        const key = `auto-${bucket.size + 1}`;
        return this.upload(key, file);
      },
      async download(key) {
        metrics.storageOps += 1;
        const f = bucket.get(key);
        if (!f) return { data: null, error: { message: 'not found' } };
        metrics.storageBytes += f.bytes; metrics.bytesRead += f.bytes;  // full egress
        return { data: { size: f.bytes, type: f.contentType }, error: null };
      },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        metrics.storageOps += 1;                     // one batch op regardless of count
        for (const k of arr) bucket.delete(k);
        return { data: { removed: arr.length }, error: null };
      },
      async list(prefix = '') {
        metrics.storageOps += 1;
        const items = [...bucket.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, v]) => ({ key, size: v.bytes, contentType: v.contentType }));
        metrics.bytesRead += wireBytes(items);        // metadata only, not file bytes
        return { data: items, error: null };
      },
    };
  }

  // ---- ai -----------------------------------------------------------------
  const ai = {
    chat: { completions: { async create({ messages = [] }) {
      metrics.aiCalls += 1;
      const tok = messages.reduce((s, m) => s + Math.ceil((typeof m.content === 'string' ? m.content.length : wireBytes(m.content)) / 4), 0);
      metrics.aiTokens += tok + 16;
      return { choices: [{ message: { content: 'ok' } }] };
    } } },
    embeddings: { async create({ input }) {
      metrics.aiCalls += 1;                           // ONE call whether input is str or array
      const items = Array.isArray(input) ? input : [input];
      // Per-call request overhead (framing/instruction tokens) + content tokens. The fixed
      // overhead is what makes batching genuinely cheaper: 1 call of N vs N calls of 1.
      const CALL_OVERHEAD = 16;
      metrics.aiTokens += CALL_OVERHEAD + items.reduce((s, x) => s + Math.ceil(String(x).length / 4), 0);
      return { data: items.map(() => ({ embedding: new Array(8).fill(0.1) })) };
    } },
    images: { async generate({ prompt }) {
      metrics.aiCalls += 1; metrics.aiTokens += Math.ceil(String(prompt).length / 4);
      return { data: [{ b64_json: 'AAAA' }] };
    } },
  };

  // ---- realtime -----------------------------------------------------------
  const realtime = {
    isConnected: false,
    async connect() { this.isConnected = true; return { ok: true }; },
    async subscribe(channel) {
      return { ok: true, channel, presence: { members: [] } };
    },
    async publish(channel, event, payload) {
      metrics.realtimeMsgs += 1; metrics.bytesWritten += wireBytes(payload);
      return { ok: true };
    },
    on() {}, off() {}, once() {}, disconnect() { this.isConnected = false; },
  };

  // ---- functions ----------------------------------------------------------
  const functions = {
    async invoke(slug, { body } = {}) {
      metrics.fnInvocations += 1;
      const handler = fns.get(slug);
      if (!handler) return { data: null, error: { message: `no function ${slug}` } };
      const data = await handler(body, { database, metrics });
      return { data, error: null };
    },
  };

  const insforge = { database, auth, storage: { from: storageFrom }, ai, realtime, functions };
  return { insforge, metrics, admin };
}

module.exports = { createBackend, freshMetrics, wireBytes };
