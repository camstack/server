---
id: D179
title: start() means the intake is OPEN, never that the back-fill has finished
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/outbox.ts
---

## Context

`addon-runner` appends a child's manifest entry only after
`await addon.initialize(context)` RETURNS, so an `initialize()` that does not
return does not delay a feature — it takes every capability that addon declares
off the cluster (see [D167](adr-0167-boot-fans-out-nothing-serialises-on-a-read-that-cannot-answer.md) and the 2026-08-14 incident in
`../history/sessions.md`). That incident was fixed at the two PRODUCERS:
`TimelapseScheduler.start()` and `NcSummaryProducer.start()` now arm their boot
tick and hand the back-fill to the background.

The same shape survived one level up, in `NotificationCenter.start()` itself.
Measured on the live hub 2026-08-17 at **zero transport contention** (one UDS
timeout in the entire boot, so it was work and internal waits, not a queue):

```
pipeline-analytics boot step  step=buildNotificationCenter  ms=270000
```

Every second of it was durable back-fill inside `start()`: the liveness ledger
reseed (775 subjects), the outbox hydration (743 rows), the cooldown seed, and
two N+1 per-device refresh loops — `readDeviceStates` and `readDeviceZoneIds`
issue **one RPC per watched device, serially**. For 270 s the cluster had no
provider for `notification-rules`, `pipeline-analytics`, `zone-analytics`,
`audio-metrics`, `videoclips`, `face-gallery` or `plate-gallery`, and the intake
was not open either — nothing arriving in that window was late, it was never
evaluated at all.

**The first hypothesis was wrong, and it is worth recording.** The 270 s step
contained the line `alarm panel wired to the notification center` at t+167, and
that read as `buildNotificationCenter` waiting on the alarm panel declaration
(armed in the background since the same morning, retrying on a 60 s ladder). It
does not. `armAlarmPanelDeclaration` is `void`-ed on the boot path; the
boot-order `wireAlarmPanel` call returns immediately when the panel does not
exist yet, silently; and the LATE join is already event-driven — the ladder's
own `attemptAlarmPanelDeclaration` calls `wireAlarmPanel` when it lands. The
log at t+167 came from the ladder, on its own clock, and told us nothing about
the step at all. A boot step with no internal timing cannot be attributed from
a line emitted by an unrelated background task.

## Decision

`NotificationCenter.start()` resolving means **the centre is EVALUATING**: the
text catalog, the rules, the snooze windows, the per-camera mutes and the
timelapse/summary rule sets are loaded, `evaluationActive` is true, and the
drain + rule-reload timers are armed. It never means the durable back-fill has
finished.

Only reads a notification cannot be CORRECT without stay on that path, and each
is ONE store query. Everything else — the device directory, the liveness ledger
reseed, the occupancy hydration, the outbox horizon, the cooldown seed, the zone
ownership and device-state refreshes, the crash-gap reconcile and the retention
prune — is armed as a single sequential background pass (`runBootBackfill`),
ordered by what a cold mirror COSTS, and each phase reports its own ms.

Two invariants make that safe, and they are the price of the rule:

1. **No duplicate.** The outbox dedup horizon (`knownIds`) is what implements
   the durable `maxPerTrack: 1` guarantee (D-3), and it is cold until the load
   lands. So while `NcOutbox.hydrated()` is false an `enqueue` asks the STORE
   whether the dedup id already exists instead of upserting over it; and a load
   that lands with a stale snapshot SKIPS every id this process already knows,
   because RAM is newer than the query. The boot reconcile is additionally
   bounded at its late end by the instant the intake opened — a record persisted
   since then was evaluated live, and replaying it would run the rule's
   `onTrigger` sequences a second time (they actuate BEFORE the cooldown gate
   and before any dedup).
2. **No loss.** The load only ever ADDS to `pending`, so a row enqueued while
   the query was in flight survives it; and the 2 s drain tick delivers whatever
   is in `pending`, hydrated or not.

## Consequences

**What it costs.** For the duration of the back-fill each mirror is COLD, and
every cold behaviour was already defined — this makes those windows reachable in
production rather than only between ticks:

| Cold mirror | Cost in the window | Direction |
| --- | --- | --- |
| liveness ledger | a genuine offline is seeded silently instead of notified | silence ([D130](adr-0130.md): fail toward discard; device liveness is additionally held 5 min by `DeviceLivenessHoldoff`) |
| occupancy state | a confirmed edge re-announces | one repeat |
| cooldown map | a rule can fire again inside its window | one repeat |
| zone ownership | a zone-scoped rule evaluates camera-wide | wider verdict |
| device states | a gated rule does not fire | silence |

They are ordered most-expensive-first for exactly this reason. All of it is
strictly better than the alternative it replaces, which was 270 s of a closed
intake and an unpublished manifest.

**What it forbids.** No await inside `start()` whose cost scales with the
installation — no per-device loop, no full-table read, no render, no poll. A new
boot-once hydration goes in `runBootBackfill` with its phase name, or it needs a
reason stated at the call site.

**What must stay true elsewhere.** `stop()` clears `evaluationActive`, and
`runBootBackfill` checks it between phases — a shutdown mid-hydration abandons
the rest rather than writing mirrors nobody reads. A caller that genuinely needs
the hydrated state asks for it (`whenHydrated()`), and every spec about a reseed
does exactly that.

## Enforcement

Two tests, both of which reproduce the live failure as a TIMEOUT rather than as
an assertion about a duration:

- `pipeline-analytics/__tests__/boot-notification-center-never-blocks-init.spec.ts`
  — the boundary that actually broke: hold ONE notification-centre collection's
  read open forever and require `initialize()` to return inside 5 s.
- `notification-center/__tests__/start-does-not-wait-for-the-backfill.spec.ts`
  — the two dedup invariants, each proved by removing the guard: an enqueue
  against a cold horizon must not resurrect a delivered row, and a load landing
  with a stale snapshot must not re-queue one.

The producers' half of the same rule is pinned by
`notification-center/__tests__/boot-backfill-never-blocks-start.spec.ts`.
`startInitWatchdog` (`packages/system`, `kernel/moleculer/init-watchdog.ts`)
names any surviving stall 60 s in. No guard script — review only.
