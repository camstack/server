---
id: D467
title: A fan-out counter names its unit, and PRODUCTION is counted per emit — never per (event × child)
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/event-plane-report.ts
last-verified: 2026-10-02
---

## Context

The `[mem] hub-main` heartbeat has printed `fanoutSent` / `fanoutSuppressed`
since D-prior work on the event plane. On 2026-09-12 ~00:30, at night, it read:

```
children=39 fanoutSent=16346 fanoutSuppressed=433461 crossNodeDelivered=3265
```

That was read, by an operator and by this session's brief, as *"hub-main
generates 290 000–457 000 events a minute and throws 97% away"* — a number that
frames the event plane as the dominant load on the process and makes the
filtering fanout look like a band-aid over a runaway producer.

**It is off by a factor of 38.** `broadcastEventToChildren` increments `sent` or
`suppressed` once per *(event × child)* pair, inside the per-child loop. With 39
children, ONE emit produces up to 38 counter increments. The same line proves it
without any new code: every pure-consumer child's `sent + suppressed` converges
on the same number —

| child | sent | suppressed | sum |
| --- | ---: | ---: | ---: |
| recorder | 2313 | 9417 | **11 730** |
| homeassistant-export | 2204 | 9526 | **11 730** |
| export-hap | 884 | 10846 | **11 730** |
| pipeline-orchestrator | 5792 | 4649 | 10 441 |
| pipeline-analytics | 4178 | 6006 | 10 184 |

— because that sum IS the number of distinct broadcasts. The two low rows are
the two producers, which do not receive their own emits (1 289 and 1 546
originations respectively). **Real production: ~11 700 events/min ≈ 195/s.**
Not 300–450k.

Two further measurements, taken before changing anything:

- **A suppressed pair costs 255 ns** (micro-benchmark of `matchesPattern` over a
  6-pattern declared set against a non-matching category, 2 × 10⁷ iterations).
  At 7 224 suppressed pairs/s that is **1.84 ms/s — 0.18 % of one core.** The
  filter is not the cost, and "suppressed" is not a debt.
- **The event plane is a rounding error next to RPC on the same sockets.** Same
  line, same minute: `socketTx evt=16346 msgs / 10 986 kB` against
  `socketActions=111 294 calls / 144 638 kB`, of which
  `audio-analyzer!stream-broker.pullAudioChunks` alone is **24 260 kB/min** —
  more than twice the entire event plane's outbound bytes.

What the counters could NOT answer is which categories those ~195 events/s are,
and how many children want each. `fanoutTop` names subscribers; nothing named
producers. Attributing it by hand from the declared pattern sets in the boot log
(all 39 children, zero wildcards, `childrenUndeclared=0`) puts **roughly half of
production in categories no forked child subscribes to** — but that is an
inference from five simultaneous equations, not a measurement, and it is exactly
the kind of number that should not be acted on unmeasured.

## Decision

A fan-out counter states its unit, and production is counted **once per emit,
outside the per-child loop**. `LocalChildRegistry` keeps a per-category census
(`categoryFanout()`: `category → { broadcasts, wanted }`, plus
`categoryCensusOverflow()`), and the heartbeat prints `fanoutEvents=` — the
true production rate — alongside the (event × child) pair counters it already
had, so the pair counters can never again be read as a production rate.

`wanted` is the SUBSCRIPTION answer, not the delivery answer: `childWantsEvent`
(which `broadcast` mode forces true) and `childSubscribesTo` (which it does not)
are separate functions, so the census reports the truth under every fan-out
mode. A category whose `wanted` is 0 over a window was serialised and walked
across all 39 children and **no child asked for it** — `fanoutOrphans=` and
`fanoutOrphanTop=` name that, at zero as well as above it, because a branch that
accepts work and produces nothing is a branch that drops work.

**The negative result is the finding.** The event plane is not the load, the
filter is correct, and no category is silenced on the strength of an inference.
The next session reads `fanoutCats=` / `fanoutOrphanTop=` off the live line.

## Consequences

- The census is bounded at `CATEGORY_CENSUS_MAX` (256 — `EventCategory` is a
  closed enum of ~120). Overflow is counted, printed as `fanoutCatsDropped=`
  and logged ONCE, never silently dropped; a non-zero value is itself the
  detector for a hand-rolled topic.
- `ChildFanoutRegistry` grows two members, so any structural implementer (the
  heartbeat's fakes) must supply them. That is deliberate: a reader that could
  omit the census would print a plane it had not read.
- `wanted === 0` means "no forked CHILD subscribes". hub-main's own bus — the
  admin-UI WebSocket, the alert centre, the `recent[]` ring — is a consumer the
  census does not see, so an orphan is a fan-out-walk waste, not proof nobody
  anywhere reads the category. Do not delete an emit on this counter alone.
- Six fields were added to a line already ~1.5 kB. `fanoutEvents`,
  `fanoutOrphans` and `fanoutCatsDropped` are unconditional (absence must not be
  ambiguous); `fanoutCats` and `fanoutOrphanTop` are single comma-separated
  values capped at `EVENT_PLANE_TOP_N`, so the field COUNT is stable.

## Enforcement

Unit tests, both layers. `local-child-registry.spec.ts` pins that a broadcast
counts once regardless of child count, that an unsubscribed category reports
`wanted: 0`, that `broadcast` mode does not launder an orphan into a wanted
event, and that census overflow is reported rather than dropped.
`event-plane-report.spec.ts` pins the delta arithmetic, the orphan total at zero
and above it, and the formatted field names. Nothing guards the misreading
itself — that is what `fanoutEvents=` on the line is for.
