---
id: D290
title: A progress event is produced for a caller that asked, not because a bus exists
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/provider.ts
---

## Context

`runPipeline` builds a local `emit()` helper that fires
`EventCategory.PipelineProgress` with a human-readable string, and gates it on
`this.eventBus?` — i.e. on the bus existing, not on anyone wanting the line.
Four of its ~15 call sites (`provider.ts:2301`, `provider.ts:2438`,
`provider.ts:2556`, `provider.ts:2602`) run **before** the executor branch at
`provider.ts:2717`, whose own comment says the runtime path "skip[s] the
benchmark-only per-step progress spam". The late sites obey that comment. The
four early ones predate it and never did.

Measured on the live hub on 2026-08-29 (`systemEvents.subscribe`, two windows):
**107.7–112.3 `pipeline.progress` events/s**, every payload carrying a
per-frame minted `run-<ms>-<rand>` session id and a `nodeId` naming a detection
runner — the live camera path, not a UI run. Each was offered to all 38 forked
runners: **~4 200 delivery decisions/s, 36 % of the whole event plane** in that
window (11 691 decisions/s). 71 % of it was produced on an agent and crossed
Moleculer to hub-main first.

Delivered to **nobody**. That is not a grep: the kernel's own per-child counters
put the busiest runner in the registry at 5 394 deliveries/min = 89.9/s across
**all** categories combined, and `fanoutTop` is ranked by `sent`, so no runner
can be receiving a 112/s category. Both intended consumers are admin-UI React
tabs subscribing in-process through `trpc.live.onEvent` — which the UDS plane
never touches — and both discard every payload whose `sessionId` is not the one
they asked for (`ImageTab.tsx:308`, `CapacityTab.tsx:256`). The one intended
consumer threw all of it away.

The first fix considered was the doc's literal wording — move the four calls
inside the `isRuntime` branch. It is wrong: `runPipelineBatch`
(`provider.ts:3622`) and the capacity ramp (`pipeline-runner/index.ts:1937`)
send a raw `frame` **and** their own `sessionId`, so `isRuntime` is true for
runs an operator is watching, and that gate would have silently blanked a
benchmark. A UI that stops updating without saying so is worse than the load.

## Decision

A per-frame telemetry event is produced when a **caller asked for it**, and the
"asked" is the caller's own correlation id — not the existence of a bus, not a
subscriber count, not a verbosity flag. `runPipeline` emits `pipeline.progress`
on the bus when the run is not a runtime dispatch **or** when `input.sessionId`
was supplied; the live camera path supplies neither and produces nothing. The
in-process `onProgress` closure is unaffected — it costs no delivery decision,
so it keeps every line, and "not fanned out" stays distinguishable from "not
produced".

The gate is computed **once**, above `emit`, and the executor branch reads that
same const instead of re-deriving it. Two copies of one gate is how the four
early emits came to disagree with the comment 300 lines below them.

## Consequences

- Removes ~4 200 delivery decisions/s (36 % of the plane as measured), ~330
  Moleculer broadcasts/s, and ~78 events/s of hub-main's cross-node inbound.
  `fanoutSent` must **not** move: it is already zero for this category, and a
  drop in `fanoutSent` after deploy falsifies the "no subscriber" claim.
- The admin Events viewer (`ui-library/src/composites/event-stream.tsx:322`)
  stops showing runtime `pipeline.progress` lines. `pipeline.progress` is on
  `RING_BUFFER_DENY_PATTERNS` (`event-bus-core.ts:247`), so nothing was ever
  retained; per D8/D11 this category is telemetry and droppable by contract.
- A future fifth call site inherits the gate for free, because the gate is in
  `emit` and not at the call sites.
- This says nothing about the categories that *do* have a live browser consumer
  and no runner consumer. Those are still offered to 38 runners and still
  wanted by none of them; they are addressed by the category→children index
  (`docs/design/2026-08-29-event-bus-fanout-load.md` §6), not by not emitting.

## Enforcement

`packages/addon-pipeline/src/detection-pipeline/__tests__/runpipeline-progress-fanout.spec.ts`
pins both edges: a `frameRef` run with no `sessionId` emits nothing on the bus
while still calling `onProgress`, and a `frameRef` run **with** a `sessionId`,
plus a plain image run, emit every line. Reverting the gate reddens the first
pair; narrowing it to `!isRuntime` reddens the second. Nothing catches a NEW
category emitted unconditionally on the frame path — that is review only, and
the instrument for noticing it is `fanoutSuppressed` on hub-main's `[mem]` line.
