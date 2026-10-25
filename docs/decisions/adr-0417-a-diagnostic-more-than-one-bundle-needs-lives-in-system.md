---
id: D417
title: A diagnostic more than one bundle needs lives in @camstack/system — one home, and the deploy order is closure first
status: accepted
date: 2026-09-09
supersedes:
applies-to:
  - packages/system/src/kernel/event-loop-stall-monitor.ts
  - packages/system/src/addon-utils.ts
  - packages/addon-pipeline/src/detection-pipeline/index.ts
  - packages/addon-pipeline/src/recorder/addon/index.ts
  - packages/addon-pipeline/src/pipeline-runner/capacity/stall-sampler.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - server/backend/src/main.ts
---

## Context

`startEventLoopStallMonitor` was written for `detection-pipeline` (the
2026-08-01/02 fleet stall) and reused by `recorder`, whose field comment
recorded the reasoning at the time: **not promoted**, because both callers ship
in `@camstack/addon-pipeline` and moving it to `@camstack/system` would be "a
refactor with a slower ship chain, not a measurement". That was correct for two
callers in one bundle.

On 2026-09-09 two more processes needed it and neither shares that bundle:
`pipeline-analytics` (one process serving every camera, going silent for 10+ s
about three times an hour) and **hub-main**, on whose event loop every runner's
UDS request waits — so a hub-main freeze is delivered to every addon as "you are
slow", which is precisely the confusion the new frame-lag instrument exists to
break.

The alternative was a third copy. This repository already carries two
event-loop stall monitors — the function in `detection-pipeline` and the
`EventLoopStallMonitor` class in `stream-broker` — and they do not agree on what
they report. A third and a fourth, in bundles that ship independently, is how
two diagnostics end up disagreeing about the same freeze, at the exact moment
someone is trying to settle an argument with them. A move also turned up a
caller nobody had counted: `pipeline-runner/capacity/stall-sampler.ts` imports
`attributeStall` from it, across a directory boundary, and only the compiler
knew.

## Decision

A diagnostic that more than one bundle needs lives in `@camstack/system` and has
exactly ONE implementation. An ADDON reaches it through the
`@camstack/system/addon-utils` subpath — never the barrel, which drags the whole
kernel and every builtin (~64MB of heap) into a forked runner and is refused by
`biome-plugins/no-system-barrel-in-addons.grit`; hub-main, which is the
framework, imports it from the root. Copying one into an addon bundle to keep
its ship chain short is not allowed; the short ship chain is bought back by
deploying in order, not by forking the mechanism.

That subpath rule is also what constrains WHERE such a diagnostic may live: it
has to be a deep, kernel-free module (this one imports `node:perf_hooks` and a
type), or it cannot be re-exported from `addon-utils` at all.

## Consequences

`@camstack/system` is **external to every addon bundle** (`BARE_SYSTEM_EXTERNAL`
in `tools/build/vite-lib.preset.ts`), so an addon that imports this resolves it
from the installed server closure, not from its own `dist`. That makes the
deploy order load-bearing:

1. install the `@camstack/server` closure that carries the export, then
2. `camstack deploy` the addons.

Deployed the other way round, `addon-pipeline` and `addon-post-analysis` fail to
load the missing named export and the runner crash-loops until the
`CrashSupervisor` marks it `failed`. The cost is real and is the price of one
home; it is not a reason to copy.

Also: a diagnostic promoted to `@camstack/system` now ships on the closure
cadence, so its next fix reaches a running hub more slowly than an addon fix
would. Accept that for diagnostics. It is not an argument for putting
production logic there.

## Enforcement

`biome-plugins/no-system-barrel-in-addons.grit` refuses the barrel import from
any addon — it caught the first version of this change, which used the root
entry in all four callers. Nothing enforces the rest.  The compiler catches a stale relative import at build time
(it caught `stall-sampler.ts`), and
`packages/system/src/kernel/__tests__/event-loop-stall-monitor.spec.ts` plus the
three per-caller wiring specs (`recorder-stall-monitor.spec.ts`,
`analytics-stall-monitor.spec.ts`, `hub-main-stall-monitor.spec.ts`) assert each
process still arms it. Nothing prevents a fifth copy from being written; review
only. The two monitors that already disagree (`stream-broker`'s class and this
one) are NOT unified by this record — that is a real leftover, and the next
session that touches either should fold them together.
