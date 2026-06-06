// forger-bench — LIVE backend instrumentation. (docs/DESIGN.md §6)
//
// Wraps the REAL @insforge/sdk client so candidate code runs byte-identically against a
// live InsForge project, while we measure the TRUE cost at the HTTP layer:
//   - every request to the backend  -> one round-trip   (dbOps / storageOps / aiCalls ...)
//   - request body bytes            -> bytesWritten
//   - response body bytes           -> bytesRead
//   - PostgREST Content-Range count -> rowsReturned (when present)
//
// This is the audit ground-truth the mock's predicted costs are validated against.
// createLiveBackend({ baseUrl, anonKey }) -> { insforge, metrics, resetMetrics }

'use strict';

// @insforge/sdk ships ESM-only (its dep @insforge/shared-schemas has no CJS exports), so
// require() fails under CommonJS. Load it via dynamic import() instead — works from CJS.
let _createClient = null;
async function getCreateClient() {
  if (!_createClient) _createClient = (await import('@insforge/sdk')).createClient;
  return _createClient;
}

function freshMetrics() {
  return {
    dbOps: 0, bytesRead: 0, rowsReturned: 0, writes: 0, bytesWritten: 0,
    storageOps: 0, storageBytes: 0, aiCalls: 0, aiTokens: 0,
    realtimeMsgs: 0, fnInvocations: 0, authOps: 0,
    httpRequests: 0,             // raw fetch count (sum of all categories)
  };
}

// Classify a backend URL path into a cost category so live metrics line up with the mock.
function classify(urlPath) {
  if (urlPath.includes('/storage')) return 'storage';
  if (urlPath.includes('/ai/') || urlPath.includes('/embeddings') || urlPath.includes('/chat/completions')) return 'ai';
  if (urlPath.includes('/functions/')) return 'functions';
  if (urlPath.includes('/auth')) return 'auth';
  if (urlPath.includes('/realtime')) return 'realtime';
  // database: PostgREST tables + rpc
  return 'db';
}

async function createLiveBackend({ baseUrl, anonKey }) {
  const createClient = await getCreateClient();
  const metrics = freshMetrics();

  // A counting fetch: the SDK is given THIS instead of global fetch, so every backend
  // call is observed exactly once, at the transport boundary (the true round-trip).
  const instrumentedFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const cat = classify(url);

    metrics.httpRequests += 1;
    // request body size
    let reqBytes = 0;
    const body = init.body;
    if (typeof body === 'string') reqBytes = Buffer.byteLength(body, 'utf8');
    else if (body && body.byteLength != null) reqBytes = body.byteLength;
    if (reqBytes) metrics.bytesWritten += reqBytes;

    // category round-trip counters (mirror the mock's semantics)
    if (cat === 'db') metrics.dbOps += 1;
    else if (cat === 'storage') metrics.storageOps += 1;
    else if (cat === 'ai') metrics.aiCalls += 1;
    else if (cat === 'functions') metrics.fnInvocations += 1;
    else if (cat === 'auth') { metrics.authOps += 1; metrics.dbOps += 1; }
    else if (cat === 'realtime') metrics.realtimeMsgs += 1;
    if (method !== 'GET' && cat === 'db') metrics.writes += 1;

    const res = await fetch(input, init);

    // response body size (clone so the SDK can still read it)
    try {
      const clone = res.clone();
      const text = await clone.text();
      const respBytes = Buffer.byteLength(text, 'utf8');
      if (cat === 'storage' && method === 'GET') metrics.storageBytes += respBytes;
      else metrics.bytesRead += respBytes;
      // PostgREST exact count / row count
      const cr = res.headers.get('content-range'); // e.g. "0-9/57"
      if (cr && cr.includes('/')) {
        // rows returned = items in this page; try to parse the body array length
        try { const arr = JSON.parse(text); if (Array.isArray(arr)) metrics.rowsReturned += arr.length; } catch {}
      } else {
        try { const arr = JSON.parse(text); if (Array.isArray(arr)) metrics.rowsReturned += arr.length; } catch {}
      }
    } catch { /* non-text/streaming response: skip sizing */ }

    return res;
  };

  const insforge = createClient({ baseUrl, anonKey, fetch: instrumentedFetch });

  return {
    insforge,
    metrics,
    resetMetrics() { Object.assign(metrics, freshMetrics()); },
  };
}

module.exports = { createLiveBackend, freshMetrics };
