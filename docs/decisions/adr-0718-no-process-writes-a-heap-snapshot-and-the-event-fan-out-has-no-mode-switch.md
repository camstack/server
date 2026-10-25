---
id: D718
title: No process writes a heap snapshot, and the event fan-out has no mode switch
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/system/src/kernel/heap-spaces.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/moleculer/event-bus.ts
  - scripts/check-no-retired-fanout-heap-env.ts
  - scripts/check-no-heap-dump-command.ts
---

## Context

**Heap snapshots.** `metricsProvider.dumpHeapSnapshot` and the SIGUSR2 writer
behind `CAMSTACK_RUNNER_HEAP_SNAPSHOT=on` serialised a runner's V8 heap to
disk. On the recorder (1.8 GB heap) that is a stop-the-world walk plus a
multi-gigabyte write. Both times it was used in production the hub stopped
answering. The second time (2026-09-03) left a 0-byte file and a host that had
to be rebooted. The cap method and the writer were deleted that day and
`scripts/check-no-heap-dump-command.ts` was added. What was left was the
authorising env var's documentation, an `env` field on the SIGUSR2 report's
dependencies that nothing read, and a test that still passed that flag in. The
operator asked again on 2026-10-06 for every trace of the feature to go.

**Fan-out modes.** `CAMSTACK_UDS_EVENT_FANOUT` and
`CAMSTACK_MOLECULER_EVENT_FANOUT` each chose `filter | shadow | broadcast` for
one event plane. `shadow` was a burn-in: compute the drop decision, count it,
deliver anyway. The cross-node burn-in was shipped in every template and ran
for over a month with no end condition. On the hub it never changed anything,
because hub-main retains every category. The UDS plane was already on
`filter`, because nothing set its variable.

## Decision

No CamStack process writes a heap snapshot, by any route: no cap method, no
tRPC route, no UI action, no signal, no environment flag. SIGUSR2 reports the
memory and per-space numbers and nothing else. Finding out what a runner
RETAINS needs a process that is not serving cameras.

Both event planes always filter. A category no local subscriber declared is
dropped and counted as `suppressed`; an undeclared child still fails open. The
two environment variables, the `shadow` and `broadcast` modes, and the regime
field on the event-plane heartbeat line (`fanoutMode=`) are gone.

## Consequences

- Agents that ran with the template's `CAMSTACK_MOLECULER_EVENT_FANOUT=shadow`
  now drop cross-node categories that none of their subscribers asked for.
  That was the burn-in's intended end state. The hub's behaviour is unchanged,
  because it retains everything.
- A starved subscriber can no longer be worked around by flipping an
  environment variable. The fix is to declare the subscription, which is where
  the bug was in any case.
- A heap snapshot of a production runner is no longer possible. Investigating
  retained objects needs an offline copy of the process.

## Enforcement

`scripts/check-no-heap-dump-command.ts` refuses `writeHeapSnapshot` /
`dumpHeapSnapshot` anywhere in `packages`, `server` and `scripts`.
`scripts/check-no-retired-fanout-heap-env.ts` refuses a non-comment runtime
mention of `CAMSTACK_RUNNER_HEAP_SNAPSHOT`, `CAMSTACK_MOLECULER_EVENT_FANOUT`
or `CAMSTACK_UDS_EVENT_FANOUT`. The filter behaviour itself is pinned by
`local-child-registry.spec.ts` and `cross-node-event-filter.spec.ts`.
