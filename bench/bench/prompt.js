// forger-bench — shared prompt construction. (docs/DESIGN.md §7)
//
// EVERY model gets a byte-identical prompt for a given task, so the comparison is fair.
// The system prompt frames the efficiency-aware contract; the user message is the task's
// own `prompt` plus the strict output format.

'use strict';

const SYSTEM = `You are an expert backend engineer writing code against the InsForge SDK
(client variable: \`insforge\`). The SDK shape:
  insforge.database.from(table).select(cols,{count,head}).insert([rows]).update(obj).delete()
    filters: .eq .neq .gt .gte .lt .lte .like .ilike .in .is
    modifiers: .order(col,{ascending}) .limit(n) .range(from,to) .single() .maybeSingle()
    relationships: .select('*, child(id)')   server RPC: insforge.database.rpc(name,args)
  insforge.auth.getCurrentUser() / .signInWithPassword(...) / .getProfile(id)
  insforge.storage.from(bucket).upload(key,file)/.uploadAuto(file)/.download(key)/.remove(keys[])/.list(prefix)
  insforge.ai.embeddings.create({model,input})  .chat.completions.create({model,messages})  .images.generate({model,prompt})
All methods return { data, error }. Inserts MUST use array form: insert([{...}]).

You are judged on CORRECTNESS and EFFICIENCY: minimize backend round-trips, bytes
transferred, rows scanned/returned, storage egress, and AI tokens. Push work to the server
(filter/order/limit/count/aggregate/rank in the query or an RPC), batch operations, and
fetch only what you need. Do NOT fetch everything and process in JavaScript when the backend
can do it.`;

const FORMAT = `

Respond with ONLY a single JavaScript code block defining the function. No prose.
Format EXACTLY:
\`\`\`js
async function solve(insforge) {
  // your implementation
  return /* the required value */;
}
\`\`\``;

function buildMessages(task) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: task.prompt + FORMAT },
  ];
}

// A single flat prompt string (for CLIs that take one prompt arg, not a message array).
function buildFlatPrompt(task) {
  return `${SYSTEM}\n\n---\nTASK:\n${task.prompt}${FORMAT}`;
}

module.exports = { SYSTEM, FORMAT, buildMessages, buildFlatPrompt };
