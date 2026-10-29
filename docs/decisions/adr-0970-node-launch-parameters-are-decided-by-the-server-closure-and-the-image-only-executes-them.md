---
id: D970
title: Node launch parameters are decided by the server closure, and the image only executes them
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - server/backend/src/launch-args.ts
  - Dockerfile
  - packages/desktop/src/launch-args-client.ts
---

## Context

The agent heap ceiling first shipped as a formula copied into three launchers: the
Docker entrypoint (shell), the Electron shell (`agent-heap-flag.ts`) and the
Windows service supervisor. Each copy needed a parity spec, and changing the
number meant a new image AND a new app, although everything else about a node
updates through the server closure. The hub ceiling had the same shape: a
hardcoded 1536 MB killed the hub four times in 15 h, and the fix lived in an image
comment nobody rebuilds to read.

## Decision

What a node's `node` process is launched with is decided by ONE module in the
closure, `@camstack/server/dist/launch-args.js`
(`node launch-args.js --role hub|agent [--allocator-env]`). It prints
`arg` / `env` / `source` / `warn` records; every launcher is a thin executor that
runs it, validates what came back, and applies it. A launcher carries no formula.

- Heap ceiling precedence: the per-node override file `<dataDir>/launch-overrides.json`
  (`{ "heapMb": N }`, set from the hub through `serverManagement.setLaunchOverrides`),
  then the legacy `CAMSTACK_HUB_HEAP_MB` / `CAMSTACK_AGENT_HEAP_MB`, then the agent's
  computed clamp(min(RAM, cgroup)/4, 1536, 4096) MB, or V8's default for the hub.
- The allocator pair `MALLOC_ARENA_MAX=2` + `VIPS_CONCURRENCY=1` comes from the same
  module (an operator value wins); it must exist before `exec node`, which is why
  the module, not hub-main, decides it.
- The chosen source reaches the node as `CAMSTACK_HEAP_CEILING_SOURCE` and the
  `[mem]` boot line says `heap ceiling = XMB, set by <source>`.
- Heap flags go on argv, never `NODE_OPTIONS`; the loader and the shell
  (`LD_*`, `DYLD_*`, `NODE_*`, `PATH`, `HOME`, `SHELL`, `IFS`, `USER`) are never the
  closure's to set.
- FAIL OPEN: a missing module, a non-zero exit, a timeout or garbage output means
  no extra args and one log line. The active closure's module wins over the baked seed.

## Consequences

A change to the formula or a node's ceiling needs a closure update and a restart,
never an image or an app. The one-time cost is a last image/app update that ships the
thin launchers. A node whose closure predates this module runs on the seed copy.

## Enforcement

`server/backend/src/__tests__/launch-args.spec.ts` runs the real Dockerfile entrypoint
block through `sh` and asserts the image holds no formula;
`packages/desktop/src/__tests__/launch-args-client.test.ts` pins the fail-open
launcher and that `main.ts` and the supervisor call it.
