// forger-bench — extract a `solve(insforge)` solution from raw model output.
//
// Models wrap code in ```js fences, sometimes add prose, sometimes emit a bare function, or
// (agentic CLIs) narrate. We pull the LAST fenced block that defines solve(), else the first
// `async function solve` span, and sanity-check it compiles to a function.

'use strict';

function extractCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();

  // 1. fenced code blocks (```js / ```javascript / ```)
  const fences = [...text.matchAll(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  // prefer a fenced block that actually defines solve()
  for (let i = fences.length - 1; i >= 0; i--) {
    if (/function\s+solve\s*\(/.test(fences[i]) || /solve\s*=\s*(async\s*)?\(/.test(fences[i])) {
      return normalize(fences[i]);
    }
  }
  // any fenced block at all
  if (fences.length) return normalize(fences[fences.length - 1]);

  // 2. bare `async function solve(...) { ... }` span (balanced braces)
  const span = extractFunctionSpan(text);
  if (span) return normalize(span);

  return null;
}

// Pull `async function solve(...) {...}` with brace matching from a blob of text.
function extractFunctionSpan(text) {
  const start = text.search(/(async\s+)?function\s+solve\s*\(/);
  if (start === -1) return null;
  const braceStart = text.indexOf('{', start);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function normalize(code) {
  return code.trim();
}

// Quick validity check: does this compile to a function named solve?
function compiles(code) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${code}; return typeof solve === 'function' ? solve : null;`)();
    return typeof fn === 'function';
  } catch { return false; }
}

module.exports = { extractCode, compiles, extractFunctionSpan };
