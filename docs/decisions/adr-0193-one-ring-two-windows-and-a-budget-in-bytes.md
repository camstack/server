---
id: D193
title: One ring, two windows, and a budget measured in bytes
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/pre-roll.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts
---

> **Superseded in part by [D381](adr-0381-one-prebuffer-the-broker-decides-whether-consumers-only-ask.md)
> (2026-09-07).** One ring, ONE window. The two configured windows below are
> retired — a consumer declares an intent and is served what the ring holds,
> capped at read time — because the census of 2026-09-07 found the third knob
> beside them (`preBufferSec`) retaining nothing on 22 of 22 warm streams while
> two others quietly sized the history that existed. What survives verbatim: the
> derived byte budget, the decoder-seed rule, and the battery default ("what the
> camera IS, not what it is doing").

## Context

[D192](adr-0192-the-broker-ring-is-the-only-pre-roll.md) put the recorder on the
broker's ring and said the duration belongs to the broker alone. It shipped with
ONE duration: `preRollMs`, the detection knob, `0` by default and capped at
`PRE_ROLL_MAX_MS` (6 s). The operator then asked for what the ring was built to
give — **10 s of pre-event footage on every mains camera** — and the census of
2026-08-20 found that the single number could not deliver it. Three couplings,
all of them silent:

1. **`preRollMs` is the DETECTION knob.** Raising it cluster-wide hands every
   detection dial on the fleet a backlog to drain before it reaches the live
   edge. The operator asked for a RECORDING pre-roll and would have paid for it
   in detection latency on 102 streams.
2. **`PRE_ROLL_MAX_BYTES = 8 MiB` truncated the answer.** Above ~6.5 Mbps "10 s"
   silently became 6. A contract that promises 10 s and delivers 6 on a 4K
   camera is the exact promise/delivery divergence D192 exists to forbid — and
   it clamped without printing a line, so the truncation was indistinguishable
   from a camera that had not been warm long enough.
3. **`setPreRollMs` grew the decoder-seed ring** to `preRollMs/1000 + 2`. At
   10 s that is 12 s of Annex-B retention per stream, bought for a consumer
   that does not exist: a recorder dials RTSP and takes its window as a join
   burst; only a PUSH-plane decoder reads the seed.

The obvious alternative — one number, raised — is what those three findings
reject. The other obvious alternative, a second ring, is worse: the same
packets retained twice on the same node.

## Decision

**One RETENTION, two SERVED windows.** The ring is kept to
`max(detectionPreRollMs, recordingPreRollMs)`; each consumer is served its own
window, cut from that one retention at read time by the intent it declared on
its dial path. `getRtpPreRollBuffer(windowMs)` takes the window as an argument
and the restreamer's pre-roll supplier takes the `RestreamIntent`, so a third
intent cannot arrive with wiring of its own.

Three rules fall out and are not negotiable:

- **The decoder seed follows DETECTION alone.** `setDetectionPreRollMs` sizes
  it; `setRecordingPreRollMs` touches nothing but the retention.
- **The byte budget is derived, not guessed.** `preRollBudgetBytes(windowMs,
  observedKbps)` replaces the flat cap: the window's own weight at this stream's
  measured `bitrateKbps`, plus headroom for the GOPs above the mean, bounded by
  an absolute per-stream ceiling of 32 MiB. An unmeasured bitrate (`0`, which is
  every stream's first stats window) falls back to the historical 8 MiB, and
  the ceiling **logs when it bites**.
- **The recorder's keep gate is never narrower than the widest window the
  broker can serve.** `DEFAULT_EVENTS_BAND_BUFFER_SEC.preBufferSec` is therefore
  `RECORDING_PRE_ROLL_MAX_MS` (15 s), so an operator raising the cluster setting
  cannot walk past the gate silently and have the recorder delete the seconds
  the ring just handed the writer.

The recording window ships **ON at 10 s**, and at **0** for a battery camera and
for a terminal (`pull-http`) relay. Battery is read as
`DeviceFeature.BatteryOperated`, not as a `deriveBatteryPresence` verdict: the
question is what the camera IS, not what it is doing, and a retention default
that flapped with naps would make the pre-roll a recording carries depend on
when the operator last looked.

## Consequences

- **RAM is now a per-stream function of bitrate, and it is only spent under
  demand.** The ring fills while a stream is dialed; an idle camera retains
  nothing however the window is configured. The honest ceiling per stream is
  32 MiB and the honest expectation is `10 s x bitrate x 1.5` — ~4 MiB at
  2 Mbps, ~15 MiB at 8 Mbps. The consuntivo is post-deploy, on the real fleet,
  for the reason above: the number is demand-shaped, not census-shaped.
- **A battery camera discovered late still converges.** The feature snapshot is
  refreshed on re-publish, so `ensureBroker` re-applies both windows to a broker
  that already exists rather than returning early. Without that, a camera that
  turned out to be battery-operated would hold a 10 s retention for the life of
  the process.
- **`preBufferSec: 15` is in `packages/types`** and therefore rides the next
  train. Until it lands, a deployed addon reads the old default of 10 s — which
  still covers the shipped 10 s recording window exactly, so the invariant holds
  in the field throughout. Only an operator who RAISES the cluster pre-roll past
  10 s before the train would out-run the gate.
- **The prime log line names both windows.** `detectionPreRollMs` /
  `detectionPreRollSpanMs` and `recordingPreRollMs` / `recordingPreRollSpanMs`
  replace the single ambiguous pair: "did the recorder get its 10 s" and "did
  detection keep its 0" are the two questions that line exists for, and one key
  could answer only one of them.
- **The first segment is still older than its own name.** D192's open
  consequence is unchanged and now larger in magnitude (up to 10 s rather than
  6). It stays train-bound for the same reason: correcting the label needs the
  broker to report the span it served, and that field is on `RtpSource`.

## Enforcement

- `packages/addon-pipeline/src/stream-broker/__tests__/pre-roll.spec.ts` —
  `preRollBudgetBytes` (including the clamp flag), `resolveRecordingPreRollMs`,
  and `the selectors admit the RECORDING window, not just detection's`, which
  fails if either the selection or the span bound is ever re-clamped at the
  detection ceiling.
- `packages/addon-pipeline/src/stream-broker/__tests__/stream-broker-pre-roll-ring.spec.ts`
  — `the ring retains max(detection, recording)`: a recording window alone keeps
  history with detection off, the decoder seed does NOT grow with it, and the
  budget moves with a measured bitrate.
- `packages/addon-pipeline/src/stream-broker/__tests__/rtsp-pre-roll-prime.spec.ts`
  — `the two windows are served side by side` pins the SHIPPED configuration
  (detection 0, recording 10 s) at one keyframe, including the plain viewer
  beside them still getting one GOP (the D57 blast radius). Verified by
  reverting the per-intent lookup: 5 of 12 fail.
- `packages/addon-pipeline/src/recorder/addon/__tests__/band-decision.spec.ts` —
  `pre-roll contract` is the directional guard, now against
  `RECORDING_PRE_ROLL_MAX_MS`, with an explicit `preBufferSec: 0` excluded from
  the invariant by name.
