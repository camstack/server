---
id: D173
title: A battery camera is woken by DEMAND only, its brokers are available without being active, and asleep is not gone
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/reolink-camera.ts
  - packages/addon-provider-reolink/src/reolink-hub-session.ts
  - packages/addon-pipeline/src/stream-broker/battery-wake-on-play.ts
  - packages/types/src/device/battery-presence.ts
  - packages/types/src/capabilities/stream-catalog.cap.ts
  - packages/types/src/capabilities/battery.cap.ts
---

## Context

The operator stated the contract in one sentence:

> "Generally, cameras that declare a battery must have NO mechanism that
> activates them autonomously. The only one is the snapshot, and on very wide
> intervals (an hour, probably, right now). But the brokers must always be
> AVAILABLE: not active, available on demand. If we can probe the moment the
> camera comes back up, it will save it in the ledger and pick it up from
> there."

Everything below is that sentence, made checkable.

The physical fact underneath it: on a UDP/Baichuan battery camera, **the login
IS the wake**. Not the command — the connection. So "does this path poll the
camera" is the wrong question; the right one is "does this path reach
`ensureApi()` while the camera is asleep", and a great many paths did without
looking like polls.

A census of every activation vector on camera 106 (Argus 3E) found the sleep
gates largely present on the obvious timers — the 5 s sleep poll is passive,
the aux-align poll is not armed for battery, the 60-minute battery refresh
gates on the slice before connecting, the catalog build refuses to wake, the
ping watchdog is skipped — and **two open vectors in lifecycle code, which is
exactly where nobody looks for a poll**:

- `onProbe()` called `ensureApi()` unconditionally. It is not a one-shot: the
  kernel retries it on the boot-recovery backoff (15 s, 60 s, 5 m, 15 m, 30 m,
  60 m, 90 m) until the `feature-probe` slice is seeded, so a camera asleep at
  boot paid up to seven logins in the first three hours — measured at ~25 wakes
  a day across restarts, none of them asked for by anybody.
- `registerBatteryIfSupported()` seeded the battery cache with
  `refreshBatteryFromApi()` **from the constructor**. Its comment said "same
  command as the legacy probe, so no extra wake event" — true of the command
  and false of the connection. Every addon restart woke every sleeping battery
  camera to read a number the restored slice already held.

A third vector sat outside the provider: the pipeline runner's occupancy
recheck (300 s, enabled by default) re-dials a decode session while a camera is
in `watching`. On a battery camera that dial is a wake, issued five minutes
after the last person stopped watching.

Meanwhile the other half of the contract was failing in the opposite
direction. `cachedStreamDescriptors` lived **only in RAM**. After a restart
with the camera asleep, `buildStreamCatalogUncached` correctly refused to wake
it and returned `[]`; the broker then had no cam-stream to build a broker from;
and `webrtcSession.handleOffer` answered the operator's play button with a flat
`No broker for stream …` — for as long as the camera slept, which on a battery
camera is most of the day. The camera was fine. The stream was unreachable
because the process had forgotten what the camera offers.

And nothing on the live path ever asked a camera to wake. `battery.wakeForStream`
existed and had exactly one caller — the Alexa RTC handler — which was itself
dead code behind `const hasBatteryCap = false`, forty lines describing the right
design guarded by a constant that made sure it never ran. So no consumer at all,
including the viewer's own play button, could wake a sleeping camera.

Finally: camera 106 sat at `online: true` after 30 hours unreachable, because
`online` is written once at probe and nothing passive ever demotes it. There
was no vocabulary for the difference between a camera that is asleep and a
camera that is gone — and no way to acquire one, because the poll that would
answer the question is the poll that flattens the battery.

## Decision

**1. No self-initiated path may reach `ensureApi()` while the camera is known
to be sleeping.** Not a timer rule — a reachability rule. Lifecycle entry
points (`onProbe`, constructor seeds) are held to it exactly like polls. A path
that legitimately runs on a live socket declares WHY: `refreshBatteryFromApi`
takes a `reason`, and `'register'`/`'periodic'` are refused while asleep while
`'wake'`/`'demand'` are not. An un-argumented call is banned by a test, because
an unclassified call is how the constructor seed stayed open.

**2. The stream catalog is DURABLE.** `stream-catalog` declares a
`runtimeState` slice with `durability: 'restored'`, so the descriptors live in
`device-runtime-state` — the kernel's canonical declared collection — and a
cold RAM cache rehydrates from it before anything considers touching the
camera. Only a SUCCESSFUL build writes it; a refusal or a failure writes
nothing and therefore cannot demote a good stored copy. The result is the
operator's phrasing exactly: brokers are **definable** without the camera being
**dialled**. On a natural wake the provider re-reads the catalog and updates the
ledger — "probe the moment it comes back up, save it in the ledger, and it picks
it up from there" — bounded by a 24-hour staleness so a wake is not spent on a
catalog we already trust.

