# Live Demo Result (run autonomously)

**Flow:** Claude Haiku 4.5 authors a solution → forge-optimizer rewrites it → forger-bench
grades both, live.

## Task: auth.owner_scope.test1
"Return the current user's own rows from `todos` (column user_id) as {id}[]."

### Step 1 — Haiku 4.5 (the "before")
```js
async function solve(insforge) {
  const { data: authData, error: authError } = await insforge.auth.getCurrentUser();
  if (authError) throw authError;
  const userId = authData.user.id;
  const { data: todos, error: todosError } = await insforge.database
    .from('todos').select('id').eq('user_id', userId);
  if (todosError) throw todosError;
  return todos;
}
```
**Benchmark: score 0 — INCORRECT, reward -1.**

### Step 2 — forge-optimizer (the "after")
forge-optimizer rewrote it into a passing owner-scoped query.
**Benchmark: score 100 — CORRECT, reward 3 (near-optimal).**

## Result
| | Benchmark score | Correct |
|---|---|---|
| Haiku 4.5 (author) | 0 | ✗ |
| forge-optimizer (optimized) | 100 | ✓ |

**+100 improvement** — the specialist fixed the frontier model's failing solution, verified
live by the benchmark.

(Note: on easy tasks Haiku already scores 100 one-shot; the value shows on the harder
cases — auth/ai/scale traps — where frontier models fail and the specialist repairs them.)

Reproduce: `ANTHROPIC_API_KEY=... python demo/live_demo.py <taskId>` (needs the model served).
