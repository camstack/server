---
id: D672
title: An attached sensor is part of the camera's onboard motion, and the first trigger is recorded
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/camera-sensors/source.ts
  - packages/addon-pipeline-orchestrator/src/camera-sensors/resolver.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/types/src/pipeline/camera-sensors.ts
---

> **Superseded in part by [D696](adr-0696-a-cameras-motion-slice-means-motion-and-only-the-orchestrator-writes-it.md)** — its rejection of a second writer of the camera's `motion` slice, on the ground that the runner's phase machine owns it. A camera's `motion` slice is the effective motion, and only the orchestrator writes it; the runner's phase machine and the camera providers no longer write it. The rest of this record stands.

> **Amended 2026-10-06 (operator ruling) — rule 11.** The session's first
> trigger now DOES ride the runner's attach config, as the optional
> `sessionTrigger` (`{ source, triggeredBy, sensorName? }`,
> `SessionTriggerSchema` in `pipeline-runner.cap.ts`), set only on a session
> attach by `dispatchDetectionSession`. The runner decides nothing on it: it is
> named on the `DetectionPhaseTransition` the attach emits (`cause: 'attach'`,
> `source`, `triggeredBy`, `sensorName`), because that event used to claim a
> hardcoded `source: 'analyzer'` on cameras that do not list the analyzer, and
> the operator read it as "the analyzer is driving my on-motion camera". The
> detach emits `cause: 'detach'` with no source. An attach without the field
> (occupancy burst, standing always-on camera, an older orchestrator) names no
> source — never a guessed one.

## Context

On 2026-09-28 the operator redefined a camera's `onboard` motion source as
**"Camera sensors"**: the camera's own motion **plus** any sensor the operator
attached to it (the porch camera 103 and the Home Assistant PIR 3299 that
watches the same porch). Three modes were named — *in addition* (camera OR
sensor), *confirm* and *replace* — and this slice, CS-1, ships only *in
addition*. CS-2 (D673) takes the other two and the raw/effective split.

**What was rejected first, and why.** The composed-devices design (spec §1)
proposed a composed `motion.detected` field: the composition layer would write
the camera's `motion` slice from its sensors. That makes a second writer of the
slice the runner's phase machine already owns
([D475](adr-0475-a-motion-episode-belongs-to-its-source-and-the-pipeline-never-overwrites-a-sensor.md)
§3), and it reaches **none** of the event consumers: session dispatch, the
recorder's event band, the D475 episode row, lazy audio and the HAP / Alexa /
HA exports all listen to `MotionOnMotionChanged`, not to the slice. D670's
`fromState` events do not fit either: they emit a cap's declared event from a
numeric state advance, and `MotionOnMotionChanged` is not a cap-declared state
advance — it needs a `source` and, now, a `triggeredBy`.

**The side finding, which was a live defect.** Session dispatch ignored the
camera's `motionSources` entirely: any source opened a session on an on-motion
camera, including the runner analyzer side-channel's `source: 'analyzer'`
transitions on onboard-only cameras. And the bootstrap dropped the fourth
argument of `handleSessionMotion`, so the trigger never reached the dispatcher —
D392's `detectionFpsForTrigger` had been dead in production since it shipped.

The review rounds changed the design three times, each on a failure found by
reading the code against the live fleet:

- A sensor's clear, emitted as the camera's `onboard false`, closed a session
  the camera itself still saw — "in addition" behaved as "sensor only" at the
  close (block-3 review M1).
- The fix for that mirrored the camera's own level, and on a heartbeat-only
  camera (Reolink, Wyze: `true` and never `false`) the first heartbeat latched
  it high for the life of the process (N1).
- A sensor stuck high — unavailable while on, or a lost `off` — kept the
  session open with no bound (N2).
- The sustain tick ran at half the cooldown, which at the default 30 s equals
  D475's 15 s row-close window: whether a held sensor kept one episode row or
  opened a new one per tick was a cross-process race (block-4 review M1).

## Decision

**A sensor the operator attached to a camera IS that camera's `onboard` motion,
and the trigger that opened a session or an episode is fixed at open and
recorded.** As rules:

1. **Stored value `onboard`, label only.** The stored value stays `onboard`; only
   the motion-source label reads "Camera sensors". `detectionSources: 'onboard'`
   ("Camera onboard AI") and the notification source filter keep theirs.
