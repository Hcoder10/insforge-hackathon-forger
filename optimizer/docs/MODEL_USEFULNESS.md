# Raw Model Usefulness Probe

This note summarizes a manual probe of the trained raw adapter outside the sealed benchmark.
It is not a benchmark score. It is a sanity check for whether the model is useful on normal
InsForge development prompts.

Artifact: `optimizer/results/manual_probe_20260613T134244Z.json`

## Setup

- Adapter: `/home/sarta/insforge-hackathon-forger/optimizer/train/grpo_adapter`
- Repair layer: disabled
- Date: June 13, 2026
- Prompts: 8
- Prompt types: code generation, code review, code repair, branch review

## Result

```text
directly usable: 3/8
useful with minor cleanup: 1/8
partially useful: 1/8
not safe to use: 3/8
```

## What Worked

- Storage metadata total: used `list()` metadata and avoided file downloads.
- Large database export: selected only needed columns, ordered server-side, and limited rows.
- Owner-scoped dashboard: used current-user auth data, projected columns, ordered, and ranged.
- Storage review prompt: correctly identified unnecessary per-file downloads.

## What Failed

- Image generation and storage: used the wrong image response shape and did not create real
  upload bytes.
- Vector search: passed raw query text as `query_embedding` instead of embedding the query.
- Multi-step repair: removed a storage delete and did not fix the current-user response shape.
- Branch review: started with useful feedback, then repeated itself until truncation.

## Readout

The raw adapter is useful for common InsForge efficiency patterns:

- server-side projection
- server-side pagination
- storage metadata instead of downloads
- concise review of obvious resource regressions

It is not dependable as an autonomous repair model. The weak spots are SDK response shapes,
image output handling, vector embedding setup, and preserving all behavior during repairs.

For judging, this supports a narrow claim: the model learned several project-specific
performance patterns. It does not support a claim that the raw model already beats Codex or
can safely repair arbitrary generated InsForge code without the verifier layer.
