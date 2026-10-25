---
id: D249
title: A load chart shows what is MEASURED for its subject, or names the subject it cannot resolve
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/cluster/load/camera-load-attribution.ts
  - packages/addon-admin-ui/src/components/cluster/load/load-series.ts
  - packages/addon-admin-ui/src/components/cluster/load/CameraLoadPanel.tsx
---

> **2026-08-28.** The classification is no longer RENDERED anywhere. First
> `CameraAttributionPanel.tsx` was deleted (it showed the table under the
> charts); then the replacement inside `CameraLoadPanel` — a list naming every
> refused family and its `missingLink` — was deleted too, along with the
> shared-pool section and the panel's explanatory paragraphs. The operator's
> verdict on all of it: *"non portano alcuna informazione utile."*
>
> **The decision itself is unchanged, and so is its enforcement.**
> `camera-load-attribution.ts` was never the table — it is the GATE.
> `camera-load-rates.ts` derives `chartableCameraRoles()` from it and
> `isChartableContribution` refuses everything else, so an apportioned estimate
> still cannot be drawn as a measurement. The tests below are unchanged and
> still pass. What went is the SURFACE that explained the gate, not the gate.
>
> The cost is accepted deliberately: a family the chart refuses is now
> invisible rather than named, so an operator cannot tell "streaming is free"
> from "streaming is not measurable". That reasoning now lives only in
> `camera-load-attribution.ts` and in this record. If a future session wonders
> why streaming has no chart, it is because of `wiredToday: false` there — not
> because nobody noticed.

## Context

The operator asked for per-camera load charts: decode, transcode, recording,
detection, streaming. The obvious implementation is available and wrong.

Four of those five families DO run a child process per camera. The derived and
egress `ffmpeg` children are keyed on `deviceId`
(`packages/types/src/ffmpeg/sharing-key.ts:139`); the recorder runs one
passthrough `ffmpeg` per `(camera, profile)`
(`packages/addon-pipeline/src/recorder/addon/segment-writer.ts:88`); a decode
worker is forked per decode session and a session never spans two cameras
(`packages/addon-pipeline/src/session-decode/session-decode-coordinator.ts:683`);
a `StreamBroker` is keyed `${deviceId}/${camStreamId}` and maintains an EXACT
byte counter for its RTP ring
(`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:498`).

None of it can be read. `forkDecodeWorker` discards its source
(`packages/addon-pipeline/src/session-decode/fork-decode-worker.ts:107`);
`SegmentWriter`'s `ProcLike` deliberately has no `pid`
(`packages/addon-pipeline/src/recorder/addon/segment-writer.ts:13`);
`FfmpegPushReader` reads `child.pid` only to gate SIGKILL
(`packages/addon-pipeline/src/stream-broker/rtsp/ffmpeg-push-reader.ts:291`);
`rtpRingBytes` is private and absent from `getStats()`
(`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:2505`).
**No pid→deviceId map exists anywhere in this repo**, and the kernel's
`$process` registry has no `deviceId` field at all
(`packages/system/src/kernel/moleculer/process-service.ts:334`).

The fifth family is different in kind and always will be. Inference runs on a
pool shared by every camera on a `(node, runtime, device)`
(`packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts:413`),
and `deviceId` reaches it as a diagnostic label that "changes no dispatch
decision, no deadline and no shed rule"
(`packages/types/src/interfaces/inference-engine.ts:24`). Per-camera counting
already runs — inference milliseconds, processed and shed frames, bytes shipped
to the pool
(`packages/addon-pipeline/src/pipeline-runner/timing-sampler.ts:63`,
`packages/addon-pipeline/src/pipeline-runner/runner.ts:353`,
`packages/addon-pipeline/src/pipeline-runner/frame-lazy-metrics.ts:100`) — so
the tempting move is to apportion the pool's CPU by frame share and call it
per-camera detection load.

That is the failure this record exists to prevent, and it is not hypothetical:
on 2026-08-27 a number that merely LOOKED true sent a diagnosis sideways for
half a day (`docs/architecture/load-ledger.md`).

## Decision

**A load chart may plot a value only for a subject the system MEASURES it for.
Where the load is shared, the chart shows the shared total and names it shared.
An apportioned estimate is never rendered on an axis that a measured value
would occupy.**

Concretely: `camera-load-attribution.ts` is the single classification, and
`isChartablePerCamera` is the only gate the UI calls. It requires BOTH that the
family is `measured` and that the link to read it is wired today. A family that
is only `accounted` — real counting, real numbers, but a share of a pool rather
than a cost — never passes, however good the counters are.

The same rule governs aggregation: in `load-series.ts` a function's CPU split
is `null` unless EVERY process in it reported one. A partially-known sum is a
smaller number indistinguishable, on a chart, from a complete one.

## Consequences

- The per-camera surface shipped first as a TABLE of what can and cannot be
  attributed — that was the deliverable, not a shortfall of it. Three of the
  five families were wired shortly after and are now genuinely charted; the
  table itself was removed on 2026-08-28 (see the note at the top). The
  classification survives as `CAMERA_LOAD_ATTRIBUTION`, read by the gate and by
  a human, and rendered by nothing.
- Making a family chartable is now a specific, bounded task: record `child.pid`
  beside the `deviceId` the owning registry already holds, and expose it.
  `CAMERA_LOAD_ATTRIBUTION.missingLink` names exactly what each family needs.
- Detection can never become `measured`. If a per-camera detection number is
  wanted it must be presented as *share of a shared pool*, on its own axis,
  labelled as counted work — never as CPU.
- `null` shows as a gap and as an explicit caveat, which means an operator on a
  non-Linux node sees "unknown", not a clean-looking zero.

## Enforcement

`packages/addon-admin-ui/src/components/cluster/__tests__/camera-load-attribution.test.ts`
asserts that the shared pool is never chartable even though its counters are
wired, that every unwired family states its missing link, and that every row
carries `file:line` evidence.
`packages/addon-admin-ui/src/components/cluster/__tests__/load-series.test.ts`
asserts the `null` rule against a bucket with one unknown process. Both were
verified by disarming the guard and confirming the red.

The type system carries the rest: `CameraLoadAttributionRow` has no field for a
value, so an estimate has nowhere to live.
