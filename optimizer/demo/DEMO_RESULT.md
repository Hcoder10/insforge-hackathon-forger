# Live Demo Result

**Flow:** an author model writes a solution, forge-optimizer rewrites it, and forger-bench
grades both live.

## Task: auth.owner_scope.test1

"Return the current user's own rows from `todos` (column user_id) as {id}[]."

## Step 1: author model output

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

**Benchmark: score 0. Incorrect, reward -1.**

## Step 2: forge-optimizer output

forge-optimizer rewrote it into a passing owner-scoped query.

**Benchmark: score 100. Correct, reward 3.**

## Result

| Model | Benchmark score | Correct |
|---|---:|---|
| author model | 0 | no |
| forge-optimizer | 100 | yes |

**+100 improvement.** The optimizer fixed the failing solution, verified live by the benchmark.

Reproduce:

```bash
AUTHOR_URL=http://127.0.0.1:11500 AUTHOR_MODEL=nemotron-3-super:latest python demo/live_demo.py <taskId>
```
