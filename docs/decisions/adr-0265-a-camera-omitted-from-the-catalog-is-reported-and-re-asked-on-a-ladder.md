---
id: D265
title: A camera omitted from the stream catalog is REPORTED and re-asked on a ladder
status: proposed
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/catalog-pull-backoff.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
---

## Context

2026-08-25. Device 3629 ("Camera porta retro", Reolink) stopped answering
`stream-catalog.getCatalog`:

```
stream-catalog.getCatalog not routable to node hub/provider-reolink:
transport-failed (rejected: hub-local-uds=buildStreamCatalog:
buildVideoStreamOptions failed for device 3629: Baichuan request failed
(responseCode 400, empty body). Possible causes: expired session, …)
```

It repeated every 30 s for 35 minutes and never once succeeded.

**The fleet was never the victim, and that is the first thing this record has to
say plainly.** `reconcileAllCatalogs` fans out with `Promise.allSettled` and
`reconcileDeviceCatalogNow` catches its own pull, so exactly ONE device was
omitted from each pass; the other cameras were reconciled normally. The
fleet-wide symptom reported at the time (0 RTSP entries on all three nodes) is
not explained by this path and was not reproduced from the code. Writing "one
camera aborted the fleet catalog" into the record would have been comfortable
and false.

What WAS broken is everything around the omission:

1. **It was invisible.** The line was `logger.debug`
   (`reconcileDeviceCatalog: stream-catalog pull failed — will retry`). A camera
   with no catalog has no broker, and therefore no recording and no detection.
   For 35 minutes that camera was dark and nothing said so above `debug`.
2. **It could not recover.** `ReolinkCamera.ensureApi()` returns the CACHED
   client whenever `this.api` is set. A Baichuan session that expires under a
   socket that stays OPEN emits no `close` and no `error`, so
   `scheduleReconnect` — the only thing that nulls `this.api` — never fires.
   Every retry therefore re-used the same dead session. The 30 s poll was not a
   retry; it was 70 identical failures. Restarting the addon was the only cure.
3. **It hammered.** A flat 30 s cadence against a camera that had been refusing
   for half an hour, each attempt carrying two 10 s timeout budgets.

## Decision

A device whose `stream-catalog` pull fails is **omitted from that reconcile,
reported at `warn` with `tags: { deviceId }`, and re-asked on the shared
`BOOT_RECOVERY_BACKOFF_MS` ladder — clamped at its last rung, never exhausted**.
Only the POLL is throttled; an event-driven reconcile always attempts. And a
provider that believes its own session is the reason retries **exactly once**,
after invalidating that session, before it gives up.

Three consequences of that sentence, stated so they can be violated:

- The catalog pull is per device and its failure ends at that device — the
  fan-out is `Promise.allSettled`, the per-device reconcile catches, and every
  provider's `getCatalog` answers for one `deviceId` and refuses others.
- The omission is never below `warn` and never without the numeric `deviceId`
  tag.
- The ladder **clamps** where boot recovery **ends**. Boot recovery may run out
  because a node that just booted wrong has a human looking at it; a camera
  whose session expired at 03:00 has nobody, and nothing but the poll will ever
  ask it again. Ending the chain would convert a transient session expiry into a
  permanent outage — exactly the failure it is meant to bound.

## Consequences

- A permanently broken camera costs ~24 pulls a day instead of 2 880, and every
  one of them is a `warn` line an operator can group by camera. Recovery is
  announced at `info` and clears the rung.
- A camera that breaks and fixes itself may wait up to 90 minutes for the poll
  to notice. Anything that KNOWS something changed (device registered, stream
  params changed) bypasses the ladder, and a viewer opening the stream still
  resurrects the broker through `ensureBroker`, so the 90-minute floor is the
  worst case for a camera nobody is watching and nothing has heard from.
- `ReolinkCamera.dropBaichuanSession` is the invalidation the reconnect ladder
  cannot express. It is NOT a new auth flow: it is the same `close()` +
  `this.api = null` the `disconnectAll` and debug-options paths already perform,
  and the re-login is the existing `ensureApi`. Hub children are excluded — their
  session belongs to the parent Hub and is shared by every child on it, so
  tearing it down on one child's failure would be a fleet-scale action taken on
  a single-device signal.
- The shape is uniform across vendors (`reolink`, `hikvision`, `amcrest`,
  `rtsp`, `wyze`, `terminal` all register `getCatalog: async ({ deviceId })`
  with a `deviceId !== this.id` refusal), so nothing here is Reolink-specific
  except the session invalidation, which is.

## Enforcement

`scripts/check-catalog-per-device-isolation.ts`, wired into the CI guard loop.
It fails the build if the fleet fan-out stops using `Promise.allSettled`, if the
per-device pull loses its `try`/`catch`-and-return, if the omission drops below
`warn` or loses its `tags: { deviceId }`, or if any provider grows a
`stream-catalog` registration that answers for more than its own device.

Behaviour is covered by
`packages/addon-pipeline/src/stream-broker/__tests__/catalog-pull-isolation-and-backoff.spec.ts`
(fleet isolation, the tagged warn, the bounded ladder over 24 h of simulated
poll ticks, event bypass, announced recovery),
`packages/addon-pipeline/src/stream-broker/stream-broker/__tests__/catalog-pull-backoff.spec.ts`
(the ladder clamps rather than ends) and
`packages/addon-provider-reolink/src/__tests__/stream-catalog-session-reauth.spec.ts`
(the session is dropped before the re-login, the retry is bounded to two
attempts with no loop, hub children are excluded).
