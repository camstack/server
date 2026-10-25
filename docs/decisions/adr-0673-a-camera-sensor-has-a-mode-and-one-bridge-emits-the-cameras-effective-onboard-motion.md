---
id: D673
title: A camera sensor has a mode, and one bridge emits the camera's effective onboard motion
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - packages/types/src/pipeline/camera-sensors.ts
  - packages/types/src/pipeline/provider-motion.ts
  - packages/addon-pipeline-orchestrator/src/camera-sensors/effective-motion.ts
  - packages/addon-pipeline-orchestrator/src/camera-sensors/source.ts
  - packages/addon-pipeline-orchestrator/src/camera-sensors/resolver.ts
  - packages/addon-pipeline-orchestrator/src/orchestrator-subscriptions.ts
  - scripts/onboard-motion-emitters-guard.ts
---

> Amended in part by [D696](adr-0696-a-cameras-motion-slice-means-motion-and-only-the-orchestrator-writes-it.md):
> the camera's `motion` runtime SLICE is the effective motion, and only the
> orchestrator writes it. D696 also owns the release order of the whole motion
> path. **Amended 2026-10-02:** the orchestrator, `addon-pipeline` and the admin
> UI ship inside the `@camstack/server` closure and move at the server step, so
> the order below is the corrected one (server → providers).

## Context

D672 (CS-1) made a sensor attached to a camera part of that camera's `onboard`
motion, in one mode for the whole camera: *in addition*. The operator had named
three modes on 2026-09-28 and, on 2026-09-30, approved the rule that combines
them PER SENSOR: motion = (an In-addition sensor active) OR (a Replace sensor
active) OR (camera motion AND a Confirm sensor active); with at least one
Replace sensor, the camera's own motion alone no longer counts.

Confirm and Replace SUPPRESS the camera's own motion, and CS-1 could not
suppress anything: every camera provider emitted `MotionOnMotionChanged`
directly, and seven consumers read it raw — session dispatch, the recorder's
event band, the D475 episode row, lazy audio, the runner, HAP / Alexa / the HA
export, camera-grid. CS-1's "in addition" hold lived at session dispatch only,
so the exports and the rows saw raw edges the session did not (D672
Consequences). Gating each consumer would have been seven authorities (D62).

**What the implementation and its review rounds found, which this record
exists to keep:**

