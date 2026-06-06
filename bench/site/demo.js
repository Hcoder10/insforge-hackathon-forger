// FORGER — live demo wiring for the Optimizer page.
// Calls /api/demo: Haiku 4.5 authors a solution -> forge-optimizer rewrites it ->
// forger-bench grades both. Fills the input (Haiku) + output (forge) editors with the
// real code and verdicts.

(function () {
  const sel = document.getElementById('demo-task');
  const runBtn = document.getElementById('demo-run');
  const status = document.getElementById('demo-status');
  const haikuCode = document.getElementById('haiku-code');
  const forgeCode = document.getElementById('forge-code');
  const haikuVerdict = document.getElementById('haiku-verdict');
  const forgeVerdict = document.getElementById('forge-verdict');
  if (!sel || !runBtn) return;

  // Demo API base: window.FORGER_API (set by a tiny inline config) or same-origin.
  const API = (window.FORGER_API || '').replace(/\/$/, '') || location.origin;
  const verdict = (g) => g.error ? 'error'
    : `${g.correct ? '✓ correct' : '✗ wrong'} · score ${g.score} · ${g.metrics.dbOps} ops / ${g.metrics.bytesRead}B`;

  async function loadTasks() {
    try {
      const r = await fetch(`${API}/api/tasks`);
      const tasks = await r.json();
      // prioritize the demo-friendly failing concepts first
      const order = ['pagination', 'count_only', 'owner_scope', 'no_base64_in_db', 'batch_embed'];
      tasks.sort((a, b) => (order.indexOf(a.concept) + 1 || 99) - (order.indexOf(b.concept) + 1 || 99));
      sel.innerHTML = '';
      for (const t of tasks) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = `${t.domain} · ${t.concept} (${t.id})`;
        sel.appendChild(o);
      }
    } catch (e) { status.textContent = 'demo server not running (start: node demo_server.js)'; }
  }

  async function run() {
    const taskId = sel.value;
    runBtn.disabled = true;
    status.textContent = 'Haiku 4.5 authoring…';
    haikuCode.textContent = '…'; forgeCode.textContent = '…';
    haikuVerdict.textContent = '…'; forgeVerdict.textContent = '…';
    try {
      const r = await fetch(`${API}/api/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) });
      const d = await r.json();
      if (d.error) { status.textContent = 'error: ' + d.error; return; }
      haikuCode.textContent = d.haiku.code;
      forgeCode.textContent = d.forge.code + (d.forge.stub ? '\n\n/* (forge-optimizer endpoint not connected — set FORGE_OPT_URL) */' : '');
      haikuVerdict.textContent = verdict(d.haiku.grade);
      forgeVerdict.textContent = verdict(d.forge.grade);
      const delta = (d.forge.grade.score || 0) - (d.haiku.grade.score || 0);
      status.textContent = `Haiku ${d.haiku.grade.score} → forge-optimizer ${d.forge.grade.score}  (${delta >= 0 ? '+' : ''}${delta})`;
      haikuVerdict.style.color = d.haiku.grade.correct ? '' : '#ff6b6b';
      forgeVerdict.style.color = d.forge.grade.correct ? '#3ad29f' : '#ff6b6b';
    } catch (e) { status.textContent = 'request failed: ' + e.message; }
    finally { runBtn.disabled = false; }
  }

  runBtn.addEventListener('click', run);
  loadTasks();
})();