2. **Config by stable ref, beside `motionSources`.** `cameraSensors` lives in the
   orchestrator's per-camera device store, `{ mode, sensors: [{ addonId,
   stableId }] }` — never numeric ids, which exist only in the controller's
   memory. Only `mode: 'in-addition'` parses. It is not part of the runner's
   attach payload.
3. **No new tRPC method.** The writer is the existing
   `pipelineOrchestrator.applyDeviceSettingsPatch`, which validates `cameraSensors`
   FIRST and refuses an invalid value by name (`cameraSensors refused: …`),
   writing nothing — not even the valid keys beside it. `null` removes it. It
   stores the parsed value, so a numeric id inside a ref never persists.
4. **Resolution is D49-safe for a READ that fails, and re-queued on every
   lifecycle event of a sensor the camera still names.** Refs resolve off the
   event path (boot, settings update, sensor lifecycle events, a status ask). A
   failed read keeps the prior mapping and reports `unreadable`. What
   un-routes, exactly:
   - a ref that is **gone**: two agreeing by-id reads that do not find it,
     **and** an answered by-addon listing that also does not find it (a listing
     that FAILS keeps the prior id);
   - a found device whose **answered** bindings read carries no source cap —
     `unsupported`, on ONE read. That is what a provider shutting down looks
     like (an HA addon restart decommissions every device and retracts its
     `motion` binding; a hub boot can read bindings before HA registered them);
   - a device that is a camera (rule 5).

   Offline or disabled does not un-route. What re-queues a camera: its own
   settings changing; a `device.registered` of an addon it has a NOT-ready ref
   of; and any `device.unregistered` / `online` / `offline` / `enabled` /
   `disabled` / `bindings-changed` (source cap) of a sensor it either ROUTES or
   whose id its status still NAMES — `ready`, `offline` and `unsupported`
   attachments all carry the device id. So the `unsupported` un-route above is
   undone by the provider's own `native-registered` when it comes back.
5. **A camera cannot be a sensor.** A ref that resolves to a camera is
   `unsupported` — otherwise the runner's own onboard slice write would re-feed
   the bridge through its sustain.
6. **Attaching a sensor does not add `onboard` to `motionSources`.** The bridge
   emits only while the camera's **active** detection config lists `onboard`;
   otherwise it logs `camera-sensors: trigger not forwarded — the camera does
   not list \`onboard\`` with `meta.reason` `onboard-not-listed` or
   `no-active-detection`. A camera with NO active detection config (no slot,
   detection stopped) therefore gets **nothing** from its sensors — no export,
   no recorder band, no episode row — while its own firmware motion still
   reaches all of those. Gating on the stored list instead is a CS-2 question.
   The status says so (rule 14), from the same predicate the gate asks.
7. **The rise is the camera's event.** A sensor rise (the shared
   `evaluateSensorEdge`, first-sighting freshness and the watch start included)
   is emitted as `MotionOnMotionChanged { deviceId: camera, source: 'onboard',
   triggeredBy: { kind: 'sensor', deviceId } }`. `triggeredBy` is optional on the
   wire; absent means the camera, because only the bridge ever sets `sensor`; a
   malformed value is logged and read as the camera. The hot path does no I/O.
8. **"In addition" is camera OR sensor, and the two sides are held in
   different places.**
   - The **camera's** `false` is held back from `handleSessionMotion` only (block
     9b) while an attached sensor is high. Every other consumer — the D475
     episode row, the recorder's event band, the HAP / Alexa / HA exports, the
     camera grid, the runner's onboard-analyzer side-channel, lazy audio — still
     sees the camera's raw `false`.
   - The **sensors'** `false` is withheld inside the bridge while the camera's
     own motion is fresh: it is never put on the bus, so NO consumer sees it,
     and it is dropped rather than deferred. The camera's own later `false` (or
     its cooldown) ends things instead.
   - The camera counts as high only while its last own edge was `true` AND
     younger than its `motionCooldownMs` (heartbeat-only cameras). A camera with
     no attached sensor is never held.
9. **A sensor stuck high is bounded.** When no real rise (an edge, never a
   sustain tick) has landed for the camera's `maxSessionHoldMs`, the sustain
   stops, both holds are released, the camera's `false` is sent, and
   `camera-sensors: sensor high too long — sustain stopped` is logged at `warn`
   with `meta.reason: 'sensor-stuck-high'`. The next real rise re-arms it. When
   the camera's own motion is still fresh at that moment, the `false` is
   withheld as in rule 8 (`meta.falseWithheld`), so the session stays the
   camera's to end.
10. **The sustain interval is capped under the episode close.**
    `sustainIntervalMs(cooldown)` = `min(max(1 s, cooldown / 2),
    MOTION_CLOSE_AFTER_MS / 2)` — 7.5 s at the default — shared with D392's
    device-activity source (amended there).
