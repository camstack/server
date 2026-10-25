---
id: D475
title: A motion episode belongs to its (device, source), and the pipeline never overwrites a sensor's motion state
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/types/src/capabilities/motion.cap.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/motion-episode.ts
  - packages/addon-post-analysis/src/pipeline-analytics/motion-episode-tracker.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/motion-edge-codec.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
  - packages/addon-provider-hikvision/src/hikvision-camera.ts
  - packages/addon-provider-amcrest/src/amcrest-camera.ts
  - packages/addon-provider-homeassistant/src/devices/ha-binary-sensor-device.ts
last-verified: 2026-10-04
---

> **Superseded in part by [D696](adr-0696-a-cameras-motion-slice-means-motion-and-only-the-orchestrator-writes-it.md)** — §4 ("the phase machine stays the only writer" of the camera's `motion` slice). A camera's `motion` slice is the effective motion, and only the orchestrator writes it; the runner's phase machine and the camera providers no longer write it. The rest of this record stands.

## Context

The operator's rule, verbatim (Italian): "Stiamo parlando di 2 tipi: uno con
sensore e uno dall'analyser. Per il primo caso la motion si deve chiudere
sempre con il delay della cap di 15 secondi dall'ultimo fronte alto. Ogni
evento on si deve salvare perché da un'idea quando la camera ha trovato un
movimento rilevante. Per l'analizzatore va bene che scrive lui on e off sempre
dopo 15 secondi di calma dall'ultimo movimento rilevante. Ma la pipeline non
deve mai sovrascrivere ciò che i sensori fanno."
[We are talking about 2 types: one with a sensor and one from the analyzer. For the first case the motion must always close with the cap's 15-second delay from the last rising edge. Every on event must be saved because it gives an idea of when the camera found a relevant movement. For the analyzer it is fine that it writes on and off itself, always after 15 seconds of calm from the last relevant movement. But the pipeline must never overwrite what the sensors do.]

Two motion sources exist on a camera (`MotionSourceEnum`: `onboard`,
`analyzer`, `device-activity`), and `motionSources` is an ARRAY — a camera can
carry both a firmware sensor and the SW analyzer at once. Three defects
followed from treating them as if they could not overlap:

1. **One shared throttle map for two sources.** `handleMotionAnalysis`
   (analyzer) and `handleOnboardMotion` (onboard/device-activity) both wrote
   `lastMotionInsertByDevice`, keyed by `deviceId` alone. Its own docblock
   claimed the two paths were "mutually exclusive at the event-emit layer" —
   false, by construction of `motionSources` being an array. On a camera with
   both, the analyzer's noisy per-frame samples and the sensor's ~1 Hz
   keepalive (`motion-marker-policy.ts` measured Reolink and Hikvision both
   repeating `detected:true` at ~1 Hz for the WHOLE burst, never a `false`)
   fought over one piece of state, and whichever fired last decided what the
   camera's motion "was".
2. **A heartbeat that wrote a row every 5 s while motion stayed on**
   (`MOTION_EVENT_HEARTBEAT_MS`), because the only way the pre-D475 code had
   to say "still happening" was another INSERT. ~7,200 rows/day/camera, most
   of them identical in every field but `timestamp`.
3. **The phase machine has one writer, and it did not check who asked.**
   `handlePhaseChanged` (`pipeline-runner`) is the SOLE writer of a camera's
   `motion` cap-state slice, driven by `reportMotion` off `MotionOnMotionChanged`
   — for EVERY source in `motionSources`, unconditionally. On a camera with
   both `onboard` and `analyzer`, an analyzer transition reached
   `reportMotion` exactly like an onboard one and could flip the slice the
   sensor had just set — the literal shape of "the pipeline overwrites what
   the sensor did" the operator named.
4. **`autoClearAfterMs` was decorative and inconsistent.** Nothing read the
   live cap value (confirmed and documented on `motion.cap.ts` before this
   ADR). Hikvision seeded its own 3 s alarm-stream inactivity timer there; HA's
   binary-sensor provider seeded a bare `15_000` that matched nothing; every
   other provider seeded `null`. The field's name promised a real answer and
   gave none.

Two designs were tried and rejected before the one below:

- **A second writer for the phase-machine slice, gated by source** — rejected
  outright: CLAUDE.md forbids two authorities on one piece of state, and
  `motion.cap.ts` already documents `handlePhaseChanged` as the sole writer.
  Adding a second one to fix a "the wrong source wrote it" bug would just move
  the disagreement, not remove it.
- **One row per rising edge, always** (the literal reading of "ogni evento on
  si deve salvare" [every on event must be saved]) — rejected because a firmware source's ~1 Hz keepalive
  would still be one row per second for the whole burst, the exact waste
  D475 exists to remove. The operator, asked, chose one row per EPISODE
  carrying its duration, over "only state" and over "a separate OFF row" —
  and separately corrected the row shape mid-implementation: the rising edges
  within an episode are kept as an ARRAY of offsets, not collapsed into a
  count, so "every ON event is saved" is honoured without a row per event.

## Decision

**1. One constant is the cap's close delay, and every provider agrees.**
`MOTION_CLOSE_AFTER_MS = 15_000` (`motion.cap.ts`). Every provider that seeds
`autoClearAfterMs` on a `Camera` device now writes this constant while
`detected: true` and `null` while `false` — Hikvision's own 3 s alarm-stream
timer stays exactly what it was (the clock Hikvision itself clears its slice
on) but no longer leaks into what the FIELD claims; HA's binary-sensor
provider (`Sensor` device type) now writes `null` unconditionally, because a
`Sensor` pushes its own real falling edge and has no episode-close delay to
report. `pipeline-analytics`'s episode closer imports the SAME constant
directly — not by reading the live cap value (nothing does that; see the
field's own doc for why that would add a second falling-edge authority) — so
the number the field advertises and the number that actually governs a close
are, for the first time, the same number.

**2. Episode state is keyed by `(deviceId, source)`, never shared.**
`lastMotionInsertByDevice: Map<number, …>` is gone. `MotionEpisodeTracker`
keeps one signal per `${deviceId}:${source}` key
(`motion-episode-tracker.ts`), fed by the pure decision table in
`motion-episode.ts` (`decideMotionSignal`). A camera with both `onboard` and
`analyzer` in `motionSources` gets two fully independent episodes — closing
one never touches the other.

**3. One row per episode, UPDATEd once at close.** `MotionEventSchema` gained
two fields:

- `durationMs: number | null | undefined` — `null` while open, the final
  `lastOnAt - startedAt` once closed, **absent** on a row written before this
  column existed. `lastOnAt`, not `closedAt`: the close delay is a quiet
  CONFIRMATION, not movement, and folding it in would report 15 s of motion
  for an instantaneous trigger.
- `edges: readonly number[] | undefined` — ms offsets from the episode's own
  `timestamp` (so the first entry is always `0`) of every genuine off→on
  TRANSITION the episode saw, not every observation. A firmware keepalive
  repeating `true` at ~1 Hz for one continuous burst produces exactly ONE
  edge; a source that pushes an explicit `false` mid-episode and then resumes
  before the quiet window elapses produces another. Stored compactly
  (`motion-edge-codec.ts`, mirroring `position-codec.ts` from D471: a `me1:`
  prefix, gzip, base64, and a decoder that answers `[]` on anything it cannot
  read, never throws) and written to the row only at CLOSE, in the same
  UPDATE as `durationMs` — never on every edge.

  `lastOnAt` (drives the close-timer re-arm and `durationMs`) and `edges`
  (drives the array) are deliberately different clocks: every `detected:true`
  observation — transition or plain continuation — refreshes `lastOnAt` and
  re-arms the 15 s timer, which is what makes "15 s of quiet since the LAST
  relevant movement" correct for a long continuous burst; only a genuine
  transition appends to `edges`.

  **The `durationMs` sentinel.** SQL cannot distinguish "this column was
  never given a value because the row predates it" from "explicitly set to
  NULL" — `declareCollection`'s ALTER TABLE backfills every existing row's
  new column with a real SQL NULL, bit-for-bit the same NULL an open episode
  would write. Writing a literal `null` for "open" would have made a
  brand-new open episode indistinguishable from a legacy row — exactly the
  failure this ADR was told to avoid. `insertMotion` writes `-1`
  (`OPEN_EPISODE_SENTINEL`, private to `event-store.ts`) in place of `null`;
  `queryMotion` translates it back to `null` on the way out, so nothing
  outside that one file ever sees the sentinel, and the public contract
  (`null` = open, absent = legacy, a number = closed) holds. This was caught
  by a test, not by design review: the first implementation wrote a real
  `null` and the "open episode vs. legacy row" test failed exactly as
  intended (see Enforcement).

  `MOTION_EVENT_HEARTBEAT_MS` is deleted; nothing writes a heartbeat row any
  more.

**4. The phase machine stays the only writer, but a sensor-owned camera
suppresses the analyzer at the SOURCE.** `handlePhaseChanged` did not change —
it is still the sole writer of the `motion` cap slice, for every source,
which is what CLAUDE.md requires. What changed is what reaches it: the
`MotionOnMotionChanged` subscription in `pipeline-runner/index.ts` now calls a
pure helper, `cameraOwnsMotionViaSensor(motionSources)` — true when
`motionSources` contains anything other than `'analyzer'` — and refuses to
forward an `analyzer` transition to `reportMotion` on such a camera. The
analyzer may still be RUNNING there (shared detection decode,
`handleOnboardMotionAnalyzer`'s dynamic gate is unaffected — that gate is
`source === 'onboard'` and stays that way, D392); its motion edges simply
never reach the one thing that would let it re-describe what the sensor
already decided. A camera whose `motionSources` is `['analyzer']` alone is
untouched — `cameraOwnsMotionViaSensor` returns `false` and the analyzer
drives the phase machine exactly as it did before this ADR.

**5. Shutdown force-closes every open episode.** `MotionEpisodeTracker.closeAll`
is called from `onShutdown`, after the bus subscriptions are torn down (no new
rising edge can reopen one) and before anything else stops. Each row gets its
real UPDATE — `durationMs` computed from whatever `lastOnAt` it had, `edges`
as collected — with a `reason: 'addon-shutdown'` on the log line, rather than
being left at `durationMs: null` forever because the process that would have
closed it 15 s later is gone.

## Consequences

- `MotionEvent.durationMs` / `.edges` are additive, optional fields — a cap
  change, so `npm run codegen` ran and produced no router/mount drift (no
  method signature changed).
- `autoClearAfterMs` no longer reflects a camera's own configured
  `motionCooldownMs` (the runner's phase-machine cooldown, which still governs
  stream-subscription gating, unchanged) — it reflects the system-wide
  episode-close constant instead. Safe: nothing reads the live field, verified
  before this ADR and unchanged by it.
- Motion-activity LTS sampling (`AnalyticsLts`, fed by `EventStore.onMotionSample`)
  used to ride every heartbeat insert (~5 s while motion stayed on). Episodes
  insert once, at open — `EventStore.noteMotionSample` is now called directly
  from both motion handlers on every `detected:true` observation (transition
  or continuation), independent of whether a row was written, so the sampling
  density is unchanged (arguably improved: it is no longer bounded by the old
  5 s heartbeat).
- The `PipelineAnalyticsDetectionEvent` bus event now fires once per genuine
  edge (open or a further edge inside an open episode) rather than once per
  heartbeat-or-transition insert — strictly fewer duplicate notifications for
  the same visual episode.
- A pre-existing architectural oddity, found but NOT fixed by this ADR:
  Hikvision and Amcrest both write the `motion` cap slice directly
  (`setCapSlice`) from their own onboard event handlers, in addition to the
  runner's `handlePhaseChanged` — two writers of one slice, which
  `motion.cap.ts`'s own docblock claims does not happen. Redesigning that is
  out of this ADR's scope (it long predates D475 and touches every camera
  provider's motion path); it is recorded here so it is not mistaken for
  something this change introduced.
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/pipeline-analytics-e2e.spec.ts`'s
  "marks a DROUGHT once per window" test asserted the OLD 3-row-per-burst
  shape; rewritten to assert the new 1-row-open-episode shape (same
  still-capture/drought behaviour, unchanged).

- **Amended by [D673](adr-0673-a-camera-sensor-has-a-mode-and-one-bridge-emits-the-cameras-effective-onboard-motion.md)
  and [D696](adr-0696-a-cameras-motion-slice-means-motion-and-only-the-orchestrator-writes-it.md)
  (2026-10-01).** The "pre-existing architectural oddity" above is closed:
  Hikvision and Amcrest no longer write the `motion` slice. A camera's onboard
  episode now comes from the bridge's EFFECTIVE stream (a pass-through for a
  camera with no attached sensor), and a pass-through row records
  `triggeredBy: camera`; D672 added the optional `triggeredBy` field.

## Enforcement

- `motion-episode.spec.ts` (pure decision table) and
  `motion-episode-tracker.spec.ts` (timers + persistence orchestration, fake
  clock) — 19 tests. Disarm-verified: reverting `isNewEdge`'s transition check
  to always-false fails "a true tick after an observed-off... is a NEW edge";
  reverting `closeAll`'s iteration to a no-op fails "closeAll force-closes
  every open episode".
- `motion-edge-codec.spec.ts` — 8 tests, mirrors `position-codec.spec.ts`'s
  discipline (round-trip, empty, garbage never throws).
- `event-store.spec.ts` — added tests for `updateMotion` and the
  open/closed/legacy `durationMs` distinction. Disarm-verified: replacing
  `OPEN_EPISODE_SENTINEL = -1` with a literal `null` fails "an episode row
  opens with durationMs: null... " — this is the sentinel bug described above,
  caught by removing the fix.
- `sensor-owned-suppresses-analyzer.spec.ts` — 9 tests on the runner
  (`cameraOwnsMotionViaSensor` unit cases + the bus-subscription harness from
  `device-activity-motion.spec.ts`). Disarm-verified: short-circuiting the
  suppression check to `false` fails 3 of the 4 harness tests.
- `pipeline-analytics-e2e.spec.ts` exercises the full addon boot + bus
  subscription wiring for the onboard motion path; 353 files / 3730 tests in
  `packages/addon-post-analysis/src/pipeline-analytics` pass (this package's
  `tsconfig.json` excludes `__tests__`, so a green `npm run typecheck` is not
  evidence these compile — they were run directly with `vitest`).
- `npm run typecheck` (all packages) and `npm run codegen:check` both pass.
