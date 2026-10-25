---
id: D371
title: A device's "record me" signal is a LEVEL the recorder holds open — never a poll, never a second copy — and a publisher may name the slot its only stream IS
status: accepted (band-trigger half superseded by D380)
date: 2026-09-06
supersedes:
applies-to:
  - packages/types/src/capabilities/recording-signal.cap.ts
  - packages/addon-pipeline/src/recorder/addon/band-decision.ts
  - packages/addon-pipeline/src/recorder/addon/decision-schedule.ts
  - packages/addon-pipeline/src/stream-broker/initial-assignment.ts
  - packages/addon-provider-dreame/src/devices/dreame-recording-signal.ts
---

## Context

The operator asked for the Dreame robot's camera (device 4374, the camera child
of vacuum 408) to be recorded **while the robot cleans** — one clip per job —
and for that footage to land where every other camera's low stream lands
(`recordingsLow`, [D327](./adr-0327-occupancy-of-a-shared-root-is-the-class-subtree.md)) so scrub can read it.

The recorder had four trigger sources, all EDGES with a timestamp: motion,
audio, an object class, a linked sensor's rising edge
(`RecordingTriggers.sensorDeviceIds`, `SOURCE_CAP_ACTIVE_FIELD`). An events band
demands "within `postBufferSec` of a trigger". A cleaning is forty minutes of
"still happening" that nothing re-emits. Three ways to fit it into an edge were
considered and rejected:

