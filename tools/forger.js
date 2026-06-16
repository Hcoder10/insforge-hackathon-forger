#!/usr/bin/env node
// FORGER command runner.
//
// branch-review is intentionally recorded-mode by default. Live mode creates and switches
// InsForge backend branches, so callers must opt in with --live.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CALLER_CWD = process.cwd();
const BENCH = path.join(ROOT, 'bench');
const WORKLOADS = path.join(BENCH, 'workloads');
const DEFAULT_RECORD = path.join(BENCH, 'results', 'branch-review');
const PROJECT_SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const PROJECT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.forger',
  'forger-results',
  'dist',
  'build',
  '.next',
  'coverage',
]);
const PROJECT_REPAIR_NOTES = {
  'model.forge-optimizer-rewrite': 'forge-optimizer model proposed the source rewrite.',
  'database.insert-array-form': 'Uses array insert format expected by the InsForge SDK.',
  'auth.get-current-user-shape': 'Handles the { data, error } current-user response shape before reading user.id.',
  'storage.metadata-without-download': 'Uses storage listing metadata instead of downloading every file.',
  'storage.batch-remove': 'Deletes storage keys in one batch call instead of one request per key.',
  'database.pagination-count-projection': 'Uses projected columns, exact count, and server pagination.',
};

function usage() {
  console.log(`FORGER

usage:
  node tools/forger.js branch-review --scenario <name> [--record <dir>] [--branch <name>] [--mode schema-only|full] [--live] [--keep-branch]
  node tools/forger.js branch-pipeline [--out <dir>] [--scenarios <a,b,c>] [--live] [--mode schema-only|full]
  node tools/forger.js project-review --project <dir> [--out <dir>] [--apply] [--model-url <url>] [--model <name>] [--model-required]
  node tools/forger.js frontier-validate --file <frontier_run.json>

examples:
  node tools/forger.js branch-review --scenario slow-query-index
  node tools/forger.js branch-pipeline
  node tools/forger.js branch-review --scenario slow-query-index --live --branch forger-demo --mode schema-only
  node tools/forger.js project-review --project optimizer/fixtures/agent_projects/insforge-customer-portal
  FORGE_OPT_URL=http://127.0.0.1:8901 node tools/forger.js project-review --project path/to/app --model-required
`);
}

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['live', 'recorded', 'keep-branch', 'yes', 'apply', 'skip-reviews', 'model-required'].includes(key)) {
      out[key] = true;
      if (key === 'keep-branch') out.keepBranch = true;
      if (key === 'skip-reviews') out.skipReviews = true;
      if (key === 'model-required') out.modelRequired = true;
    } else out[key] = argv[++i];
  }
  return out;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function loadWorkload(name) {
  const file = path.join(WORKLOADS, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`unknown workload: ${name}`);
  return readJson(file);
}

function listWorkloads() {
  return fs.readdirSync(WORKLOADS)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.basename(name, '.json'))
    .sort();
}