11. **First trigger wins — per session and per episode row.** The session
    registry keeps the trigger that opened it; a refire by the camera never
    changes it. It is on the `detection session: dispatched on motion`, `session
    motion → attach latency` and close lines, never in the runner's attach
    config. On the D475 row, `triggeredBy` is written **only** for `source:
    'onboard'` episodes, **only at open**, through the tracker's `regionData`
    (which the tracker reads only on open). D475's `MotionEventSchema` gained a
    third optional field, `triggeredBy` (it follows `mediaUrl` in the schema;
    the first two were `durationMs` and `edges`).
    **Absent on a row means "not recorded"** (legacy, analyzer, device-activity),
    never "camera" ([D393](adr-0393-a-measurement-that-failed-is-not-a-measurement-of-zero.md)).
12. **A row is kept open by `true`s, never closed by a `false`.** A D475
    `(camera, 'onboard')` row closes only on its own quiet timer,
    `MOTION_CLOSE_AFTER_MS` (15 s) after the last `detected: true` from either
    side. A `false` from the camera or from the bridge never closes it; neither
    does it close the recorder's event band, which closes on its post-buffer.
    While an attached sensor stays high, the bridge's sustain ticks (≤ 7.5 s)
    keep ONE row open, crediting the episode's first trigger.
13. **Session dispatch honours `motionSources`.** `handleSessionMotion` requires
    its trigger and drops a source the camera does not list, before the lock (both
    edges) and again inside it on the re-read config, with a line sampled per
    `(deviceId, trigger)` (the first drop and every 50th, carrying `dropCount`).
    An unknown wire `source` is dropped with a `warn`, never forwarded as
    `undefined`. The bootstrap forwards the trigger, which revives D392's rate.
14. **Status names every attachment.** `CameraStatus.cameraSensors` reports each
    ref as `ready | offline | missing | unsupported | unreadable` from the
    controller's memory, with no I/O on the status path. A configured status
    also carries `notForwarded` (`onboard-not-listed | no-active-detection`)
    when the bridge would drop every rise — the same predicate as rule 6's gate —
    and the camera card warns on it: a ready sensor that can never fire must not
    look healthy (D62). Before the first
    answered settings read a camera reads `unreadable: camera sensor mappings not
    loaded`, never `not-configured`
    ([D315](adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry.md)).

## Consequences

- **HomeKit, Alexa and the HA export now also fire on the attached sensor**,
  because they consume `MotionOnMotionChanged`. That is intended: the sensor IS
  the camera's onboard motion. The recorder's event band opens on it too.
- **One session, raw edges elsewhere.** Because the hold is at session dispatch
  only, a camera that clears while its sensor is high shows motion clear on the
  exports while the session and the D475 row stay open. Coalescing the raw and
  effective level everywhere is CS-2 (D673).
- **A continuous PIR is released after `maxSessionHoldMs`** without a new rise,
  and re-arms at its next real rise. That is the cost of bounding a lost `off`.
- **D392 device-activity ticks every ≤ 7.5 s** instead of 15 s at the default
  cooldown — one extra bus event per 7.5 s per high device, in exchange for one
  row per activity run.
- **The dispatcher gate changes sessions in both directions.** It can shorten
  sessions on onboard-only cameras that had been re-armed by the analyzer
  side-channel's `source: 'analyzer'` transitions; and an `analyzer`-only camera
  is no longer opened by its firmware's `onboard` edges. The drop line's
  `dropCount` (per camera and trigger) measures both; Task 14 of the CS-1 plan
  records it per camera.