- **Re-trigger on a timer while the state is active.** That is a poll of a
  device fact held in the consumer — the shape [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
  forbids, and a copy that goes stale by design.
- **A post-buffer long enough to cover any job.** Records the dock for an hour
  after every two-minute spot clean, and still cuts a long job.
- **Register the camera itself as a `binary` sensor and name it in its own
  band's `sensorDeviceIds`.** It would have shipped with zero framework
  change (the wire shape already passes the hub's schema). It was rejected
  because a `binary` cap is a ROOM SENSOR to every consumer — the HA export,
  the sensor picker, the notification rules — and "the camera wants to be
  recorded" is a fact about the camera, on the camera. The first time a
  notification rule offered "Robot piano terra Camera" as a contact sensor
  would have been the D62 shape: a control whose meaning nobody could predict.

The second half: the robot's ONE stream (`pull-rfc4571`, a 720p cloud relay)
was auto-assigned to **`mid`** by the broker's pixel ranking
(`computeInitialAssignment`: one stream → `mid`). `mid` is the slot no storage
class is written for on its own (`recordings` is high|mid, `recordingsLow` is
low — `recorder/addon/roots.ts`) and the one profile scrub does not read
(`profile === 'low'`, `data-planes.md`). The heuristic knows how many pixels a
stream has; only the publisher knows what the stream IS. Measured on the hub
before this record: `4374/high unassigned · 4374/mid ← live · 4374/low
unassigned`.

## Decision

**A device that wants to be recorded raises a LEVEL, `recording-signal.active`,
kept fresh by the addon that owns the device; the recorder HOLDS the source
open while it is up, releases it into an ordinary window when it falls, and
reconciles the hold against the slice through RPC under a bound.** Concretely:

1. The cap is `recording-signal` (device-native, camera, `durability:
   'session'` — a restored `active: true` after a restart is exactly the stale
   level the bound exists to end). The provider derives it from state it
   already reads and writes the slice only when the level or its reason moves.
2. ~~The band key is `RecordingTriggers.deviceSignal: true` — a boolean like
   `motion`, naming no device: the camera is the source. `mode` stays derived
   from bands ([D62](./adr-0062.md) consequence 3); there is no
   `mode: 'on-device-signal'`.~~ **SUPERSEDED by
   [D380](./adr-0380-a-device-decided-recording-is-a-mode-with-no-schedule-and-a-provider-seeds-it-once.md)
   (2026-09-07): a band is an HOUR and this feature has none to program, so the
   level is the first-level mode `on-device-decision`
   (`RecordingConfig.deviceDecision`), not a key inside a band. The mechanism —
   the hold, the release, the reconcile, the bound — is unchanged; only its
   authoring shape is. And the reason there was no `mode:` value here was that
   nothing seeded one: the provider now does, once, gated on a durable mark.**
3. `TriggerState.held` is the hold. `holdTrigger` is idempotent on the ORIGINAL
   rise; `releaseTrigger` folds the whole span as ONE window (a rise and a fall
   forty minutes apart are farther than any merge gap and would otherwise be
   two windows with the job unretained between them); the live gate says yes
   while held; the keep gate treats a hold as `[since − pre, +∞)`; the
   schedule arms NO close for a hold — only the release or the reconcile can
   end it.
4. The reconcile beat reads the slice back (`deviceState.getCapSlice`, a
   generic route — never a consumer cache, [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)).
   A read that RAISES is applied at once (footage is what is at stake). A read
   that LOWERS is applied only when `SIGNAL_RELEASE_READS` (2) consecutive reads
   agree ([D49](./adr-0049.md): a read that ends work needs a second read to
   agree). A read that FAILS changes nothing — except that a hold nobody has
   confirmed for `SIGNAL_HOLD_MAX_MS` (4 h, counted from the last confirming
   read, never from the rise alone) is released with a warning
   ([D11](./adr-0011.md): a lost event may never pin a camera for ever).
5. Waking the camera is nothing new: the attach already runs
   `battery.wakeForStream` for a `BatteryOperated` device, which for the robot
   opens the monitor; the recorder leaving is what closes it. The only
   provider-side concession is that the monitor's 10-minute duration cap is
   re-armed while the signal is active (bounded at 3 h): a cap that cut the
   clip every ten minutes with a re-open gap would defeat the feature.

**And a publisher may name the slot its stream IS.** `profileHint` on the
stream descriptor is honoured by the automatic ranking BEFORE the pixel
heuristic (`rankInitialAssignment`); the remaining streams are ranked into the
slots the hints left free, with the slot ORDER decided by the camera's total
stream count (one hinted `low` plus one other is a `high`+`low` pair, as every
two-stream camera already was). An operator's locked assignment is untouched.
The robot's stream hints `low`.

## Consequences

- **None of this is live on the hub until a `@camstack/server` carrying this
  `@camstack/types` is installed.** Addons inline their own `@camstack/types`,
  so the provider writes the slice and the recorder holds on it today — but
  the hub validates every tRPC input with ITS copy of the schema, and
  `RecordingTriggersSchema` is a non-strict `z.object`: `deviceSignal` is
  STRIPPED from `recording.setDeviceConfig` on the current hub, silently, and
  `publishCameraStream` strips `profileHint` the same way. The catalog PULL
  path (`stream-catalog.getCatalog` → `publishCatalog`) does not re-validate
  and does carry the hint. Until the server ships, the low slot on 4374 is
  reached by the operator lock (`assignProfile low` + `unassignProfile mid`),
  which the hint then makes unnecessary for the next camera of this kind.
- The reconcile costs one `getCapSlice` per beat per camera whose ACTIVE band
  lists `deviceSignal`. Nothing for every other camera.
- A provider whose slice sticks at `active: true` (the provider is alive but
  wrong) is NOT caught by the bound: the reads confirm it. That is the
  provider's fact to keep true (D224) and the session durability's job on a
  restart; the recorder does not second-guess a slice that answers.
- `paused` is inactive and `returning` is active. A pause mid-job yields two
  clips; the drive back to the dock is part of the job.
- The UI control is offered from the camera's OWN bindings
  (`deviceManager.getBindings`, [D12](./adr-0012.md)), in four states
  ([D315](./adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry.md)): `pending`/`unknown` render a disabled control, never
  an absent one; a band that already listens can always be switched off.

## Enforcement

- `packages/addon-pipeline/src/recorder/addon/__tests__/band-decision-signal.spec.ts`
  — hold/release/merge, the live gate, the keep gate, the schedule's null close.
- `packages/addon-pipeline/src/recorder/addon/__tests__/recording-controller-signal.spec.ts`
  — rise attaches / fall detaches after the post-buffer, a lost rise recovered
  by the read, a lost fall applied on the SECOND agreeing read, a failed read
  changing nothing, the 4 h bound, and a re-confirmed hold never bounded.
- `packages/addon-pipeline/src/stream-broker/__tests__/initial-assignment.spec.ts`
  — the heuristic byte-for-byte when nobody hints; the hint first; the rest
  ranked into free slots by total count.
- `packages/addon-provider-dreame/src/__tests__/dreame-recording-signal.spec.ts`
  — vacuum state → level; `lastChangedAt` moves only on a level transition.
- `scripts/check-recording-trigger-fed.ts` now accepts `onSignalLevel(…{ kind:
  'signal' }…)` as the feed of `deviceSignal` — a band listening only to it
  must never be a fifth dead knob (D62).
- `scripts/check-authored-fields-reachable.ts` — the key has a control.