**3. Wake-on-play.** When the live path resolves no broker and the device
carries `DeviceFeature.BatteryOperated`, the broker calls
`battery.wakeForStream`, waits a bounded window for the provider's
`StreamParamsChanged` nudge, reconciles the catalog regardless of whether the
nudge came (a ledger-restored catalog announces nothing), and retries the
resolution **once**. One demand, one wake: a second wake would be us deciding
the camera should be up. The error, when there is one, names the state —
`sleeping`, `waking`, `unreachable` — and never `No broker for stream`.

**4. Asleep is not gone, and only passive evidence may say which.**
`BatteryStatus.lastContactAt` records the last time the camera PROVED it was
reachable without us reaching for it: an inbound firmware push, an observed
wake, a round-trip somebody else's demand already paid for. It is never written
by a poll issued to answer the question, because that poll is the wake it is
trying to detect. `deriveBatteryPresence` is the ONE derivation of `awake` /
`sleeping` / `unreachable` from it, and every surface calls it rather than
computing its own, so the badge, the courtesy frame and the stream error cannot
disagree. The failure direction is toward `sleeping`: a camera that has reported
no contact at all — freshly adopted, slice lost — is never painted as a fault.
`unreachable` is a fault and is meant to be believed.

**5. The snapshot is the one permitted autonomous touch, and it stays wide.**
Confirmed as built rather than assumed: `BATTERY_DEFAULT_MAX_AGE_S = 3600`
(1 hour, against 10 s for mains), per-device overridable via `snapshotMaxAgeS`,
with no scheduler behind it at all — the server-side keep-warm was removed on
2026-08-11 and snapshots are on-demand only.

## Consequences

- A battery camera asleep at boot now seeds no `feature-probe` slice, so the
  kernel's probe retry chain keeps rescheduling a no-op. That is deliberate and
  cheap; the probe is re-run for free by `onWakeTransition` the next time the
  camera comes up on its own, which is the only moment it costs nothing.
- The battery badge and the settings forms on a long-sleeping camera are served
  entirely from restored slices. That was already true in practice; it is now
  true by design, and the alternative was waking the camera to refresh a number
  nobody is looking at.
- `lastContactAt` is quantised to 5 minutes by its writers. The compare that
  decides a SQLite commit sees it, so it is exempted by name in
  `scripts/check-runtime-state-durability.ts` with the reason: it is the
  observation itself, not a stamp on one, and excluding it would mean the fact
  that decides a fault badge is the one fact never committed.
- Occupancy recheck no longer runs against a sleeping battery camera. A room
  that is still occupied when the camera sleeps is re-detected by the next
  motion event rather than by a re-dial.
- The Alexa pre-wake block is deleted rather than repaired. The wake now lives
  one layer down, in the broker, shared by every consumer.

Also fixed under the same contract, because it silently disabled every gate
above for the hub's own cameras: `ReolinkHub.refreshDiscoveryFromCamera` used to
`clear()` the channel→device routing map before rebuilding it from the registry.
An EMPTY registry read — which is what the registry answers while the addon is
still restoring its devices — was then indistinguishable from "the operator
un-adopted everything", and `routeSimpleEvent` drops every push for an unmapped
channel. The hub's battery cameras stopped reporting `awake`/`sleeping`/`battery`
for the rest of the process's life, their `battery.sleeping` slice froze on
whatever it last held, and every sleep gate that reads it was deciding on a value
nothing could update. Observed live on 2026-08-15: both adopted children rendered
`alreadyAdopted: false` in the discovery panel, one refresh away from being
adopted a second time. The map is now merge-only; a mapping is removed only by an
explicit unregistration, which is a fact rather than the absence of one
([D49](./adr-0049.md)).

## Enforcement

- `packages/addon-provider-reolink/src/__tests__/battery-autonomous-wake-census.spec.ts`
  — the census as a test. Asserts the sleep gate precedes `ensureApi()` in every
  self-initiated path, bans the un-argumented `refreshBatteryFromApi()` shape,
  pins the catalog restore ahead of the build, pins the merge-only hub map, and
  pins the battery refresh cadence at an hour or wider. Verified by
  neutralisation: reverting the `onProbe` gate and the ledger restore fails
  exactly the two assertions that cover them.
- `packages/addon-pipeline/src/stream-broker/__tests__/battery-wake-on-play.spec.ts`
  — one wake per demand, the unreachable refusal issues no dial at all, and the
  error text is never `No broker for stream`.
- `packages/types/src/device/__tests__/battery-presence.spec.ts` — the boundary,
  the never-contacted case, and that `sleeping` is not a fault.
- `scripts/check-runtime-state-durability.ts` — `stream-catalog` and `battery`
  must declare their durability and account for their clock fields.