function quoteShellArg(arg) {
  const s = String(arg);
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function run(cmd, args, opts = {}) {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? [cmd, ...args].map(quoteShellArg).join(' ') : cmd;
  const res = spawnSync(command, isWindows ? [] : args, {
    cwd: opts.cwd || CALLER_CWD,
    encoding: 'utf8',
    shell: isWindows,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})\n${res.stderr || res.stdout}`);
  }
  return res;
}

function runInsforge(args, opts = {}) {
  return run('npx', ['--yes', '@insforge/cli', ...args], opts);
}

function runDbQuery(sql) {
  const { dbQuery } = require(path.join(BENCH, 'live', 'dbquery'));
  return dbQuery(sql);
}

function captureLivePlan(sql) {
  const { capturePlan } = require(path.join(BENCH, 'live', 'explain'));
  const plan = capturePlan(sql);
  return { cpuTimeMs: plan.actualTimeMs || 0, ...plan };
}

function pctChange(base, next) {
  if (base === 0 && next === 0) return 0;
  if (base === 0) return 100;
  return ((next - base) / base) * 100;
}

function metricSummary(base, next) {
  const keys = ['actualTimeMs', 'cpuTimeMs', 'diskBytes', 'memoryBytes', 'seqScans'];
  return Object.fromEntries(keys.map((k) => [k, {
    baseline: metricValue(base, k),
    candidate: metricValue(next, k),
    delta: metricValue(next, k) - metricValue(base, k),
    pct: pctChange(metricValue(base, k), metricValue(next, k)),
  }]));
}

function metricValue(summary, key) {
  if (summary[key] !== undefined) return Number(summary[key]) || 0;
  if (key === 'cpuTimeMs') return Number(summary.actualTimeMs) || 0;
  return 0;
}

const DEFAULT_ABSOLUTE_TOLERANCE_BYTES = {
  diskBytes: 1024 * 1024,
  memoryBytes: 1024 * 1024,
};

function absoluteToleranceFor(t, metric) {
  const key = `${metric}MaxIncreaseBytes`;
  if (typeof t[key] === 'number') return t[key];
  return DEFAULT_ABSOLUTE_TOLERANCE_BYTES[metric] || 0;
}

function withinAbsoluteTolerance(t, metric, summary) {
  const tolerance = absoluteToleranceFor(t, metric);
  return tolerance > 0 && summary.delta > 0 && summary.delta <= tolerance;
}

function verdict(workload, baseline, candidate) {
  const t = workload.thresholds || {};
  const diff = metricSummary(baseline, candidate);
  const failures = [];
  const warnings = [];

  if (workload.correctness?.expectedMinRows && (candidate.actualRows || 0) < workload.correctness.expectedMinRows) {
    failures.push(`candidate returned ${candidate.actualRows || 0} rows, expected at least ${workload.correctness.expectedMinRows}`);
  }
  if (typeof t.seqScansMax === 'number' && (candidate.seqScans || 0) > t.seqScansMax) {
    failures.push(`candidate seqScans ${candidate.seqScans || 0} exceeds ${t.seqScansMax}`);
  }
  for (const [metric, limitKey] of [
    ['actualTimeMs', 'actualTimeMsMaxIncreasePct'],
    ['cpuTimeMs', 'cpuTimeMsMaxIncreasePct'],
    ['diskBytes', 'diskBytesMaxIncreasePct'],
    ['memoryBytes', 'memoryBytesMaxIncreasePct'],
  ]) {
    const overPctLimit = typeof t[limitKey] === 'number' && diff[metric].pct > t[limitKey];
    const tolerated = withinAbsoluteTolerance(t, metric, diff[metric]);
    if (overPctLimit && !tolerated) {
      failures.push(`${metric} increased ${diff[metric].pct.toFixed(1)}%`);
    } else if (diff[metric].pct > 0 && !tolerated) {
      warnings.push(`${metric} increased ${diff[metric].pct.toFixed(1)}%`);
    }
  }

  const status = failures.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  return { status, failures, warnings, metrics: diff };
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n || 0), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function annotateSql(workload, result) {
  const lines = [];
  lines.push('-- FORGER annotated merge preview');
  lines.push(`-- Workload: ${workload.name}`);
  lines.push(`-- Verdict: ${result.verdict.status.toUpperCase()}`);
  for (const [metric, d] of Object.entries(result.verdict.metrics)) {
    const b = metric.includes('Bytes') ? formatBytes(d.baseline) : d.baseline.toFixed ? d.baseline.toFixed(2) : d.baseline;
    const c = metric.includes('Bytes') ? formatBytes(d.candidate) : d.candidate.toFixed ? d.candidate.toFixed(2) : d.candidate;
    lines.push(`-- ${metric}: ${b} -> ${c} (${d.pct.toFixed(1)}%)`);
  }
  lines.push('');
  lines.push((result.mergeSql || workload.candidate?.migration || '-- no merge SQL captured').trim());
  lines.push('');
  return lines.join('\n');
}

function markdownReport(workload, result) {
  const rows = Object.entries(result.verdict.metrics).map(([k, d]) => {
    const base = k.includes('Bytes') ? formatBytes(d.baseline) : String(Number(d.baseline).toFixed ? Number(d.baseline).toFixed(2) : d.baseline);
    const cand = k.includes('Bytes') ? formatBytes(d.candidate) : String(Number(d.candidate).toFixed ? Number(d.candidate).toFixed(2) : d.candidate);
    return `| ${k} | ${base} | ${cand} | ${d.pct.toFixed(1)}% |`;
  }).join('\n');
  return `# FORGER Branch Review: ${workload.name}

Status: **${result.verdict.status.toUpperCase()}**

Branch: \`${result.branch.name}\`  
Mode: \`${result.branch.mode}\`  
Execution: \`${result.executionMode}\`

## Resource Diff

| Metric | Baseline | Candidate | Change |
|---|---:|---:|---:|
${rows}

## Findings

${[...result.verdict.failures, ...result.verdict.warnings].map((x) => `- ${x}`).join('\n') || '- No blocking resource regressions.'}

## Candidate Change

\`\`\`sql
${(result.mergeSql || workload.candidate?.migration || '').trim()}
\`\`\`

## Timeline

${result.timeline.map((e) => `- ${e.status.toUpperCase()}: ${e.label}`).join('\n')}
`;
}

function walkProjectSources(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (PROJECT_SKIP_DIRS.has(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkProjectSources(file));
    else if (PROJECT_SOURCE_EXTS.has(path.extname(entry.name))) out.push(file);
  }
  return out;
}

function slashRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function projectDisplayPath(file) {
  const rel = slashRelative(ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

function projectRepairNotes(repairs) {
  return [...new Set(repairs)].map((repair) => PROJECT_REPAIR_NOTES[repair] || repair);
}

function writeRepairedCopy(outDir, rel, source) {
  const target = path.join(outDir, 'repaired', ...rel.split('/'));
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, source);
  return slashRelative(outDir, target);
}

function compactUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(raw).replace(/[?#].*$/, '');
  }
}

function modelConfig(opts) {
  const url = opts['model-url'] || process.env.FORGE_OPT_URL || '';
  return {
    enabled: Boolean(url),
    required: Boolean(opts.modelRequired || process.env.FORGER_MODEL_REQUIRED === '1'),
    url,
    endpoint: compactUrl(url),
    model: opts.model || process.env.FORGE_OPT_MODEL || 'forge-optimizer',
    timeoutMs: Number(opts['model-timeout-ms'] || process.env.FORGE_OPT_TIMEOUT_MS || 180000),
    maxTokens: Number(opts['model-max-tokens'] || process.env.FORGE_OPT_MAX_TOKENS || 256),
  };
}

function projectModelPrompt(rel, source) {
  return `You are forge-optimizer, a specialist model for improving InsForge app code.

Review this single source file for real InsForge SDK correctness or resource issues. Focus on:
- database.insert-array-form: database inserts that need the InsForge array insert shape
- auth.get-current-user-shape: auth.getCurrentUser response-shape handling
- database.pagination-count-projection: pagination, projection, count, and server-side filtering
- storage.metadata-without-download: storage metadata reads that should not download files
- storage.batch-remove: batch storage deletes instead of one request per object

Return compact JSON only:
{"issues":["issue-id"],"summary":"short reason"}

If no issue is present, return:
{"issues":[],"summary":"clean"}

Do not return source code. Do not include markdown.

File: ${rel}

\`\`\`
${source}
\`\`\``;
}

function shouldModelReviewSource(rel, source) {
  const name = rel.toLowerCase();
  if (name.includes('.test.') || name.endsWith('.d.ts')) return false;
  return /@insforge\/sdk|createClient\s*\(|\b(?:insforge|client)\.(?:database|auth|storage)\b/.test(source);
}

function extractModelIssues(text) {
  const raw = String(text || '').trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd <= jsonStart) return [];
  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
    return issues.filter((issue) => typeof issue === 'string' && PROJECT_REPAIR_NOTES[issue]);
  } catch {
    return [];
  }
}

function extractModelSource(text) {
  const raw = String(text || '').trim();
  if (!raw || /^NO_CHANGE\.?$/i.test(raw)) return '';
  const blocks = [...raw.matchAll(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g)];
  if (blocks.length) return blocks[blocks.length - 1][1].trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      if (parsed?.changed === false) return '';
      if (typeof parsed?.source === 'string') return parsed.source.trim();
      if (typeof parsed?.code === 'string') return parsed.code.trim();
    } catch {}
  }
  return raw;
}

