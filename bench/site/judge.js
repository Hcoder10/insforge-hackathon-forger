(function () {
  const API = (window.FORGER_API || '').replace(/\/$/, '') || location.origin;
  let branchReviews = [];
  let activeBranch = null;

  const els = {
    branchStatus: byId('judge-branch-status'),
    branchName: byId('judge-branch-name'),
    branchDescription: byId('judge-branch-description'),
    branchMode: byId('judge-branch-mode'),
    executionMode: byId('judge-execution-mode'),
    metricBody: byId('judge-metric-body'),
    tabs: byId('judge-scenario-tabs'),
    mergeSql: byId('judge-merge-sql'),
    sqlVerdict: byId('judge-sql-verdict'),
    pipelineStatus: byId('judge-pipeline-status'),
    pipelineMode: byId('judge-pipeline-mode'),
    pipelineSummary: byId('judge-pipeline-summary'),
    pipelineScenarios: byId('judge-pipeline-scenarios'),
    pipelineCpu: byId('judge-pipeline-cpu'),
    pipelineDisk: byId('judge-pipeline-disk'),
    pipelineStages: byId('judge-pipeline-stages'),
    pipelineArtifact: byId('judge-pipeline-artifact'),
    frontierStatus: byId('judge-frontier-status'),
    frontierModel: byId('judge-frontier-model'),
    frontierScore: byId('judge-frontier-score'),
    frontierScoreMain: byId('judge-frontier-score-main'),
    frontierPass: byId('judge-frontier-pass'),
    frontierBaseline: byId('judge-frontier-baseline'),
    frontierDelta: byId('judge-frontier-delta'),
    frontierTasks: byId('judge-frontier-tasks'),
    frontierArtifact: byId('judge-frontier-artifact'),
    projectRepairs: byId('judge-project-repairs'),
    projectStatus: byId('judge-project-status'),
    projectDescription: byId('judge-project-description'),
    projectScanned: byId('judge-project-scanned'),
    projectChanged: byId('judge-project-changed'),
    projectRepairCount: byId('judge-project-repair-count'),
    projectFiles: byId('judge-project-files'),
    projectArtifact: byId('judge-project-artifact'),
    benchmarkTasks: byId('judge-benchmark-tasks'),
    benchmarkDomains: byId('judge-benchmark-domains'),
    benchmarkAxes: byId('judge-benchmark-axes'),
    leaderboard: byId('judge-leaderboard'),
  };

  if (!document.getElementById('judge')) return;

  function byId(id) {
    return document.getElementById(id);
  }

  async function fetchJson(path) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
  }

  function fmtNumber(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    return n.toFixed(digits).replace(/\.0$/, '');
  }

  function fmtValue(metric, value) {
    if (/bytes/i.test(metric)) return fmtBytes(value);
    if (/ms/i.test(metric)) return `${fmtNumber(value, 1)} ms`;
    return fmtNumber(value, metric === 'seqScans' ? 0 : 1);
  }

  function fmtBytes(value) {
    let n = Number(value || 0);
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function pct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
  }

  function betterPct(data, metric) {
    const value = Number(data?.resourceRollup?.[metric]?.improvementPct);
    if (!Number.isFinite(value)) return '-';
    return `${value.toFixed(1)}%`;
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  function setStatus(el, status) {
    if (!el) return;
    el.textContent = status || '-';
    el.dataset.status = String(status || '').toLowerCase();
  }

  function renderBranchTabs() {
    if (!els.tabs) return;
    els.tabs.innerHTML = '';
    for (const review of branchReviews) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = review.workload.name.replace(/-/g, ' ');
      button.className = activeBranch?.workload?.name === review.workload.name ? 'active' : '';
      button.addEventListener('click', () => renderBranch(review));
      els.tabs.appendChild(button);
    }
  }

  function renderBranch(review) {
    activeBranch = review;
    renderBranchTabs();
    const status = review?.verdict?.status || 'missing';
    setStatus(els.branchStatus, status.toUpperCase());
    setStatus(els.sqlVerdict, status.toUpperCase());
    setText(els.branchName, review?.workload?.name || '-');
    setText(els.branchDescription, review?.workload?.description || 'No branch review artifact found.');
    setText(els.branchMode, review?.branch?.mode || '-');
    setText(els.executionMode, review?.executionMode || '-');
    setText(els.mergeSql, review?.artifacts?.annotatedSql || review?.mergeSql || 'No SQL preview available.');

    if (!els.metricBody) return;
    els.metricBody.innerHTML = '';
    const metrics = review?.verdict?.metrics || {};
    for (const [metric, d] of Object.entries(metrics)) {
      const tr = document.createElement('tr');
      const improved = Number(d.delta) <= 0;
      tr.className = improved ? 'improved' : 'regressed';
      for (const text of [
        metric,
        fmtValue(metric, d.baseline),
        fmtValue(metric, d.candidate),
        pct(d.pct),
      ]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        tr.appendChild(cell);
      }
      els.metricBody.appendChild(tr);
    }
  }

  function renderFrontier(data) {
    const score = Number(data.score);
    const baseline = Number(data.baselineScore);
    const delta = score - baseline;
    setStatus(els.frontierStatus, data.status || (data.recorded ? 'recorded' : 'ready'));
    setText(els.frontierModel, data.model || '-');
    setText(els.frontierScore, Number.isFinite(score) ? fmtNumber(score, 1) : '-');
    setText(els.frontierScoreMain, Number.isFinite(score) ? fmtNumber(score, 1) : '-');
    setText(els.frontierPass, `${fmtNumber(data.passRate, 1)}%`);
    setText(els.frontierBaseline, Number.isFinite(baseline) ? fmtNumber(baseline, 1) : '-');
    setText(els.frontierDelta, Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${fmtNumber(delta, 1)}` : '-');
    setText(els.frontierArtifact, data.artifactPath || '-');

    if (!els.frontierTasks) return;
    els.frontierTasks.innerHTML = '';
    for (const task of (data.tasks || []).slice(0, 5)) {
      const li = document.createElement('li');
      if (typeof task === 'string') {
        li.textContent = task;
      } else {
        li.textContent = `${task.name || task.id || 'task'}: ${task.before ?? '-'} -> ${task.after ?? '-'}`;
      }
      els.frontierTasks.appendChild(li);
    }
  }

  function renderBenchmark(data) {
    const headline = data.headline || {};
    setText(els.benchmarkTasks, String(headline.tasks || '-'));
    setText(els.benchmarkDomains, String(headline.domains || '-'));
    setText(els.benchmarkAxes, (headline.resourceAxes || []).join(', '));

    if (!els.leaderboard) return;
    els.leaderboard.innerHTML = '';
    for (const row of (data.leaderboard || []).slice(0, 6)) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      const score = document.createElement('b');
      name.textContent = row.model || '-';
      score.textContent = fmtNumber(row.meanScore ?? row.pass, 1);
      li.appendChild(name);
      li.appendChild(score);
      els.leaderboard.appendChild(li);
    }
  }

  function renderBranchPipeline(data) {
    if (!data || data.error) {
      setStatus(els.pipelineStatus, 'MISSING');
      setText(els.pipelineMode, '-');
      setText(els.pipelineSummary, data?.error || 'No branch pipeline artifact found.');
      setText(els.pipelineArtifact, '-');
      return;
    }

    setStatus(els.pipelineStatus, String(data.status || '-').toUpperCase());
    setText(els.pipelineMode, data.executionMode || '-');
    setText(els.pipelineScenarios, String((data.scenarios || []).length));
    setText(els.pipelineCpu, betterPct(data, 'cpuTimeMs'));
    setText(els.pipelineDisk, betterPct(data, 'diskBytes'));
    setText(els.pipelineArtifact, data.artifactPath || data.artifacts?.json || '-');
    const failures = data.gate?.failures || [];
    setText(
      els.pipelineSummary,
      failures.length
        ? `${failures.length} promotion issue${failures.length === 1 ? '' : 's'} found.`
        : 'Branch experiments passed promotion checks and wrote dry-run merge SQL.',
    );

    if (!els.pipelineStages) return;
    els.pipelineStages.innerHTML = '';
    for (const stage of (data.cicd?.stages || []).slice(0, 6)) {
      const li = document.createElement('li');
      const name = document.createElement('b');
      const status = document.createElement('span');
      name.textContent = stage.stage || '-';
      status.textContent = stage.status || '-';
      status.dataset.status = String(stage.status || '').toLowerCase();
      li.appendChild(name);
      li.appendChild(status);
      els.pipelineStages.appendChild(li);
    }
  }

  function renderProjectReview(data) {
    const review = data?.active || data;
    if (!review || review.error) {
      setStatus(els.projectStatus, 'MISSING');
      setText(els.projectRepairs, '-');
      setText(els.projectDescription, review?.error || 'No project review artifact found.');
      setText(els.projectArtifact, '-');
      return;
    }

    const projectPath = review.project?.path || 'project';
    const status = review.status || 'ready';
    setStatus(els.projectStatus, status.toUpperCase());
    setText(els.projectRepairs, String(review.repairCount ?? 0));
    setText(els.projectDescription, `${projectPath} reviewed in ${review.mode || 'dry-run'} mode.`);
    setText(els.projectScanned, String(review.filesScanned ?? '-'));
    setText(els.projectChanged, String((review.files || []).length));
    setText(els.projectRepairCount, String(review.repairCount ?? 0));
    setText(els.projectArtifact, review.artifacts?.dir || '-');

    if (!els.projectFiles) return;
    els.projectFiles.innerHTML = '';
    for (const file of (review.files || []).slice(0, 5)) {
      const li = document.createElement('li');
      const name = document.createElement('b');
      const notes = document.createElement('span');
      name.textContent = file.file || '-';
      notes.textContent = (file.repairs || []).join(', ') || 'review note';
      li.appendChild(name);
      li.appendChild(notes);
      els.projectFiles.appendChild(li);
    }
  }

  async function loadJudgeMode() {
    try {
      const [branch, pipeline, projectReview, frontier, benchmark] = await Promise.all([
        fetchJson('/api/branch-review').catch((e) => ({ error: e.message, reviews: [] })),
        fetchJson('/api/branch-pipeline').catch((e) => ({ error: e.message })),
        fetchJson('/api/project-review').catch((e) => ({ error: e.message })),
        fetchJson('/api/frontier').catch((e) => ({ error: e.message })),
        fetchJson('/api/benchmark').catch((e) => ({ error: e.message })),
      ]);

      branchReviews = branch.reviews || [];
      renderBranch(branch.active || branchReviews[0] || null);
      renderBranchPipeline(pipeline);
      renderProjectReview(projectReview);

      if (frontier.error) {
        setStatus(els.frontierStatus, 'MISSING');
        setText(els.frontierArtifact, frontier.error);
      } else {
        renderFrontier(frontier);
      }

      if (benchmark.error) {
        setText(els.benchmarkTasks, '-');
        setText(els.benchmarkAxes, benchmark.error);
      } else {
        renderBenchmark(benchmark);
      }
    } catch (e) {
      setStatus(els.branchStatus, 'ERROR');
      setText(els.branchDescription, e.message);
    }
  }

  loadJudgeMode();
  window.addEventListener('hashchange', () => {
    if (location.hash === '#judge') loadJudgeMode();
  });
})();
