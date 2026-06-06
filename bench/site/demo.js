// FORGER — live demo wiring for the RUN page.
// Hooks the "Run optimizer" button: pick a benchmark task -> Claude Haiku 4.5 authors a
// solution -> forge-optimizer rewrites it -> forger-bench grades both. Fills the input
// (Haiku) + output (forge) editors and the before/after stat panels with REAL numbers.

(function () {
  const taskSel = document.getElementById('run-task');
  const runBtn = document.querySelector('[data-run-start]');
  const status = document.getElementById('run-status');
  const inputTa = document.getElementById('run-input');
  const outputTa = document.getElementById('run-output');
  const inLabel = document.getElementById('run-input-label');
  const outLabel = document.getElementById('run-output-label');
  if (!taskSel || !runBtn) return;

  // Demo API base: window.FORGER_API (set for the deployed site) or same-origin.
  const API = (window.FORGER_API || '').replace(/\/$/, '') || location.origin;

  async function loadTasks() {
    try {
      const r = await fetch(`${API}/api/tasks`);
      const tasks = await r.json();
      // pagination first — the case forge-optimizer reliably improves
      const order = ['pagination', 'count_only', 'top_n', 'owner_scope', 'no_base64_in_db', 'batch_embed'];
      tasks.sort((a, b) => (order.indexOf(a.concept) + 1 || 99) - (order.indexOf(b.concept) + 1 || 99));
      taskSel.innerHTML = '';
      for (const t of tasks) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = `${t.domain} · ${t.concept}`;
        taskSel.appendChild(o);
      }
    } catch (e) {
      status.textContent = 'Demo API offline — showing the canned animation only.';
    }
  }

  function setStat(panelSel, key, pct, label) {
    const el = document.querySelector(`[${panelSel}="${key}"]`);
    if (!el) return;
    el.style.setProperty('--pct', String(pct));
    const b = el.querySelector('b'); if (b) b.textContent = label;
  }

  // map graded metrics -> the 4 stat bars (illustrative scaling)
  function paintStats(prefix, g) {
    if (!g || g.error) return;
    const ops = g.metrics.dbOps, bytes = g.metrics.bytesRead, rows = g.metrics.rowsReturned;
    setStat(prefix, 'cpu', Math.min(100, ops * 12 + (g.correct ? 0 : 40)), g.correct ? `${ops} ops` : 'WRONG');
    setStat(prefix, 'disk', Math.min(100, Math.round(bytes / 200)), `${bytes}B`);
    setStat(prefix, 'memory', Math.min(100, rows * 2), `${rows} rows`);
    setStat(prefix, 'network', Math.min(100, Math.round(bytes / 180)), `${bytes}B`);
  }

  async function run() {
    const taskId = taskSel.value;
    if (!taskId) return;
    status.textContent = 'Claude Haiku 4.5 authoring…';
    inputTa.value = '…'; outputTa.value = '…';
    try {
      const r = await fetch(`${API}/api/demo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      const d = await r.json();
      if (d.error) { status.textContent = 'error: ' + d.error; return; }
      inputTa.value = d.haiku.code;
      outputTa.value = d.forge.code + (d.forge.stub ? '\n\n/* forge-optimizer endpoint not connected */' : '');
      const hs = d.haiku.grade.score, fs = d.forge.grade.score;
      inLabel.textContent = `Haiku: ${d.haiku.grade.correct ? 'correct' : 'WRONG'} · score ${hs}`;
      outLabel.textContent = `forge-optimizer: ${d.forge.grade.correct ? 'correct' : 'WRONG'} · score ${fs}`;
      inLabel.style.color = d.haiku.grade.correct ? '' : '#ff6b6b';
      outLabel.style.color = d.forge.grade.correct ? '#3ad29f' : '#ff6b6b';
      paintStats('data-before-stat', d.haiku.grade);
      paintStats('data-after-stat', d.forge.grade);
      const delta = fs - hs;
      status.textContent = `forger-bench: Haiku ${hs} → forge-optimizer ${fs}  (${delta >= 0 ? '+' : ''}${delta})`;
    } catch (e) {
      status.textContent = 'request failed: ' + e.message;
    }
  }

  // run alongside the existing animation (app.js also listens on this button)
  runBtn.addEventListener('click', run);
  loadTasks();
})();
