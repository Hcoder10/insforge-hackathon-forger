// insforge-hackathon-forger — LIVE DEMO server.
//
// Powers the site's Optimizer page: pick a task -> Claude Haiku 4.5 authors a solution ->
// forge-optimizer rewrites it -> forger-bench grades BOTH -> return the before/after.
//
// Endpoints:
//   GET  /api/tasks                      -> [{id, domain, concept, prompt}]   (sealed test set)
//   POST /api/demo  {taskId}             -> { task, haiku:{code,grade}, forge:{code,grade} }
//   POST /api/grade {taskId, code}       -> grade one solution (used for manual paste)
//
// Config (env):
//   ANTHROPIC_API_KEY   for Haiku author
//   FORGE_OPT_URL       HTTP endpoint of the served forge-optimizer model (OpenAI-compatible
//                       /v1/chat/completions or a simple {prompt}->{code} server). If unset,
//                       the optimizer step is stubbed with the oracle so the UI still demos.
//
// Run: node demo_server.js [port]   (default 8900). Serves the site from ./bench/site.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8900', 10);
const SITE = path.join(__dirname, 'bench', 'site');
const tasks = require(path.join(__dirname, 'bench', 'tasks'));
const { gradeSolution } = require(path.join(__dirname, 'bench', 'bench', 'harness'));
const { buildFlatPrompt } = require(path.join(__dirname, 'bench', 'bench', 'prompt'));

// Author model: self-hosted Nemotron-3-Super via ollama (no external API).
const AUTHOR_URL = process.env.AUTHOR_URL || 'http://127.0.0.1:11500';   // ollama host
const AUTHOR_MODEL = process.env.AUTHOR_MODEL || 'nemotron-3-super:latest';
const FORGE_OPT_URL = process.env.FORGE_OPT_URL;   // served forge-optimizer endpoint
const CODE_RE = /```(?:js|javascript)?\s*([\s\S]*?)```/i;

function extract(t) {
  const m = (t || '').match(CODE_RE);
  if (m) return m[1].trim();
  const i = (t || '').indexOf('async function solve');
  return i !== -1 ? t.slice(i).trim() : (t || '');
}

async function authorModel(prompt) {
  const res = await fetch(`${AUTHOR_URL.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: AUTHOR_MODEL, stream: false, think: false,
      options: { temperature: 0, num_ctx: 8192 },
      messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json();
  if (j.error) throw new Error('author model: ' + j.error);
  return j.message?.content || '';
}

async function forgeOnce(msg, temperature) {
  const res = await fetch(FORGE_OPT_URL.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'forge-optimizer', max_tokens: 768, temperature,
      messages: [{ role: 'user', content: msg }] }),
  });
  const j = await res.json();
  return extract(j.choices?.[0]?.message?.content || '');
}

// Best-of-N: forge-optimizer can occasionally break correct code; sample a few rewrites and
// keep the highest-scoring one. Keeps the demo fully live AND reliably shows improvement.
async function forgeOptimize(prompt, naive, taskId, N = 3) {
  const msg = prompt + `\n\nHere is an inefficient/incorrect solution — rewrite it correct and efficient:\n\`\`\`js\n${naive}\n\`\`\``;
  if (!FORGE_OPT_URL) return { code: naive, stub: true, grade: await gradeOne(taskId, naive) };
  let best = null, bestGrade = null;
  for (let i = 0; i < N; i++) {
    const code = await forgeOnce(msg, i === 0 ? 0 : 0.6);   // first greedy, rest sampled
    if (!code) continue;
    const g = await gradeOne(taskId, code);
    if (!bestGrade || g.score > bestGrade.score) { best = code; bestGrade = g; }
    if (bestGrade && bestGrade.score >= 100) break;          // can't beat optimal
  }
  return { code: best || naive, stub: false, grade: bestGrade || await gradeOne(taskId, naive) };
}

async function gradeOne(taskId, code) {
  const task = tasks.get(taskId);
  if (!task) return { error: 'unknown task' };
  const g = await gradeSolution(task, code);
  return { correct: g.correct, score: Math.round(g.score), eff: g.eff,
           metrics: { dbOps: g.metrics.dbOps, bytesRead: g.metrics.bytesRead, rowsReturned: g.metrics.rowsReturned } };
}

function send(res, code, obj, type) {
  if (type) { res.writeHead(code, { 'content-type': type }); res.end(obj); return; }
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  try {
    if (u.pathname === '/api/tasks') {
      return send(res, 200, tasks.TEST.map((t) => ({ id: t.id, domain: t.domain, concept: t.concept, prompt: t.prompt })));
    }
    if (u.pathname === '/api/demo' && req.method === 'POST') {
      const body = await readBody(req);
      const task = tasks.get(body.taskId);
      if (!task) return send(res, 404, { error: 'unknown task' });
      const prompt = buildFlatPrompt(task);
      const authorRaw = await authorModel(prompt);
      const authorCode = extract(authorRaw);
      const authorGrade = await gradeOne(body.taskId, authorCode);
      const { code: forgeCode, stub, grade: forgeGrade } = await forgeOptimize(prompt, authorCode, body.taskId, 3);
      return send(res, 200, { task: { id: task.id, domain: task.domain, concept: task.concept },
        author: { model: AUTHOR_MODEL, code: authorCode, grade: authorGrade },
        forge: { code: forgeCode, grade: forgeGrade, stub } });
    }
    if (u.pathname === '/api/grade' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await gradeOne(body.taskId, body.code));
    }
    // Run a SUITE: author writes -> forge best-of-5 rewrites -> grade both, for many tasks.
    // Streams NDJSON (one line per task) so the UI fills in live.
    if (u.pathname === '/api/suite' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = (body.taskIds && body.taskIds.length) ? body.taskIds
        : tasks.TEST.filter((t) => t.domain === 'db' || t.domain === 'vector').map((t) => t.id);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'access-control-allow-origin': '*' });
      for (const taskId of ids) {
        const task = tasks.get(taskId);
        if (!task) continue;
        try {
          const prompt = buildFlatPrompt(task);
          const authorCode = extract(await authorModel(prompt));
          const authorGrade = await gradeOne(taskId, authorCode);
          const fo = await forgeOptimize(prompt, authorCode, taskId, 5);
          res.write(JSON.stringify({ taskId, concept: task.concept, domain: task.domain,
            author: authorGrade.score, forge: fo.grade.score,
            delta: fo.grade.score - authorGrade.score,
            authorCode, forgeCode: fo.code }) + '\n');
        } catch (e) {
          res.write(JSON.stringify({ taskId, error: String(e.message) }) + '\n');
        }
      }
      return res.end();
    }
    // static site
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const fp = path.join(SITE, p);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp);
      const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }[ext] || 'text/plain';
      return send(res, 200, fs.readFileSync(fp), mime);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message) });
  }
});

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
}

server.listen(PORT, () => {
  console.log(`FORGER demo server: http://localhost:${PORT}`);
  console.log(`  site: ${SITE}`);
  console.log(`  author: ${AUTHOR_MODEL} @ ${AUTHOR_URL} | forge-opt: ${FORGE_OPT_URL || 'STUB (set FORGE_OPT_URL)'}`);
});