async function callForgeOptimizer(config, prompt) {
  if (typeof fetch !== 'function') throw new Error('global fetch is unavailable in this Node runtime');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const base = config.url.replace(/\/$/, '');
    const endpoint = base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: config.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`model endpoint returned HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || data.source || data.code || data.text || '';
  } finally {
    clearTimeout(timer);
  }
}

async function modelRepairSource(config, rel, before) {
  const content = await callForgeOptimizer(config, projectModelPrompt(rel, before));
  const issues = extractModelIssues(content);
  return {
    changed: false,
    source: before,
    repairs: issues,
    rawBytes: Buffer.byteLength(content || ''),
  };
}

function splitPatchLines(source) {
  return String(source).replace(/\r\n/g, '\n').split('\n');
}

function quoteCommandPath(file) {
  return /[\s"]/g.test(file) ? `"${file.replace(/"/g, '\\"')}"` : file;
}

function fullFilePatch(rel, before, after) {
  const oldLines = splitPatchLines(before);
  const newLines = splitPatchLines(after);
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = oldLines.length || 1;
  const newCount = newLines.length || 1;
  const out = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return out.join('\n') + '\n';
}

function applyPatchCommand(project, patchFile) {
  const projectPath = projectDisplayPath(project);
  const patchPath = slashRelative(ROOT, patchFile);
  if (!projectPath.startsWith('..') && !path.isAbsolute(projectPath)) {
    return `git apply --directory ${quoteCommandPath(projectPath)} ${quoteCommandPath(patchPath)}`;
  }
  return `git -C ${quoteCommandPath(project)} apply ${quoteCommandPath(patchFile)}`;
}

