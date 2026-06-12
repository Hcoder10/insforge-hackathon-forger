// forger-bench — grading harness. (docs/DESIGN.md §4, §6)
//
// gradeSolution(task, code): for one candidate solution to one task —
//   1. build the cost spread by running oracle/naive/mid through fresh backends
//   2. run the candidate through a fresh backend, capture its metrics
//   3. verify functional correctness
//   4. score = Mercury-percentile of candidate cost vs the spread (bench/score.js)
//
// Each solution runs against its OWN fresh backend so metrics never leak between runs.

'use strict';

const { createBackend } = require('../mock');
const { buildScoringWeights, buildSpread, scoreTask } = require('./score');

async function runSolutionMetrics(task, code) {
  const be = createBackend();
  task.setup(be);
  let result, error = null;
  const start = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  try {
    result = await task.run(be, code);
  } catch (e) {
    error = e;
  } finally {
    const cpu = process.cpuUsage(cpuStart);
    const rssEnd = process.memoryUsage().rss;
    be.metrics.wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    be.metrics.cpuUserMs = cpu.user / 1000;
    be.metrics.cpuSystemMs = cpu.system / 1000;
    be.metrics.cpuTotalMs = (cpu.user + cpu.system) / 1000;
    be.metrics.peakRSS = Math.max(rssStart, rssEnd);
  }
  return { metrics: be.metrics, result, error, be };
}

async function gradeSolution(task, code) {
  // 1. spread from the task's own oracle/naive/mid
  const spreadSources = [task.oracle, task.naive, ...(task.mid || [])];
  const spreadMetrics = [];
  for (const src of spreadSources) {
    const { metrics } = await runSolutionMetrics(task, src);
    spreadMetrics.push(metrics);
  }
  const weights = buildScoringWeights(task.weights, spreadMetrics);
  const bounds = buildSpread(spreadMetrics, weights);

  // 2 + 3. run + verify the candidate
  const { metrics, result, error, be } = await runSolutionMetrics(task, code);
  let correct = false;
  if (!error) {
    try { correct = !!task.verify(be, {}, result); } catch { correct = false; }
  }

  // 4. score
  const { score, eff, perMetric } = scoreTask({
    correct, candidateMetrics: metrics, bounds, weights,
  });

  return {
    id: task.id, domain: task.domain, concept: task.concept,
    correct, score, eff, perMetric, metrics, bounds, weights,
    error: error ? String(error.message || error) : null,
  };
}

module.exports = { gradeSolution, runSolutionMetrics };
