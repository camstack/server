---
title: Public docs drafts — Benchmark (+ OSD note)
date: 2026-10-05
note: >
  The public site lives in the camstack/docs repo (not this workspace).
  Paste/adapt these sections into content/docs/tools/. OSD Manager public page
  already exists; fix broken cameras/osd-manager links to tools/osd-manager.
---

# Draft: content/docs/tools/benchmark.mdx

```mdx
---
title: Benchmark
description: Measure real inference capacity per node and accelerator.
---

# Benchmark

Benchmark answers a concrete question: **how does this accelerator behave under
CamStack's real pipeline path?** It is a hub Admin tool under
**Detection → Benchmark**.

## Before you start

- The hub runs `@camstack/addon-benchmark`.
- The node you measure must run a current `@camstack/addon-pipeline` (it hosts the pipeline runner).
- Every run picks a **node** and an **inference device** (GPU, NPU, Coral, …) —
  the same keys as Pipeline → matrix and Model Studio → Installed.

CamStack does **not** let Benchmark override the node's engine. What you measure
is what cameras would actually get.

## Tabs

| Tab | Use it when |
| --- | --- |
| Detection Pipeline | You want latency / throughput for a step tree on one device |
| Capacity Ramp | You want to know how many concurrent sessions the node can hold |
| Session Replay | You want to replay a recorded session against a chosen device |
| Audio | You are checking the audio classification path |
| WebRTC | You are smoke-testing signalling / media (not inference) |
| History | You want prior runs stored on the hub |

## Related

- [OSD Manager](/docs/tools/osd-manager) — camera text overlays (different tool)
- Model Studio — install and activate models on those same accelerators
- Pipeline — the live matrix that Benchmark is measuring against
```

# OSD public docs — ops note

- Page OK: `content/docs/tools/osd-manager.mdx` (parity with server
  `docs/architecture/osd-manager.md`).
- **Bug:** links from cameras / vendors that point at
  `/docs/cameras/osd-manager` — that path is missing. Either add a thin
  redirect page or retarget every link to `/docs/tools/osd-manager`.