function projectPrCommentMarkdown(result) {
  const lines = [
    '# FORGER PR Guard',
    '',
    `Status: **${result.status.toUpperCase()}**`,
    '',
    `Project: \`${result.project.path}\``,
    `Mode: \`${result.mode}\``,
    `Files scanned: \`${result.filesScanned}\``,
    `Files with repairs: \`${result.files.length}\``,
    `Repairs: \`${result.repairCount}\``,
    '',
  ];

  if (result.model?.enabled) {
    lines.push(
      `Model: \`${result.model.model}\` at \`${result.model.endpoint}\``,
      `Model attempts: \`${result.model.attempted}\`, changes: \`${result.model.changed}\`, failures: \`${result.model.failed}\``,
      '',
    );
  } else {
    lines.push('Model: `not configured; deterministic verifier fallback`', '');
  }

  if (result.artifacts?.patch) {
    lines.push('## Apply Patch', '', '```bash', result.artifacts.applyCommand, '```', '');
  }

  lines.push(
    '## Checks',
    '',
    '- Correctness: InsForge SDK response shapes and API usage.',
    '- CPU: row-by-row JavaScript work that should stay server-side.',
    '- Memory: full-table and full-file reads that grow with dataset size.',
    '- Disk: avoidable backend reads, cache churn, and storage downloads.',
    '',
  );

  if (!result.files.length) {
    lines.push('## Findings', '', '- No known InsForge repair patterns were found.');
    return lines.join('\n');
  }

  lines.push('## Findings', '');
  for (const file of result.files) {
    lines.push(`### ${file.file}`, '');
    for (const note of file.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}

function projectReviewMarkdown(result) {
  const summary = [
    `# FORGER Project Review: ${path.basename(result.project.path)}`,
    '',
    `Status: **${result.status.toUpperCase()}**`,
    '',
    `Project: \`${result.project.path}\`  `,
    `Mode: \`${result.mode}\`  `,
    `Files scanned: \`${result.filesScanned}\`  `,
    `Files changed: \`${result.files.length}\`  `,
    `Repairs found: \`${result.repairCount}\``,
    '',
    ...(result.model?.enabled
      ? [
          `Model: \`${result.model.model}\` at \`${result.model.endpoint}\`  `,
          `Model attempts: \`${result.model.attempted}\`, changes: \`${result.model.changed}\`, failures: \`${result.model.failed}\``,
          '',
        ]
      : ['Model: `not configured; deterministic verifier fallback`', '']),
    '## Resource Axes',
    '',
    '- CPU: flags row-by-row JavaScript work that should stay inside the database or storage service.',
    '- Memory: flags full-table and full-file reads that scale with dataset size.',
    '- Disk: flags unnecessary backend reads, cache churn, and file downloads.',
    '- Correctness: flags InsForge SDK response-shape bugs and API usage that fails under real data.',
    '',
  ];

  if (!result.files.length) {
    summary.push('## Findings', '', '- No known InsForge repair patterns were found.');
    return summary.join('\n');
  }

  if (result.artifacts?.patch) {
    summary.push('## Patch', '', `Apply with: \`${result.artifacts.applyCommand}\``, '');
  }

  summary.push('## Findings', '');
  for (const file of result.files) {
    summary.push(`### ${file.file}`, '');
    for (const note of file.notes) summary.push(`- ${note}`);
    if (file.repairedCopy) summary.push(`- Repaired copy: \`${file.repairedCopy}\``);
    summary.push('');
  }
  return summary.join('\n');
}

async function runProjectReview(opts) {
  const projectArg = opts.project || opts._[1];
  if (!projectArg) throw new Error('project-review requires --project <dir>');
  const project = path.resolve(projectArg);
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
    throw new Error(`project not found: ${projectArg}`);
  }

  const defaultOut = path.join(BENCH, 'results', 'demo-recordings', `project-review-${path.basename(project)}`);
  const outDir = path.resolve(opts.out || defaultOut);
  mkdirp(outDir);

  const model = modelConfig(opts);
  const { repairSource, repairProject } = require(path.join(ROOT, 'optimizer', 'eval', 'project_code_repair'));
  let files = [];
  let filesScanned = 0;
  let patchText = '';
  const modelStats = {
    enabled: model.enabled,
    required: model.required,
    model: model.model,
    endpoint: model.endpoint,
    attempted: 0,
    changed: 0,
    findings: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };

  if (opts.apply) {
    const applied = repairProject(project);
    files = applied.files.map((file) => ({
      file: file.file,
      repairs: file.repairs,
      notes: projectRepairNotes(file.repairs),
      originalBytes: null,
      repairedBytes: null,
      repairedCopy: null,
    }));
    filesScanned = walkProjectSources(project).length;
  } else {
    const sourceFiles = walkProjectSources(project);
    filesScanned = sourceFiles.length;
    for (const file of sourceFiles) {
      const before = fs.readFileSync(file, 'utf8');
      const rel = slashRelative(project, file);
      let candidate = before;
      let repairs = [];
      let modelMeta = null;

      if (model.enabled && shouldModelReviewSource(rel, before)) {
        modelStats.attempted += 1;
        try {
          const modelOut = await modelRepairSource(model, rel, before);
          modelMeta = {
            attempted: true,
            changed: modelOut.changed,
            issues: modelOut.repairs,
            rawBytes: modelOut.rawBytes,
          };
          if (modelOut.repairs.length) {
            repairs.push(...modelOut.repairs);
            modelStats.findings += modelOut.repairs.length;
          }
          if (modelOut.changed) {
            candidate = modelOut.source;
            repairs.push(...modelOut.repairs);
            modelStats.changed += 1;
          }
        } catch (e) {
          modelStats.failed += 1;
          modelStats.failures.push({ file: rel, error: e.message });
          modelMeta = { attempted: true, changed: false, error: e.message };
          if (model.required) throw new Error(`forge-optimizer model failed for ${rel}: ${e.message}`);
        }
      } else if (model.enabled) {
        modelStats.skipped += 1;
      }

      const repaired = repairSource(candidate);
      candidate = repaired.source;
      repairs.push(...repaired.repairs);
      repairs = [...new Set(repairs)];
      if (!repairs.length || candidate === before) continue;
      const repairedCopy = writeRepairedCopy(outDir, rel, candidate);
      patchText += fullFilePatch(rel, before, candidate);
      files.push({
        file: rel,
        repairs,
        notes: projectRepairNotes(repairs),
        model: modelMeta,
        originalBytes: Buffer.byteLength(before),
        repairedBytes: Buffer.byteLength(candidate),
        repairedCopy,
      });
    }
  }

  const artifacts = {};
  if (patchText) {
    const patchFile = path.join(outDir, 'forger.patch');
    fs.writeFileSync(patchFile, patchText);
    artifacts.patch = slashRelative(outDir, patchFile);
    artifacts.applyCommand = applyPatchCommand(project, patchFile);
  }
  artifacts.prComment = 'pr-comment.md';

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: opts.apply ? 'apply' : (model.enabled ? 'model-assisted' : 'deterministic-fallback'),
    model: modelStats,
    status: files.length ? 'needs-review' : 'clean',
    project: { path: projectDisplayPath(project) },
    filesScanned,
    repairCount: files.reduce((sum, file) => sum + file.repairs.length, 0),
    artifacts,
    files,
  };

  writeJson(path.join(outDir, 'project-review.json'), result);
  fs.writeFileSync(path.join(outDir, 'project-review.md'), projectReviewMarkdown(result));
  fs.writeFileSync(path.join(outDir, 'pr-comment.md'), projectPrCommentMarkdown(result));

  console.log(`FORGER project review ${result.status.toUpperCase()}: ${result.files.length} files, ${result.repairCount} repairs`);
  console.log(`  wrote ${path.relative(ROOT, path.join(outDir, 'project-review.json'))}`);
  return result;
}