- **The approved formula leaves a Confirm sensor inert without a Replace
  sensor** (the camera's own motion counts alone anyway). The operator said
  "procedi" to the two open questions and answered neither, so the controller
  ruled (Q1): a ready Confirm sensor gates the camera's own motion even with no
  Replace sensor. The operator can overrule it; it is one function and its
  truth table.
- **The suppression needed a window, and a window needs a floor.** A cooldown of
  0, or one at or under the sustain interval, made the camera's own motion
  never count and expired the effective level between two sustain ticks, so the
  floor is two sustain intervals (task 12 review H3). The same review found
  the owed `false` lost when the level had expired before the clear (H1), and
  a pass-through `true` whose `false` was swallowed by the first resolution
  (H2).
- **A respawn is a state the rule never saw.** A Confirm sensor already high at
  a respawn was read as idle, so every camera motion was dropped until the PIR
  fell (task 10 review M3); a clear for a rise the new bridge never saw was
  swallowed, and HA export or Alexa stayed ON (task 13 review H2).
- **Providers are not all released with the orchestrator.** A split provider in
  front of an orchestrator that does not subscribe `ProviderMotion` loses every
  one of its cameras' motion, with no log line — and `camera-grid` ships inside
  `@camstack/server`, which releases BEFORE the orchestrator (task 14 ruling;
  corrected 2026-10-02: the orchestrator is in the same closure, see below).
- **The raw/effective split did not reach Home Assistant.** HA export also
  publishes a camera's motion from its `motion` slice, which Hikvision and
  Amcrest wrote raw (task 14 review M3). The operator ruled the orchestrator THE
  authority for a camera's motion; D696 is that change.
- **The acceptance suite raced the boot reconcile**, 5 runs in 10 red under CPU
  load: the reconcile arms the camera itself, and a test that armed it by hand
  restarted the session it was proving (task 14 review M2). A test that passes
  because a race deleted its subject is not a proof.

## Decision

**A camera's effective onboard motion has ONE emitter — the orchestrator's
camera-sensors bridge — and each attached sensor carries a mode.**

1. A camera provider emits its raw onboard push on `ProviderMotion`
   (`providerMotionEvent` in `packages/types/src/pipeline/provider-motion.ts`),
   never `MotionOnMotionChanged`. The payload carries no `triggeredBy`: only the
   bridge names a trigger. Hikvision, Reolink, Amcrest and Wyze emit it. Only
   the bridge, the device-activity source and the runner's analyzer emit
   `MotionOnMotionChanged` — and, deferred, camera-grid (rule 8).
2. A camera with no attached sensor, not resolved yet, or whose sensors are not
   forwarded (D672 rule 6) is a pass-through: its raw push goes out verbatim
   with `triggeredBy: camera`. Never less camera motion than before.
3. Otherwise the approved rule decides (`camera-sensors/effective-motion.ts`,
   one pure function). The ruling on Q1:
   `motion = A ∨ R ∨ (camera ∧ C) ∨ (camera ∧ no ready Replace ∧ no ready Confirm)`,
   with A / R / C = a sensor of that mode is active. Only READY Replace /
   Confirm sensors reshape the camera's own motion: an offline one hands the
   camera back (the D663 rule for a replaced field whose source is gone); an
   unreadable one keeps its prior readiness per sensor (D49). A Confirm sensor
   counts for one window after it fell (the coincidence window).
   - **An active In-addition or Replace sensor counts whatever its readiness**;
     readiness decides only whether the camera is reshaped, and a Confirm must
     be ready to confirm.
   - **A stuck sensor stops being active but stays READY**, so a stuck Replace
     still replaces and a stuck Confirm still gates.
4. A sensor counts as active only within `maxSessionHoldMs` of its own last real
   rise (amends D672 rule 9 from per-camera to per-sensor).
5. Effective edges: a rise fixes the first trigger; trues keep it alive; a
   false goes out only when an input's own false leaves no motion — never on a
   silent cooldown expiry. The level expires one window after the last `true`;
   the window is the camera's `motionCooldownMs` floored at two sustain
   intervals. A dropped camera edge is logged, sampled.
6. Stored per sensor (`{ addonId, stableId, mode }`, absent = in addition, at
   most 8 sensors); the CS-1 envelope `mode` is dropped on read. The status
   reports each mode, `cameraMotion` (`always | when-confirmed | never`; absent
   = an older orchestrator) and `notEnforced` when an unsplit provider still
   emits directly.
7. **Unsplit emitters fail open.** An `onboard` event with no `triggeredBy` (the
   bridge always names one) is an unsplit provider's direct emit: the bridge
   notes it as the camera's level and reports `notEnforced`, and the session
   receives it as before. The Task-13 session hold (`sensorHolds`) keeps an
   unsplit camera's clear from closing a session while an attached sensor still
   sees motion. **That hold stays until the emitter guard's deferred map is
   empty AND the minimum providers carry the split.**
8. **`camera-grid` is DEFERRED, and unsplit.** It ships inside
   `@camstack/server`, which cannot assume an orchestrator at the floor (see
   "Release order and rollback"), so it keeps
   emitting `MotionOnMotionChanged` until the minimum orchestrator carries the
   `ProviderMotion` subscription; the guard names it in
   `MOTION_EMITTERS_DEFERRED`, by exact path, with the reason. The plan's
   "camera-grid split" line is superseded (the plan's Task 19 carries a note).

### Release order and rollback

**server (carrying `addon-pipeline`, the orchestrator and the admin UI) →
providers.** `@camstack/server` re-aligns the addons it carries at boot (D518):
on the hub `addon-admin-ui`, `addon-auth`, `addon-decoder-nodeav`,
`addon-notifiers`, `addon-pipeline`, `addon-pipeline-orchestrator`,
`addon-post-analysis`; on an agent `addon-pipeline`, `addon-decoder-nodeav`,
`addon-agent-ui`. The order this record first named (server → orchestrator →
providers → addon-pipeline → admin-ui) could not be followed: the 2026-10-02
release installed `addon-pipeline` with the server on all three nodes. D696
records who writes the `motion` slice in each window, and
`docs/architecture/update-and-release.md` has the full table.

What this order means for D673's own rule still holds: the providers come
AFTER an orchestrator that subscribes `ProviderMotion`. The orchestrator
normally moves at the server step, but the closure does not guarantee it (the
re-alignment is conditional, and its failure only WARNs): the provider step
waits for a live read — `addons.listPackages` shows
`@camstack/addon-pipeline-orchestrator` at or above the floor
(`update-and-release.md`, "The order").

Floors below are release artefacts, not task numbers: **record, at release
time, the first orchestrator version that subscribes `ProviderMotion` and
carries D696** (1.2.272 in the 2026-10-02 release). Call it the *orchestrator
floor*.

- **Never release the orchestrator that rewrote the bridge (task 12) without the
  one that subscribes `ProviderMotion` (task 13).** Between the two nothing
  feeds the bridge once a provider is split.
- **A server rollback rolls none of the closure addons back** (an older closure
  under a newer installed copy is kept, `planAddonRealignment`). Each is
  installed back explicitly, `addon-pipeline` on every node that runs it.
- **Once any provider is at its split version, never roll the orchestrator back
  below the orchestrator floor.** No older orchestrator listens, so that
  provider's onboard motion is lost to every consumer, with no log line. Roll
  the providers back first.
- **A provider rollback is safe for the motion EVENT**: the provider is unsplit
  again, the bridge fails open (rule 7) and the session hold covers its clears.
  For the `motion` slice it is one writer at every point only with D696's
  provider gate (amended 2026-10-02) AND a server that emits `WorkerOnline` for
  forked runners (fix round 1). On a server that does not (1.2.430), restart
  the orchestrator immediately after the provider rollback; against an
  orchestrator without the gate (1.2.272) it is two writers while the
  orchestrator writes.
- **Never roll the admin-ui back alone.** In a rollback it goes first, and the
  orchestrator rollback must follow in the same window. Do not edit camera
  sensors in either of these windows: where an old admin-ui faces a new
  orchestrator (it rewrites a Confirm or Replace sensor as In-addition on any
  detach or apply), and, in either direction, where the new server faces a CS-1
  orchestrator (it refuses every `setCameraSensors`: the CS-1 schema requires the
  envelope `mode: 'in-addition'`, which a per-sensor value no longer carries).
  CS-2 rows read `unreadable` on a rolled-back CS-1 orchestrator.
- **`camera-grid` stays deferred (rule 8).** It moves with the server
  (`@camstack/system`); the orchestrator moves at the same boot only when the
  re-alignment re-aligns it (a closure copy strictly newer, an install older
  than the closure), so the server cannot assume an orchestrator at the floor.
  A grid device's motion is never dropped: camera-grid stays unsplit and emits
  directly.

## Consequences

- Session dispatch, the D475 rows, the recorder, lazy audio, the runner
  (`onboardMotionDrivesAnalyzer` included) and every export see the SAME
  effective stream, with no code of their own changed; CS-1's block-9b hold for
  split cameras is deleted. Pass-through rows now record `triggeredBy: camera`;
  absent still means "not recorded" (D393).
- **The orchestrator is on every onboard motion path.** The consequences, each
  bounded by the CrashSupervisor (D6) and the same shape as `ProviderDetection`:
  - while it respawns, the edges sent in that window are lost for every
    consumer; a lost clear can leave HA export's event path and Alexa ON, and
    HAP resets itself after 5 s of no fresh edge;
  - a terminally `failed` orchestrator silences ALL onboard motion, including
    motion-triggered recording, and no camera's `motion` slice is written (D696:
    it is the only writer): a slice that was ON stays ON for HA, HAP hydration,
    `isDetected` and the admin UI until the orchestrator runs again;
  - a sensor-only episode that straddles a respawn loses its `false`: the new
    instance sights the sensor already high and owes nothing. The D475 row
    closes by `MOTION_CLOSE_AFTER_MS`, HAP self-resets after 5 s and the slice is
    corrected by D696's re-publish, but **Alexa and HA's event path stay ON
    until the camera's next effective episode**;
  - after a respawn a clear the new bridge never saw rise passes through unless
    an attached sensor still holds the motion (then the bridge's own `false`
    closes the episode); a redundant `false` is idempotent downstream;
  - after a respawn a PIR first seen already high does not count (an
    In-addition or Replace sensor needs a real rise; a Replace one hands the
    camera back until it has one), so the camera's first clear passes —
    pre-D673 behaviour. A Confirm sensor first seen high is the exception: it
    confirms from the moment it was watched, bounded by `maxSessionHoldMs`.
  - D696 changes the SLICE side: a lost clear no longer leaves a camera's slice
    ON across a respawn, because the boot re-publish writes OFF after the grace
    window. HA export reads the slice too, so its entity is corrected; the EVENT
    side (HA's `onMotion`, Alexa) is not.
- **Known limit: the bridge learns `notEnforced` from in-memory traffic.**
  After each orchestrator start an unsplit camera reads as enforced until its
  first direct emit, and `cameraMotion` may read `never` for a camera whose
  motion in fact passes through. `notEnforced` is also reported only while the
  camera's own motion is not `always`. D696 does not change this; the camera's
  slice IS written from that direct emit (D696, class `onboard:unsplit`).
- **Known limit: the emitter guard is lexical.** It reads `createEvent(` and
  `.emit(` windows. It does not see `.emit<…>(` or `createEvent<…>(` (a
  generic call form), an aliased category, or an event object built far from its
  `.emit(` and passed by name. The provider specs and the bridge's pass-through
  spec remain the proof for the cameras. D696's slice rule has its own blind spot
  (a cap name that arrives through a variable); the provider-slice rule is
  stated there.
- Hikvision and Amcrest no longer write their own `motion` slice (D696 closes
  D475's noted oddity).
- **Open, stated neutrally for the operator:** Q1 (above) and Q2 — "controls
  with the camera" on a linked device is a read-only column; a per-device
  opt-in is a later slice if asked.
- Release needs the order above. The rule is also in
  `docs/architecture/update-and-release.md`.

## Enforcement

- `scripts/check-onboard-motion-emitters.ts` (CI) with
  `scripts/__tests__/check-onboard-motion-emitters.spec.ts` — rule 1; the
  deferral of rule 8 by exact path; a stale exemption is refused.
- `camera-sensors-effective-motion.spec.ts` — the truth table (rules 3, 4).
- `camera-sensors-modes.spec.ts` — the bridge alone (rules 2, 5, 7);
  `camera-sensors-effective-wiring.spec.ts` and the acceptance cases #11–#15 in
  `camera-sensors-acceptance.spec.ts` — through the whole orchestrator.
- `camera-sensors-resolver.spec.ts` — modes, readiness, `cameraMotion` (rule 3).
- `packages/types/src/pipeline/__tests__/camera-sensors.spec.ts` — the CS-1 row
  and status read as in addition; `cameraMotion` absent from an older node
  (rule 6); `provider-motion.spec.ts` — the payload has no `triggeredBy`.
- Each provider's `motion-emits-provider-motion.spec.ts` (Hikvision, Reolink,
  Amcrest, Wyze) — rule 1, on the real prototype methods.
- Review only: the release order. Nothing refuses a mis-ordered release; the
  rollback rule lives in the guard's docblock, this record and
  `update-and-release.md`.
- Each disarm is recorded in its task report.
