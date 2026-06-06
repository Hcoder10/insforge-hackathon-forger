const routes = ["landing", "dashboard", "optimizer", "run"];
const stage = document.querySelector(".stage");
const pages = new Map(routes.map((route) => [route, document.getElementById(route)]));
const links = [...document.querySelectorAll("[data-route]")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const assetPath = "./assets/";
const runPage = document.getElementById("run");
const runStart = document.querySelector("[data-run-start]");
const runReset = document.querySelector("[data-run-reset]");
const runLane = document.querySelector("[data-game-lane]");
const runForger = document.querySelector("[data-run-forger]");
const runResult = document.querySelector("[data-run-result]");
const impactBurst = document.querySelector("[data-impact-burst]");
const wasteNodes = [...document.querySelectorAll("[data-waste-node]")];
const optimizedStats = [...document.querySelectorAll("[data-after-stat]")];
const walkFrames = [`${assetPath}forger-walk-1.png`, `${assetPath}forger-walk-2.png`];
const stampFrames = [
  `${assetPath}forger-stamp-1.png`,
  `${assetPath}forger-stamp-2.png`,
  `${assetPath}forger-stamp-3.png`,
  `${assetPath}forger-stamp-4.png`,
];
const stampTargets = ["32%", "55%", "78%"];
let walkTimer = null;
let runToken = 0;

function currentRoute() {
  const requested = window.location.hash.replace("#", "");
  return routes.includes(requested) ? requested : "landing";
}

function render() {
  const route = currentRoute();
  stage.dataset.page = route;
  for (const [name, page] of pages) {
    const active = name === route;
    page.classList.toggle("active", active);
    page.classList.remove("is-animating");
    if (active) {
      restartPageMotion(page);
      animateCounts(page);
    }
  }
  for (const link of links) {
    const active = link.dataset.route === route;
    link.classList.toggle("active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

function restartPageMotion(page) {
  if (reduceMotion.matches) {
    return;
  }
  void page.offsetWidth;
  page.classList.add("is-animating");
}

function animateCounts(page) {
  const counters = [...page.querySelectorAll("[data-count]")];
  for (const counter of counters) {
    const target = Number(counter.dataset.count);
    const suffix = counter.dataset.suffix || "";
    if (!Number.isFinite(target)) {
      continue;
    }
    if (reduceMotion.matches) {
      counter.textContent = `${target}${suffix}`;
      continue;
    }
    const start = performance.now();
    const duration = Math.min(1200, Math.max(520, Math.abs(target) * 12));
    const sign = target < 0 ? -1 : 1;

    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(Math.abs(target) * eased) * sign;
      counter.textContent = `${value}${suffix}`;
      if (progress < 1) {
        requestAnimationFrame(tick);
      }
    }

    counter.textContent = `0${suffix}`;
    requestAnimationFrame(tick);
  }
}

window.addEventListener("hashchange", render);
runStart?.addEventListener("click", runOptimizerDemo);
runReset?.addEventListener("click", resetRunDemo);
resetRunDemo();
render();

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stillCurrent(token) {
  return token === runToken && currentRoute() === "run";
}

function setRunnerPosition(position) {
  runLane?.style.setProperty("--runner-x", position);
}

function setForgerFrame(src) {
  if (runForger) {
    runForger.src = src;
  }
}

function startWalkCycle() {
  if (reduceMotion.matches || !runForger) {
    setForgerFrame(walkFrames[0]);
    return;
  }
  let frame = 0;
  clearInterval(walkTimer);
  walkTimer = window.setInterval(() => {
    frame = (frame + 1) % walkFrames.length;
    setForgerFrame(walkFrames[frame]);
  }, 130);
}

function stopWalkCycle() {
  clearInterval(walkTimer);
  walkTimer = null;
  setForgerFrame(walkFrames[0]);
}

function clearRunState() {
  stopWalkCycle();
  runPage?.setAttribute("data-run-state", "idle");
  runStart.disabled = false;
  runLane?.classList.remove("cleaning");
  runResult?.classList.remove("active");
  impactBurst?.classList.remove("active");
  setRunnerPosition("7%");
  setForgerFrame(walkFrames[0]);
  for (const node of wasteNodes) {
    node.classList.remove("active", "stamped", "coded");
    const pop = node.querySelector("[data-code-pop]");
    if (pop) {
      pop.textContent = "";
    }
  }
  for (const stat of optimizedStats) {
    stat.style.setProperty("--pct", "0");
    stat.querySelector("b").textContent = "pending";
  }
}

function resetRunDemo() {
  runToken += 1;
  clearRunState();
}

async function runOptimizerDemo() {
  const token = runToken + 1;
  runToken = token;
  clearRunState();
  runStart.disabled = true;
  runPage?.setAttribute("data-run-state", "running");

  for (const [index, node] of wasteNodes.entries()) {
    if (!stillCurrent(token)) return;
    await walkTo(stampTargets[index], token);
    if (!stillCurrent(token)) return;
    await stampNode(node, stampTargets[index], token);
  }

  if (!stillCurrent(token)) return;
  revealOptimizedStats();
  runPage?.setAttribute("data-run-state", "complete");
  runResult?.classList.add("active");
  runLane?.classList.add("cleaning");

  await walkTo("112%", token);
  if (!stillCurrent(token)) return;
  runStart.disabled = false;
}

async function walkTo(position, token) {
  startWalkCycle();
  setRunnerPosition(position);
  await wait(reduceMotion.matches ? 40 : 820);
  if (!stillCurrent(token)) return;
  stopWalkCycle();
}

async function stampNode(node, position, token) {
  node.classList.add("active");
  const pop = node.querySelector("[data-code-pop]");
  if (pop) {
    await typeCode(pop, pop.dataset.text || "", token);
    node.classList.add("coded");
  }
  for (const frame of stampFrames) {
    if (!stillCurrent(token)) return;
    setForgerFrame(frame);
    await wait(reduceMotion.matches ? 20 : 145);
  }
  impactBurst.style.left = position;
  impactBurst.classList.remove("active");
  void impactBurst.offsetWidth;
  impactBurst.classList.add("active");
  node.classList.add("stamped");
  node.classList.remove("active");
  await wait(reduceMotion.matches ? 40 : 320);
}

async function typeCode(target, text, token) {
  target.textContent = "";
  if (reduceMotion.matches) {
    target.textContent = text;
    return;
  }
  for (const char of text) {
    if (!stillCurrent(token)) return;
    target.textContent += char;
    await wait(22);
  }
}

function revealOptimizedStats() {
  for (const stat of optimizedStats) {
    stat.style.setProperty("--pct", stat.dataset.final || "0");
    stat.querySelector("b").textContent = stat.dataset.label || "";
  }
}