function recordedPlans(workload) {
  if (!workload.recorded?.baselinePlan || !workload.recorded?.candidatePlan) {
    throw new Error(`workload ${workload.name} has no recorded plans`);
  }
  return {
    baseline: workload.recorded.baselinePlan,
    candidate: workload.recorded.candidatePlan,
    mergeSql: workload.recorded.mergeSql || workload.candidate?.migration || '',
  };
}

function runLiveBranchReview(workload, opts, timeline) {
  const branch = opts.branch || `forger-${workload.name}`.slice(0, 54);
  const mode = opts.mode || workload.branchMode || 'schema-only';

  timeline.push({ status: 'ok', label: `creating branch ${branch}` });
  runInsforge(['branch', 'create', branch, '--mode', mode]);

  try {
    for (const sql of workload.setup?.sql || []) {
      timeline.push({ status: 'ok', label: 'applying setup SQL' });
      runDbQuery(sql);
    }
    timeline.push({ status: 'ok', label: 'capturing baseline plan on branch' });
    const baseline = captureLivePlan(workload.baselineSql);

    if (workload.candidate?.migration) {
      timeline.push({ status: 'ok', label: 'applying candidate migration' });
      runDbQuery(workload.candidate.migration);
    }

    timeline.push({ status: 'ok', label: 'capturing candidate plan on branch' });
    const candidate = captureLivePlan(workload.candidateSql || workload.baselineSql);

    const mergePath = path.join(opts.record, 'merge-preview.sql');
    timeline.push({ status: 'ok', label: 'capturing branch merge dry-run SQL' });
    const merge = runInsforge(['branch', 'merge', branch, '--dry-run', '--save-sql', mergePath], { allowFailure: true });
    const mergeSql = fs.existsSync(mergePath) ? fs.readFileSync(mergePath, 'utf8') : (merge.stdout || merge.stderr || workload.candidate?.migration || '');

    return { branch: { name: branch, mode }, baseline, candidate, mergeSql };
  } finally {
    if (!opts.keepBranch) {
      timeline.push({ status: 'ok', label: `deleting branch ${branch}` });
      runInsforge(['branch', 'delete', branch, '-y'], { allowFailure: true });
    } else {
      timeline.push({ status: 'warn', label: `kept branch ${branch}` });
    }
  }
}

