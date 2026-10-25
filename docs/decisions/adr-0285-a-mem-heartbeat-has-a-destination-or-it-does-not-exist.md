---
id: D285
title: A `[mem]` heartbeat has a DESTINATION, or it does not exist — and hub-main's sink is handed over, never delayed
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/system/src/kernel/heap-watch.ts
  - server/backend/src/main.ts
  - scripts/check-mem-heartbeat-has-a-destination.ts
---

## Context

hub-main is the largest process in the cluster — ~4.8 GB RSS, ~2 cores — and for
42 hours of Loki it was the only one with no `[mem]` line at all. Its growth was
therefore never trended; every diagnosis of it was inference from code.

The first assumption was that the watch had never been wired to the composition
root, because `startHeapWatch` looks runner-shaped: `startRunnerHeapWatch` wants
a heap profile, an RSS budget carried in an env var and a runner nodeId, none of
which hub-main has. That assumption was wrong, and it is the useful part of this
record. The watch had been running in hub-main since 2026-08-02, from the first
statement of `bootstrap()`, with the right label, a declared 4096 MB budget, a
proven reclaimer and the full-fidelity line. What it had was no **sink**:

```ts
startHeapWatch('hub-main', undefined, …)   // ← argument 2
```

`undefined` selects `consoleSink`, i.e. `console.log`. `console.log` is not an
`ILogDestination`. It bypasses the ring buffer, the console destination, the
rotated file and the Loki destination alike, so the line was written to a file
descriptor and to nothing that ships. Every forked runner passes a sink backed by
its `IScopedLogger` (`packages/system/src/kernel/moleculer/addon-runner.ts:729`),
which is the entire difference between a runner that is trendable and a hub that
is not.

Nothing caught it. `typecheck`, `test`, `lint` and `docs:check` were green for
the whole 27 days, because "the sink argument defaults to console" is a legal,
type-correct, well-tested expression. The heartbeat had a spec asserting a mock
was called; the mock was always called.

The obvious repair — start the watch later, once `LoggingService` exists — is
wrong for the reason the watch exists at all: the fatal that motivated it landed
nine seconds after a viewer connected, and `LoggingService` is not available
until the Fastify app has booted, hundreds of lines into `bootstrap()`. Delaying
the start would trade the invisible steady state for an invisible boot.

## Decision

Every production `startHeapWatch` call passes a sink that reaches the log
manager; `undefined` (console-only) is not an acceptable production sink. Where a
process starts its watch before a logger exists — hub-main is the only one — the
sink is a `createDeferredHeapWatchSink()`: it writes to stdout until
`LoggingService` exists and is then **handed over**, once, announcing the
handover through the new target. The start is never delayed to obtain a logger.

hub-main keeps the label `hub-main`. A runner label is its nodeId and a nodeId is
built in exactly one place as `` `${parentNodeId}/${runnerId}` ``
(`packages/system/src/kernel/moleculer/addon-runner.ts:222`), so every runner
label contains a `/`; a label without one cannot be produced by that rule and is
unambiguous by construction. It also sorts immediately ahead of the whole `hub/`
family, which puts the composition root before the runners it forked.

## Consequences

- One vocabulary. hub-main's line carries exactly the fields a runner's carries —
  `rss`, `heapUsed`, `heapTotal`, `heapLimit`, `used%`, `external`,
  `arrayBuffers`, `rssBudget`, `loopP50`/`loopP99` — so the two are comparable in
  one LogQL query and `stranded = rss − heapUsed − external` is computable from
  either.
- The boot window is still stdout-only and says so: the handover line states that
  earlier lines are not in the buffer, the rotated file or Loki. It is also the
  only in-band evidence the wiring is live on a given boot.
- Lines emitted between the handover and the Loki addon's own registration are
  not lost: `LogManager.addDestination` replays the ring buffer into a
  destination that registers late.
- Cost is one extra indirection per emitted LINE (measured +0.6 ns/call against a
  direct sink), not per probe. The probe itself is unchanged at ~1.14 µs, of which
  ~0.95 µs is `process.memoryUsage()`, once per 2 s.
- What this does **not** buy: the reclaim pass on hub-main is
  `gc({ execution: 'sync', flavor: 'last-resort' })` — V8 only. It returns the 256 KB pages V8
  committed at a sawtooth peak (~1.3 GB of the 4.87 GiB measured 2026-08-27) and
  touches none of the ~2.8 GB of glibc memory already freed and never returned to
  the kernel. Nothing in this repository calls `malloc_trim`. The heartbeat makes
  that split visible; it does not close it.
- Not affected: the Cluster page's Load tab and `metrics:node-load-samples`
  already include hub-main (the `__root__` / "Node supervisor" bucket), and they
  sample `ps` rather than parsing log lines — a `[mem]` line changes nothing
  there, in either direction.

## Enforcement

`scripts/check-mem-heartbeat-has-a-destination.ts`, wired into the repository
guards in `.github/workflows/ci.yml`. It parses every production
`startHeapWatch(` call's argument list and fails when argument 2 is absent or
`undefined`, and additionally requires hub-main's call site to build a
`createDeferredHeapWatchSink` and `attach` it — a deferred sink that is never
handed over passes the first rule on a technicality. Tests are exempt, because a
spec asserting the console fallback is exactly the call the guard must not
forbid.

Behaviour is pinned by
`packages/system/src/kernel/__tests__/heap-watch-sink.spec.ts`, which asserts
through a real `LogManager` into a real `ILogDestination` rather than into a mock.
