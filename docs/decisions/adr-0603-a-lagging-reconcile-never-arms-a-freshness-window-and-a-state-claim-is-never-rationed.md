---
id: D603
title: A lagging reconcile never arms a freshness window, and a state claim is never rationed
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/sleep-state-decision.ts
  - camstack/src/data/use-snapshot-links.ts
---

## Context

The operator opened a battery camera (device **3628**, an Argus 3E adopted
under a Reolink Home Hub). It woke and streamed live, with audio. The Viewer
kept showing it as asleep, over a snapshot from before the wake.

Two independent defects, both of them [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
in a shape that record did not name: not a second COPY of a fact, but a second
CLOCK over it.

### 1. A lagging reconcile armed the anti-flap window (provider)

`battery.sleeping` has one writer, `ReolinkCamera.commitSleepState`, with two
windows measured against one timestamp:

- `WAKE_HYSTERESIS_MS` (30 s) — absorbs the library's socket-I/O sleep
  INFERENCE, which flaps on battery cameras with idle-disconnect;
- `HUB_SUMMARY_SLEEP_GRACE_MS` (180 s) — stops the parent NVR's channel
  summary, which lags real pushes by more than 75 s, from clobbering a fresher
  verdict.

Every source stamped that timestamp, including the parent's PERIODIC summary
sweep (`applyHubSleepState`, ~60 s). So a sweep reporting minutes-old
`sleeping: true` armed a 30 s window against the one source that is both
first-hand and current — the camera's own wake push. Measured on the live hub,
2026-09-22, `addonId: provider-reolink`:

```
06:06:15.105  dev=3629  battery sleep state committed  {sleeping: true, source: 'hub-summary'}
06:06:16.828  dev=3629  ignoring sleep inference flap  {next: false, sinceLastChangeMs: 1723}
06:08:41.609  dev=3629  battery sleep state committed  {sleeping: false, source: 'simple-event'}
              → 2 min 26 s reported asleep over an awake camera

06:37:41.035  dev=3629  battery sleep state committed  {sleeping: true, source: 'hub-summary'}
06:37:42.507  dev=3629  ignoring sleep inference flap  {next: false, sinceLastChangeMs: 1479}
06:38:50.825  dev=3629  battery sleep state committed  {sleeping: false, source: 'simple-event'}
              → 1 min 10 s
```

Seven such refusals in twelve hours across the fleet's battery cameras, and
**every one of them in the `→ awake` direction**. The 180 s grace already
encoded the right principle in the other direction; the hysteresis encoded its
inverse, because `'hub-summary'` named two things at once — the periodic sweep,
and a summary read taken DURING a wake this process drove (`wakeForStream`'s
confirm, `watchHubChildAwake`). Those have opposite freshness and were treated
identically.

Raising the grace was rejected: it makes the lagging authority win harder.
Dropping the hysteresis was rejected: the inference flap it absorbs is real and
documented.

### 2. The Viewer rationed the state claim along with the capture (client)

The hub was RIGHT for the incident itself:

```
16:08:04.597  provider-reolink  battery sleep state committed  {sleeping: false, source: 'simple-event'}
16:08:06.509  snapshot          snapshot: wake capture landed
16:08:15.025  stream-broker     snapshot tile mount  to="en|uri|sr=sleeping|ok|ready|file|nc"
16:08:59.033  stream-broker     snapshot tile mount  to="en|uri|sr=sleeping|ok|ready|file|nc"
16:09:03.069  stream-broker     snapshot tile mount  to="en|uri|sr=sleeping|ok|ready|file|nc"
```

`resolveSnapshotState` reads `deviceState.getCapSlice('battery')`, the hub
mirror, on every call, with no cache of its own — it is read-through and
D224-clean. The stale `sleeping` was held in the APP: `stateReason` rides on a
`SnapshotLinkRow`, and `use-snapshot-links.ts` rations those rows two ways.

`planSnapshotLinkPoll` names a quarter of the demand set per 5 s poll, so a
"minted" target is re-asked every ~20 s; and a target the viewport gate has
dropped is not asked at all, while `keepNewestSnapshotLinks` carries its row
forward for the whole signed-link TTL (`SNAPSHOT_LINK_TTL_MS`, **120 s**). A
tile coming back on screen therefore MOUNTS on a claim up to two minutes old —
which is what those three `tile mount` lines are, 58 s after the hub changed
its mind.

That rationing exists to pace CAPTURES ([D108]), and it buys nothing here: the
hub short-circuits `getSnapshotLinks` before any capture for a device in a
named state (`if (state.reason !== undefined) return`, and again for an
idle-awake battery camera). Re-asking a target that claims a state costs one
mirror read and zero camera hits.

## Decision

**A verdict that is known to lag never stamps a freshness clock, and a claim
about NOW is never rationed by a budget that exists for something else.**

1. `sleep-state-decision.ts` is the one rule that decides whether
   `battery.sleeping` moves, pure and driven by tests. `SleepCommitSource`
   distinguishes `hub-reconcile` (the periodic sweep) from `hub-summary` (a
   summary read taken during a wake we drove). Both bypass the hysteresis —
   firmware state is not inference — but only `hub-reconcile` leaves
   `sleepStateChangedAt` alone. That field now has one meaning: **when a
   FIRST-HAND observation last moved this slice**, which is also exactly what
   the 180 s grace always claimed to read.
2. In the Viewer, a link row may be left for its slice's turn only while it is
   unexpired, was observed within `SNAPSHOT_LINK_STATE_MAX_AGE_MS` (one
   rotation plus one poll, 25 s), **and makes no state claim**
   (`skippableSnapshotLinkKeys`). A row carries `observedAt` — when the hub
   ANSWERED — distinct from `capturedAt`, which dates a photograph and stays
   true as it ages.
3. A tile that has only a carried-forward row keeps painting its last known
   state for at most one poll. Degrading it to "no overlay" was rejected:
   `stateReason: null` is not "unknown", it is the positive claim that the
   camera is fine, and painting that over a battery camera that is actually
   asleep is the worse lie in both directions ([D315] read literally, and
   [D62]'s "disabled must never look like broken"). The honest answer while
   the truth is unknown is the last thing the hub said, for a BOUNDED time,
   and the bound is what changed from 120 s to 5 s.

## Consequences

- The live session is deliberately NOT wired into the snapshot state. A camera
  delivering frames is awake, and that is the strongest evidence there is — but
  it already reaches the owner: `wakeForStream` commits `confirmed-wake`, and
  `watchHubChildAwake` watches the parent's summary after the dial. Adding a
  second path from `stream-broker` into `battery.sleeping` would be a second
  authority over one fact, which is what D224 forbids and what the 180 s grace
  exists to referee. If the broker ever needs to assert it, it does so through
  `ctx.api` into the provider's single writer, never into the snapshot addon.
- `captureOnWake` is likewise left alone. It fires FROM the mirror's own change
  event, so the mirror it re-reads is fresh by construction; the coupling only
  bites on its one delayed retry, and fix 1 removes the case that produced a
  stale mirror in the first place.
- `packages/system` is untouched. `resolveSnapshotState` was innocent, and this
  ships on two SHORT trains — `camstack deploy packages/addon-provider-reolink`
  and a Viewer OTA — instead of the `@camstack/server` publish-and-install one.
- A camera whose tile was off screen is named on its first poll back, so the
  demand set briefly costs one extra row per returning tile. It costs no
  capture: the hub only captures for a target with no `stateReason`, and such a
  target is re-asked because its answer is genuinely older than a rotation.
- The provider's two refusal log lines now both name `source` and the window.
  The old `ignoring sleep inference flap` line said `next` and
  `sinceLastChangeMs` but not WHO was refused, which is why this took two days
  and a log dig to see.

## Enforcement

- `packages/addon-provider-reolink/src/__tests__/a-lagging-reconcile-never-eats-a-wake.spec.ts`
  drives `decideSleepCommit` over the 06:06 and 06:37 sequences from the hub's
  own logs, and pins that `commitSleepState` stamps only when the decision says
  to and that `applyHubSleepState` passes `hub-reconcile`.
- `camstack/src/data/__tests__/a-state-claim-is-never-rationed.spec.ts` drives
  the real planner, merge and skip rule, pins that `observedAt` carries a real
  clock, and pins the provider wiring (that suite cannot render the provider).
- Every assertion above was proved by removing the fix and confirming RED, then
  restoring byte-identical (`cmp`) and confirming GREEN.