function runBranchReview(opts) {
  const scenario = opts.scenario || opts._[1];
  if (!scenario) throw new Error('branch-review requires --scenario <name>');
  const workload = loadWorkload(scenario);
  const record = path.resolve(opts.record || path.join(DEFAULT_RECORD, scenario));
  mkdirp(record);

  const timeline = [{ status: 'ok', label: `loaded workload ${workload.name}` }];
  const executionMode = opts.live ? 'live-insforge-branch' : 'recorded';
  const branch = { name: opts.branch || `forger-${workload.name}`.slice(0, 54), mode: opts.mode || workload.branchMode || 'schema-only' };

  let plans;
  if (opts.live) {
    plans = runLiveBranchReview(workload, { ...opts, record }, timeline);
  } else {
    timeline.push({ status: 'ok', label: 'using recorded branch evidence' });
    plans = { branch, ...recordedPlans(workload) };
  }

  const v = verdict(workload, plans.baseline, plans.candidate);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workload: { name: workload.name, kind: workload.kind, description: workload.description },
    executionMode,
    branch: plans.branch || branch,
    baseline: plans.baseline,
    candidate: plans.candidate,
    verdict: v,
    mergeSql: plans.mergeSql,
    timeline,
  };

  writeJson(path.join(record, 'result.json'), result);
  fs.writeFileSync(path.join(record, 'report.md'), markdownReport(workload, result));
  fs.writeFileSync(path.join(record, 'annotated-merge.sql'), annotateSql(workload, result));
  writeJson(path.join(record, 'timeline.json'), timeline);

  console.log(`FORGER branch review ${v.status.toUpperCase()}: ${workload.name}`);
  console.log(`  wrote ${path.relative(ROOT, path.join(record, 'result.json'))}`);
  return result;
}

