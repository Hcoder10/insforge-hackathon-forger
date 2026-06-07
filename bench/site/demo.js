// FORGER — live demo data layer for the RUN page.
// Exposes window.runForgerDemo() (calls the API) and window.applyForgerResult(data)
// (fills the input/output editors + REAL before/after stat panels + verdicts).
// app.js calls these so the animation and the real data stay in sync.
//
// Pipeline: Nemotron-3-Super authors a solution -> forge-optimizer rewrites it ->
// forger-bench grades both. (Self-hosted models; no external API.)

(function () {
  const taskSel = document.getElementById('run-task');
  const status = document.getElementById('run-status');
  const inputTa = document.getElementById('run-input');
  const outputTa = document.getElementById('run-output');
  const inLabel = document.getElementById('run-input-label');
  const outLabel = document.getElementById('run-output-label');

  const API = (window.FORGER_API || '').replace(/\/$/, '') || location.origin;

  async function loadTasks() {
    if (!taskSel) return;
    try {
      const r = await fetch(`${API}/api/tasks`);
      const tasks = await r.json();
      const order = ['pagination', 'count_only', 'top_n', 'owner_scope', 'no_base64_in_db', 'batch_embed'];
      tasks.sort((a, b) => (order.indexOf(a.concept) + 1 || 99) - (order.indexOf(b.concept) + 1 || 99));
      taskSel.innerHTML = '';
      for (const t of tasks) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = `${t.domain} · ${t.concept}`;
        taskSel.appendChild(o);
      }
    } catch (e) {
      if (status) status.textContent = 'Demo API offline.';
    }
  }

  function setStat(prefix, key, pct, label) {
    const el = document.querySelector(`[${prefix}="${key}"]`);
    if (!el) return;
    el.style.setProperty('--pct', String(Math.max(0, Math.min(100, pct))));
    const b = el.querySelector('b'); if (b) b.textContent = label;
  }

  function paintStats(prefix, g) {
    if (!g) return;
    const ok = g.correct, ops = g.metrics.dbOps, bytes = g.metrics.bytesRead, rows = g.metrics.rowsReturned;
    // illustrative scaling so the bars read clearly
    setStat(prefix, 'cpu', ok ? Math.min(100, ops * 14) : 96, ok ? `${ops} ops` : 'WRONG');
    setStat(prefix, 'disk', Math.min(100, Math.round(bytes / 160)), `${bytes}B`);
    setStat(prefix, 'memory', Math.min(100, rows * 2 + 6), `${rows} rows`);
    setStat(prefix, 'network', Math.min(100, Math.round(bytes / 150)), `${bytes}B`);
  }

  // Called by app.js: do the round-trip, return the result object.
  window.runForgerDemo = async function () {
    const taskId = taskSel ? taskSel.value : 'db.pagination.test2';
    if (status) status.textContent = 'Nemotron-3-Super authoring → forge-optimizer rewriting → grading…';
    if (inputTa) inputTa.value = '…';
    if (outputTa) outputTa.value = '…';
    const r = await fetch(`${API}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    return r.json();
  };

  // Called by app.js when the animation reaches the reveal: fill REAL data.
  window.applyForgerResult = function (d) {
    if (!d || d.error) { if (status) status.textContent = 'error: ' + (d && d.error || 'no response'); return; }
    const author = d.author || d.haiku;   // backend may label it author/haiku
    if (inputTa) inputTa.value = author.code;
    if (outputTa) outputTa.value = d.forge.code + (d.forge.stub ? '\n\n/* forge-optimizer endpoint not connected */' : '');
    const as = author.grade.score, fs = d.forge.grade.score;
    if (inLabel) { inLabel.textContent = `author: ${author.grade.correct ? 'correct' : 'WRONG'} · score ${as}`; inLabel.style.color = author.grade.correct ? '' : '#ff6b6b'; }
    if (outLabel) { outLabel.textContent = `forge-optimizer: ${d.forge.grade.correct ? 'correct' : 'WRONG'} · score ${fs}`; outLabel.style.color = d.forge.grade.correct ? '#3ad29f' : '#ff6b6b'; }
    paintStats('data-before-stat', author.grade);
    paintStats('data-after-stat', d.forge.grade);
    const delta = fs - as;
    if (status) status.textContent = `forger-bench: author ${as} → forge-optimizer ${fs}  (${delta >= 0 ? '+' : ''}${delta})`;
  };

  // --- benchmark suite: run many tasks, surface where forge improved ---
  const suiteBtn = document.getElementById('run-suite');
  const suiteWrap = document.getElementById('suite-wrap');
  const suiteBody = document.getElementById('suite-body');
  const suiteSummary = document.getElementById('suite-summary');

  async function runSuite() {
    if (!suiteWrap) return;
    suiteWrap.hidden = false;
    suiteBody.innerHTML = '';
    suiteSummary.textContent = 'Running suite… gpt-oss-120b authors → forge best-of-5 → grade';
    suiteBtn.disabled = true;
    let n = 0, wins = 0, sumA = 0, sumF = 0;
    try {
      const res = await fetch(`${API}/api/suite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let d; try { d = JSON.parse(line); } catch { continue; }
          if (d.error) continue;
          n++; sumA += d.author; sumF += d.forge; if (d.delta > 0) wins++;
          const tr = document.createElement('tr');
          if (d.delta > 0) tr.className = 'win';
          tr.innerHTML = `<td>${d.domain}·${d.concept}</td><td>${d.author}</td><td>${d.forge}</td><td>${d.delta > 0 ? '+' + d.delta : d.delta}</td>`;
          suiteBody.appendChild(tr);
          suiteSummary.textContent = `${n} tasks · forge improved on ${wins} · author avg ${(sumA / n).toFixed(0)} → forge avg ${(sumF / n).toFixed(0)}`;
        }
      }
      suiteSummary.textContent = `Done. ${n} tasks · forge-optimizer improved on ${wins} · author avg ${(sumA / n).toFixed(0)} → forge avg ${(sumF / n).toFixed(0)}`;
    } catch (e) {
      suiteSummary.textContent = 'suite error: ' + e.message;
    } finally { suiteBtn.disabled = false; }
  }
  if (suiteBtn) suiteBtn.addEventListener('click', runSuite);

  loadTasks();
})();
