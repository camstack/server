---
id: D176
title: Every spawn has an error listener, and a runner that gives up is announced
status: accepted
date: 2026-08-18
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/spawn-failure.ts
  - packages/addon-pipeline/src/recorder/addon/segment-writer.ts
  - packages/addon-pipeline/src/recorder/addon/export-engine.ts
  - packages/system/src/kernel/moleculer/process-service.ts
---

## Context

At 11:45 on 2026-08-18 the recorder was healthy. The operator unplugged three
cameras from his router. Between 11:46:49 and 11:46:58 the hub logged:

```
[recorder] [addon-runner CRASH] uncaughtException: spawn ffmpeg EAGAIN   (x3)
ERROR hub/BROKER: [recorder] Process exited (code=1, signal=null)          (x3)
ERROR hub/BROKER: [recorder] Process exited (code=null, signal=SIGABRT)
ERROR hub/BROKER: [recorder] Crash circuit-breaker tripped — 5 crashes in 60000ms. Not respawning.
```

Recording then stayed dead for **three hours and fifteen minutes**, until a
manual redeploy. Every recording capability answered `provider not available`
the whole time, `/health` returned 200 throughout, and the only signal that ever
reached the operator was his phone failing to load recordings that evening.

Two independent failures, each individually survivable:

1. `SegmentWriter.start()` attached listeners for `stderr` and `exit`, but not
   for `error`. In Node a child that cannot be spawned emits `'error'`, and an
   `'error'` with no listener is re-thrown as an uncaught exception — so three
   cameras re-dialling at once, on a host that momentarily could not fork,
   killed the runner three times. The bitter part is that the `exit` branch
   already implemented the right policy, in a comment that says so: "only RAPID
   back-to-back failures count toward giving up, so a brief blip never
   permanently stops a camera's recording". The design intent was already to
   survive this; the `error` path simply bypassed it. `export-engine.ts`, in the
   same runner, had the same hole.
2. The D6 crash circuit-breaker then did exactly what it should — bound the
   respawns and mark the runner terminally `failed` — and told nobody. A
   terminal state that nothing announces is indistinguishable from a healthy
   system with nothing to say.

## Decision

**Every `child_process` spawn attaches an `'error'` listener that funnels into
the same failure policy its `'exit'` already uses, and classifies the failure
through one shared predicate** (`readSpawnFailure`, `spawn-failure.ts`):
transient codes (`EAGAIN`, `EMFILE`, `ENOMEM`, and anything unrecognised) take
the ordinary restart-with-backoff path; `ENOENT` / `EACCES` mean the binary
cannot be executed on this node, so the caller stops at once and says so at
ERROR level rather than burning a ten-attempt budget on a fact that will not
change. There is never a second restart policy for spawn failures.

**And a runner the crash circuit-breaker refuses to respawn emits
`EventCategory.AddonRunnerFailed`** — one event per TRIP, not per hosted addon —
which the Notification Center maps to the `addon-crash-loop` system-event kind.
The breaker itself is unchanged: bounding respawns stays (D6), being silent
about it does not.

## Consequences

- A transient fork failure now costs one backoff, not a runner. An unknown
  errno is treated as transient on purpose: retrying something permanent costs a
  bounded budget, while giving up on something transient costs a camera.
- `EPERM` is deliberately classified transient — it is reported for sandbox and
  cgroup refusals as well as for real permission faults, and an ambiguous code
  treated as permanent stops a camera that would have recovered.
- The notification kind is node-scoped and carries no device: a runner is not a
  camera. It is narrowable by `nodeIds` only, which
  `systemEventFilterApplies` now states, and it has no paired "recovered" kind —
  nothing clears it but an operator.
- Under transient pressure the recorder REDUCES its attach concurrency
  (`SpawnPressureGovernor`) rather than insisting. It must never go back to
  serial attach: moved away from that because one unpublished
  camera stalled the whole fleet for 223 s.

## Enforcement

Tests, not a guard, and they are behavioural rather than structural — a test
that asserts "a listener is registered" would pass against a listener that
rethrows. `segment-writer-spawn-error.spec.ts` and
`export-engine-spawn-error.spec.ts` drive a real `EventEmitter` child (the only
fake with Node's "unhandled `'error'` throws" semantics) and assert the emit
does not throw AND that a retry is scheduled / the export fails.
`process-service-breaker-event.spec.ts` crashes a runner five times through the
real `CrashSupervisor` and asserts exactly one `addon.runner-failed`.
`scripts/check-nc-system-filter-scope.ts` covers the new kind's filter scope
automatically (it iterates every kind x filter pair).

A structural guard — "every `.spawn(` in a runner has an `'error'` listener" —
is worth writing and is NOT written: the spawn sites reach their child through
injected `spawn` deps of several shapes, and a textual guard over those would
under-report exactly where a new shape appears.
