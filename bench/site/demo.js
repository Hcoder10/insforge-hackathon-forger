// FORGER — live benchmark-suite runner for the RUN page.
// Streams /api/suite: gpt-oss-120b authors each task -> forge-optimizer (best-of-5) rewrites
// -> forger-bench grades both. Fills the results table + scoreboard + current-task readout
// in real time, and makes the Forger mascot smash a waste-bug as each task completes.

(function () {
  const API = (window.FORGER_API || '').replace(/\/$/, '') || location.origin;
  const btn = document.getElementById('run-suite');
  const body = document.getElementById('suite-body');
  const summary = document.getElementById('suite-summary');
  const status = document.getElementById('run-status');
  const curTask = document.getElementById('suite-current');
  const curA = document.getElementById('suite-now-author');
  const curF = document.getElementById('suite-now-forge');
  const curD = document.getElementById('suite-now-delta');
  const sbA = document.getElementById('sb-author');
  const sbF = document.getElementById('sb-forge');
  const sbW = document.getElementById('sb-wins');
  if (!btn) return;

  function scoreCell(v) { return `<td class="sc">${v}</td>`; }

  async function runSuite() {
    btn.disabled = true;
    body.innerHTML = '';
    if (window.forgerReset) window.forgerReset();
    summary.textContent = 'running…';
    status.textContent = 'gpt-oss-120b authoring → forge-optimizer (best-of-5) → grading, live…';
    let n = 0, wins = 0, sumA = 0, sumF = 0;
    try {
      const res = await fetch(`${API}/api/suite`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      if (!res.ok || !res.body) throw new Error('suite request failed (' + res.status + ')');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      curTask.textContent = 'starting…';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let d; try { d = JSON.parse(line); } catch { continue; }
          if (d.error) { continue; }

          n++; sumA += d.author; sumF += d.forge; if (d.delta > 0) wins++;

          // current-task readout (real values)
          curTask.textContent = `${d.domain} · ${d.concept}`;
          curA.textContent = d.author; curF.textContent = d.forge;
          curD.textContent = (d.delta > 0 ? '+' : '') + d.delta;
          curD.style.color = d.delta > 0 ? '#3ad29f' : (d.delta < 0 ? '#ff6b6b' : '');
          // real code from BOTH models for this task
          const ca = document.getElementById('suite-code-author');
          const cf = document.getElementById('suite-code-forge');
          if (ca) ca.textContent = d.authorCode || '(no code)';
          if (cf) cf.textContent = d.forgeCode || '(no code)';

          // results table row (real values)
          const tr = document.createElement('tr');
          if (d.delta > 0) tr.className = 'win';
          tr.innerHTML = `<td>${d.domain}·${d.concept}</td>${scoreCell(d.author)}${scoreCell(d.forge)}<td class="${d.delta > 0 ? 'dwin' : ''}">${d.delta > 0 ? '+' + d.delta : d.delta}</td>`;
          body.appendChild(tr);
          tr.scrollIntoView({ block: 'nearest' });

          // scoreboard (running averages)
          sbA.textContent = (sumA / n).toFixed(0);
          sbF.textContent = (sumF / n).toFixed(0);
          sbW.textContent = String(wins);
          summary.textContent = `${n} tasks graded · forge improved on ${wins}`;

          // Forger smashes a bug for each completed task (await so it's visibly real-time)
          if (window.forgerSmash) await window.forgerSmash(d.delta);
        }
      }
      status.textContent = `Done — ${n} tasks · forge-optimizer improved on ${wins} · author avg ${(sumA / n).toFixed(0)} → forge avg ${(sumF / n).toFixed(0)}`;
    } catch (e) {
      status.textContent = 'suite error: ' + e.message;
      summary.textContent = 'error';
    } finally { btn.disabled = false; }
  }

  btn.addEventListener('click', runSuite);
})();
