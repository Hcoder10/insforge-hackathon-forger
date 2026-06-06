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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FORGE_OPT_URL = process.env.FORGE_OPT_URL;   // served model endpoint
const CODE_RE = /```(?:js|javascript)?\s*([\s\S]*?)```/i;

function extract(t) {
  const m = (t || '').match(CODE_RE);
  if (m) return m[1].trim();
  const i = (t || '').indexOf('async function solve');
  return i !== -1 ? t.slice(i).trim() : (t || '');
}

async function haikuAuthor(prompt) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json();
  return j.content?.[0]?.text || '';
}

async function forgeOptimize(prompt, naive) {
  const msg = prompt + `\n\nHere is an inefficient/incorrect solution — rewrite it correct and efficient:\n\`\`\`js\n${naive}\n\`\`\``;
  if (!FORGE_OPT_URL) {
    // graceful stub: return the naive unchanged-ish marker (UI still renders, grade reflects reality)
    return { code: naive, stub: true };
  }
  // OpenAI-compatible chat endpoint (vLLM/TGI/our served model)
  const res = await fetch(FORGE_OPT_URL.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'forge-optimizer', max_tokens: 1024, temperature: 0,
      messages: [{ role: 'user', content: msg }] }),
  });
  const j = await res.json();
  return { code: extract(j.choices?.[0]?.message?.content || ''), stub: false };
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
      const haikuRaw = await haikuAuthor(prompt);
      const haikuCode = extract(haikuRaw);
      const haikuGrade = await gradeOne(body.taskId, haikuCode);
      const { code: forgeCode, stub } = await forgeOptimize(prompt, haikuCode);
      const forgeGrade = await gradeOne(body.taskId, forgeCode);
      return send(res, 200, { task: { id: task.id, domain: task.domain, concept: task.concept },
        haiku: { code: haikuCode, grade: haikuGrade },
        forge: { code: forgeCode, grade: forgeGrade, stub } });
    }
    if (u.pathname === '/api/grade' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await gradeOne(body.taskId, body.code));
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
  console.log(`  haiku: ${ANTHROPIC_KEY ? 'configured' : 'NO ANTHROPIC_API_KEY'} | forge-opt: ${FORGE_OPT_URL || 'STUB (set FORGE_OPT_URL)'}`);
});