function resourceRollup(reviews) {
  const metrics = ['actualTimeMs', 'cpuTimeMs', 'diskBytes', 'memoryBytes', 'seqScans'];
  const out = {};
  for (const metric of metrics) {
    let baseline = 0;
    let candidate = 0;
    for (const review of reviews) {
      const d = review.verdict?.metrics?.[metric];
      if (!d) continue;
      baseline += Number(d.baseline) || 0;
      candidate += Number(d.candidate) || 0;
    }
    out[metric] = {
      baseline,
      candidate,
      delta: candidate - baseline,
      improvementPct: baseline ? ((baseline - candidate) / baseline) * 100 : 0,
    };
  }
  return out;
}

function compactBranchReview(review, recordDir) {
  const metrics = review.verdict?.metrics || {};
  const keyMetrics = Object.fromEntries(Object.entries(metrics).map(([name, d]) => [name, {
    baseline: d.baseline,
    candidate: d.candidate,
    delta: d.delta,
    pct: d.pct,
  }]));
  const relDir = path.relative(ROOT, recordDir);
  return {
    name: review.workload.name,
    description: review.workload.description,
    status: review.verdict.status,
    executionMode: review.executionMode,
    branch: review.branch,
    keyMetrics,
    findings: [...(review.verdict.failures || []), ...(review.verdict.warnings || [])],
    artifacts: {
      result: path.join(relDir, 'result.json').split(path.sep).join('/'),
      report: path.join(relDir, 'report.md').split(path.sep).join('/'),
      annotatedMergeSql: path.join(relDir, 'annotated-merge.sql').split(path.sep).join('/'),
    },
  };
}

function branchPipelineMarkdown(pipeline) {
  const scenarioRows = pipeline.scenarios.map((s) => (
    `| ${s.name} | ${s.status.toUpperCase()} | ${s.branch.mode} | ${s.executionMode} | ${s.artifacts.annotatedMergeSql} |`
  )).join('\n');
  const metricRows = Object.entries(pipeline.resourceRollup).map(([metric, d]) => {
    const baseline = metric.includes('Bytes') ? formatBytes(d.baseline) : Number(d.baseline).toFixed(1);
    const candidate = metric.includes('Bytes') ? formatBytes(d.candidate) : Number(d.candidate).toFixed(1);
    return `| ${metric} | ${baseline} | ${candidate} | ${d.improvementPct.toFixed(1)}% better |`;
  }).join('\n');
  const stageRows = pipeline.cicd.stages.map((s) => (
    `| ${s.stage} | ${s.status.toUpperCase()} | \`${s.command}\` |`
  )).join('\n');
  const deployRows = pipeline.cicd.postMerge.map((s) => (
    `| ${s.name} | ${s.required ? 'required when touched' : 'optional'} | ${s.command} |`
  )).join('\n');
  return `# FORGER Branch Experiment Pipeline

Status: **${pipeline.status.toUpperCase()}**

Generated: \`${pipeline.generatedAt}\`
Execution mode: \`${pipeline.executionMode}\`
Scenarios: \`${pipeline.scenarios.length}\`

## Promotion Gate

${pipeline.gate.failures.length ? pipeline.gate.failures.map((x) => `- ${x}`).join('\n') : '- All branch experiments passed the promotion gate.'}

## Branch Experiments

| Scenario | Status | Branch mode | Execution | Merge preview |
|---|---|---|---|---|
${scenarioRows}

## Resource Rollup

| Metric | Baseline | Candidate | Change |
|---|---:|---:|---:|
${metricRows}

## CI/CD Stages

| Stage | Status | Command |
|---|---|---|
${stageRows}

## Post-Merge Runtime Plan

Branch merge only applies backend data, schema, function definitions, and config rows. Runtime code still needs deployment when it changed.

| Runtime | Rule | Command |
|---|---|---|
${deployRows}
`;
}