- **Unchanged here, re-decided in D673:** lazy audio reacts to every source;
  `onboardMotionDrivesAnalyzer` also opens the frame-diff side-channel on a
  sensor-triggered onboard event (the runner's gate stays `source === 'onboard'`).
- **Rollout needs a `@camstack/server` release, and it goes first.** No cap
  method was added and the behaviour lives in the addons — the event bus does
  not validate payloads and `applyDeviceSettingsPatch` takes a loose input — but
  everything the operator READS passes the server's generated cap routers,
  which validate `getCameraStatus` / `getCameraStatuses` / `getMotionEvents`
  output with the `@camstack/types` bundled in the installed server and strip
  unknown keys. On an older server `CameraStatus.cameraSensors` and
  `MotionEvent.triggeredBy` never reach the admin UI or `hub.mjs`: the card
  reads "status unavailable from this node" and the rows show no trigger, while
  the bridge, the session and the row write all work. So: publish `types` and a
  `@camstack/server` containing it, apply it (agents, then hub), THEN deploy
  `addon-pipeline-orchestrator`, `addon-post-analysis` and `addon-admin-ui`. The
  optional fields keep every mixed-version pair at "not recorded" / "status
  unavailable", never a wrong claim. The motion-source label change is a
  rename of a label only.

- **Amended by [D673](adr-0673-a-camera-sensor-has-a-mode-and-one-bridge-emits-the-cameras-effective-onboard-motion.md)
  (2026-10-01).** Rule 8's two holds are replaced by the bridge being the one
  emitter of the effective stream (the block-9b hold is deleted for split
  cameras; an unsplit provider's clear is still held at session dispatch while a
  sensor sees motion, until the emitter guard's deferred map is empty); rule 9's
  bound is per sensor; the Confirm / Replace modes, the raw/effective split and
  the two deferred questions (lazy audio, `onboardMotionDrivesAnalyzer`: both see
  the effective stream) are decided there. Pass-through episode rows now record
  `triggeredBy: camera`. The release order in the last bullet above is
  superseded by D673's (server, orchestrator, providers, addon-pipeline,
  admin-ui).

## Enforcement

Tests, each with its disarms recorded in the CS-1 block reports:

- `packages/addon-pipeline-orchestrator/src/__tests__/session-motion-source-gate.spec.ts`
  and the 806/807/808 cases of `on-motion-session-cutover.spec.ts` — rule 13.
- `camera-sensors-settings.spec.ts` — rules 2 and 3 (refused writes nothing;
  `null` is written; the parsed value is stored).
- `camera-sensors-resolver.spec.ts` — rules 4 and 5.
- `camera-sensors-source.spec.ts` — rules 6 and 7 (first sighting, watch floor,
  `false` only when every sensor is quiet, first trigger wins).
- `camera-sensors-controller.spec.ts` and `camera-sensors-ports.spec.ts` —
  lifecycle, coalescing with no timer, no I/O on the hot path; rule 4's
  re-queue (`a sensor whose binding was retracted and came back is re-attached
  and routes again (an HA restart)`). The re-kick case
  (`a request landing at microtask depth 2…`) is only as good as the depth it
  probes: re-run its disarm whenever the controller changes.
- `camera-sensors-in-addition.spec.ts` — rules 8 and 9 (`the PIR going quiet
  while the camera still sees motion keeps the session`, `a heartbeat-only camera
  … past its cooldown`, `a sensor stuck high stops sustaining after
  maxSessionHoldMs…`, `a stuck release while the camera still sees motion
  leaves the session to the camera`).
- `camera-sensors-forwarding.spec.ts` — the one predicate behind rule 6's gate
  and rule 14's `notForwarded`; the admin `camera-card-model.spec.ts` case `a
  READY sensor that can never fire is a warning…`.
- `device-activity-source.spec.ts` (`always lands before a D475 episode closes on
  its quiet timer (D672)`) — rule 10.
- `session-triggered-by.spec.ts` — rule 11, session half.
- `camera-sensors-status.spec.ts` and the admin `camera-card-model.spec.ts` /
  `streams-motion-block.spec.tsx` — rule 14.
- `packages/types/src/pipeline/__tests__/camera-sensors.spec.ts` — the schemas,
  `mode` only `in-addition`, and rule 1's label scope; `device-contribution.spec.ts`
  pins the orchestrator's "Camera onboard AI" copy.
- `camera-sensors-acceptance.spec.ts` — camera 103 and PIR 3299 through the whole
  orchestrator. **#5** enforces "attaching a sensor does not add `onboard`" (rule
  6) and its `notForwarded` status; **#4** the session's first trigger; **#9**
  that a sensor held high re-asserts the camera inside `MOTION_CLOSE_AFTER_MS`
  (rule 12, the input half); **#10** an HA restart (binding retracted, then
  re-registered) re-attaches the PIR and it opens a session again (rule 4).
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/pipeline-analytics-e2e.spec.ts`,
  `an onboard episode opened by an attached sensor records it, and a later camera
  edge does not move it (D672)` — "the first trigger is fixed at open" (rule 11,
  row half); the camera / device-activity and malformed-trigger D672 cases.
- `event-store-projection.spec.ts`, `a legacy row with no trigger reads back with
  NO \`triggeredBy\` key — not recorded, never a guessed camera (D393)` — "absent
  on a row = not recorded" (rule 11), with an enforcing fake that drops
  undeclared columns.

Review only: that no other consumer of `MotionOnMotionChanged` starts treating
`triggeredBy` absent as "camera" for a source other than `onboard`.