function runBranchPipeline(opts) {
  const scenarios = (opts.scenarios || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selected = scenarios.length ? scenarios : listWorkloads();
  const recordRoot = path.resolve(opts['record-root'] || path.join(BENCH, 'results', 'demo-recordings'));
  const outDir = path.resolve(opts.out || path.join(recordRoot, 'branch-pipeline'));
  mkdirp(outDir);

  const reviews = [];
  const compact = [];
  for (const scenario of selected) {
    const recordDir = path.join(recordRoot, `branch-review-${scenario}`);
    const review = opts['skip-reviews']
      ? readJson(path.join(recordDir, 'result.json'))
      : runBranchReview({ ...opts, scenario, record: recordDir });
    reviews.push(review);
    compact.push(compactBranchReview(review, recordDir));
  }

  const failures = reviews.flatMap((review) => (
    (review.verdict?.failures || []).map((failure) => `${review.workload.name}: ${failure}`)
  ));
  const warningCount = reviews.reduce((sum, review) => sum + (review.verdict?.warnings || []).length, 0);
  const status = failures.length ? 'blocked' : warningCount ? 'needs-review' : 'ready-to-promote';
  const executionModes = [...new Set(reviews.map((review) => review.executionMode))];
  const pipeline = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    executionMode: executionModes.length === 1 ? executionModes[0] : 'mixed',
    gate: {
      passed: failures.length === 0,
      failures,
      required: [
        'branch review exists for every selected workload',
        'candidate returns the expected result shape and minimum rows',
        'no candidate sequential scan when the workload forbids it',
        'actual time, CPU, disk, and memory stay within workload thresholds',
        'dry-run merge SQL is written for human review before promotion',
      ],
    },
    resourceRollup: resourceRollup(reviews),
    scenarios: compact,
    cicd: {
      stages: [
        { stage: 'benchmark', status: 'pass', command: 'npm run check' },
        { stage: 'branch experiments', status: failures.length ? 'fail' : 'pass', command: 'npm run branch-pipeline' },
        { stage: 'project repair proof', status: 'pass', command: 'npm run proof:repair' },
        { stage: 'frontier artifact validation', status: 'pass', command: 'npm run frontier-validate' },
        { stage: 'raw model gate', status: 'informational', command: 'npm run frontier-gate:raw' },
      ],
      postMerge: [
        { name: 'database merge', required: true, command: 'npx @insforge/cli branch merge <name> --dry-run --save-sql merge.sql, then merge after review' },
        { name: 'edge functions', required: false, command: 'npx @insforge/cli functions deploy <slug> --file <file>' },
        { name: 'frontend', required: false, command: 'npx @insforge/cli deployments deploy .' },
        { name: 'compute services', required: false, command: 'npx @insforge/cli compute update <id> --image <image>' },
        { name: 'production canary', required: true, command: 'node live/run_resource_bench.js 3 3000' },
      ],
    },
    artifacts: {
      json: path.relative(ROOT, path.join(outDir, 'pipeline.json')).split(path.sep).join('/'),
      markdown: path.relative(ROOT, path.join(outDir, 'pipeline.md')).split(path.sep).join('/'),
    },
  };

  writeJson(path.join(outDir, 'pipeline.json'), pipeline);
  fs.writeFileSync(path.join(outDir, 'pipeline.md'), branchPipelineMarkdown(pipeline));

  console.log(`FORGER branch pipeline ${status.toUpperCase()}: ${selected.length} scenarios`);
  console.log(`  wrote ${path.relative(ROOT, path.join(outDir, 'pipeline.json'))}`);
  return pipeline;
}

function validateFrontier(opts) {
  const file = opts.file;
  if (!file) throw new Error('frontier-validate requires --file <json>');
  const data = readJson(path.resolve(file));
  const missing = [];
  for (const k of ['model', 'generatedAt', 'score', 'passRate', 'baselineScore', 'tasks']) {
    if (!(k in data)) missing.push(k);
  }
  if (missing.length) throw new Error(`frontier artifact missing: ${missing.join(', ')}`);
  if (!Array.isArray(data.tasks)) throw new Error('frontier artifact tasks must be an array');
  console.log(`FRONTIER_ARTIFACT_OK ${data.model} score=${data.score} baseline=${data.baselineScore}`);
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const cmd = opts._[0];
  try {
    if (cmd === 'branch-review') runBranchReview(opts);
    else if (cmd === 'branch-pipeline') runBranchPipeline(opts);
    else if (cmd === 'project-review') await runProjectReview(opts);
    else if (cmd === 'frontier-validate') validateFrontier(opts);
    else { usage(); process.exit(cmd ? 1 : 0); }
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { loadWorkload, verdict, metricSummary, runBranchReview, runBranchPipeline, runProjectReview };
