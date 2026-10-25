---
id: D277
title: A failure is reported per camera WITH its denominator, through a capability twinned on load-contribution — never as a log line to be grepped
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/types/src/metrics/failure-counters.ts
  - packages/types/src/capabilities/failure-contribution.cap.ts
  - server/backend/src/api/core/failure-contributions.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/failure-report.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/person-over-vehicle.ts
  - packages/addon-pipeline/src/pipeline-runner/failure-report.ts
---

## Context

The operator, on 2026-08-28, after a day of triage: *"possiamo armare questi
errori intanto? Così al prossimo giro ricontrolliamo tutti questi punti."* [can we arm these errors in the meantime? That way on the next round we re-check all these points.]

Five failure modes were open, none of them measurable without a developer
reading raw logs:

| # | Failure | What was known | What was NOT |
| --- | --- | --- | --- |
| 1 | `enrichment crop native miss` | ~507 in 5 min at peak | its rate per camera |
| 2 | `inference timed out` (20 s) | ~120 in 6 h, 7 cameras | out of how many frames |
| 3 | plate OCR empty read | ~35% of reads | nothing — the branch was silent |
| 4 | `pipeline-analytics` at 4.9 GB, `stranded=4031MB` | logged every 5 min | nothing retained |
| 5 | phantom person on a parked car | 4 of 23 tracks, dev 102, hand-counted | anything repeatable |

**The measurement mistake that motivated all of this happened the same day.**
The enrichment-crop miss count was read as "35× worse than yesterday". Divided
by the successful `media capture` count on the same path it was **0.25 misses
per landed capture, 0.08–0.33 across twelve hours, no trend** — completely flat.
The count had moved because the traffic had moved. A failure number published
without its denominator is not a weak measurement; it points the wrong way.

Counting already existed in places — `CaptureScheduler`'s per-device window,
`KeyFrameCaptureLog`, `bumpCropMetric`. Every one of them ends in a log line,
and `key-frame-metrics.ts` already records what that costs: on 2026-08-06 the
only way to establish a 21.7% key-frame gap was to correlate Loki lines against
the media store by hand. `bumpCropMetric` is worse than that — it is
process-global with no `deviceId`, so it can say the fleet is missing 25% of its
crops and never say which camera.

Alternatives considered and rejected:

- **Fold the counters into `load-contribution`.** The reporting discipline is
  exactly right, but the invariants are opposite. A `load-contribution`
  measurement is *absent, never zero* — a zero would claim a camera cost
  nothing. A failure counter's zero (`attempts: 400, succeeded: 400`) is the
  most valuable value on the surface: it is the proof a fix landed. Merging
  them would also break the reconciliation that gives `load-contribution` its
  point — contributions are subtracted from `metrics.node-processes-snapshot` to
  find processes nobody claims, and a failure owns no process.
- **A per-event log line with `tags: { deviceId }`.** 507 misses in five minutes
  is ~100 lines/minute from one path on one node. That is its own defect.
- **A new persisted table.** Nothing here needs to survive a restart: the
  question is "what is this camera losing now, and out of how many tries", and
  `sinceMs` already says which incarnation the numbers belong to. Retention
  would be a cost with no reader.

## Decision

**1. One shared counting primitive.** `FailureCounters`
(`packages/types/src/metrics/failure-counters.ts`) — bounded, cumulative,
timer-free, IO-free. Keyed on `(deviceId, family, variant?)`. Every observation
moves `attempts`; a landing one also moves `succeeded`; a failing one names a
reason. `attempts - succeeded` always equals the sum of the reason counts. A
second implementation would be a second set of denominators, so there is one.

**2. Every entry is per camera, and an entry that cannot name its camera is
refused.** `deviceId` is a positive integer — the same value every log line in
this repo carries as `tags.deviceId`. There is no fleet bucket and no `null`
device. An unnamed per-camera count is indistinguishable from a shared one and
would turn one camera's failures into everybody's.

**3. Counters are CUMULATIVE and a read never resets them.** The argument is
`load-contribution`'s own, about `cpuSeconds`: a rate needs a window, a window
needs a sampler, and a counter can be differenced by whoever already keeps a
history. A draining read has a second failure this surface cannot afford — two
consumers polling it would each destroy half of the other's numbers, silently.
`sinceMs` is the incarnation marker; a consumer differencing two reads drops the
interval when it changes.

**4. The transport is a new internal collection capability,
`failure-contribution`, deliberately twinned on `load-contribution`:**
`mode: 'collection'`, `internal: true`, `mount: { kind: 'skip' }`. No tRPC route
of its own, no generated hooks. `addons.listCapabilityProviders` enumerates it
and the hub's `CapabilityRegistry` already holds an RPC proxy per provider, so a
forked runner's entries reach hub-main over transport that already exists — no
new UDS message, no second registry (D3). The operator reads the assembled
result through **`system.getFailureContributions`** (admin), answered by
`buildFailureContributionPlane`, which is `buildLoadContributionPlane` line for
line: enumerate, stamp `addonId` hub-side, report a provider that fails and keep
going.

**5. The hub plane never sums and never divides.** Both are the consumer's job,
on entries that carry `attempts`. A hub-side fleet total is the number that
answered nothing.

**6. The reason vocabulary is shared with D276's `previewMissReason`.** A row
says which track lost its tile; these counters say how often that camera loses
one and out of how many tries. Two spellings for the same loss would break that
join silently, so the strings are named once per addon
(`runtime/failure-report.ts`, `pipeline-runner/failure-report.ts`) and reuse
D276's words.

**7. A phantom person is COUNTED, never suppressed.** `personOverVehicle` is a
pure predicate used only to attribute a counter. A person leaning on a car is a
real person, and on a driveway camera that is most of the people the system will
ever see — D275 made the same call for stationary objects. Containment
(intersection over the PERSON's area, ≥0.8), not IoU: a person box inside a car
box has a small intersection over their union because the car is far larger, so
IoU would find nothing.

### What is measured, and by what denominator

| Family | Reported by | Denominator | Reasons |
| --- | --- | --- | --- |
| `enrichment-crop` | `pipeline-analytics` | every crop asked of the owning runner | `native-miss` |
| `capture-schedule` | `pipeline-analytics` | every capture that STARTED | `stale-drop`, `queue-overflow` |
| `plate-ocr` | `pipeline-analytics` | every accepted read | `empty-read`, `no-bbox`, `implausible`, `below-min-confidence` |
| `person-birth` | `pipeline-analytics` | every confirmed person birth | `person-over-vehicle` |
| `inference` | `pipeline-runner` | every call that returned inside the deadline | `timeout` |

A coalesced or cancelled capture fires neither callback: a track that closed
before its capture ran did not lose work, it stopped wanting it.

## Consequences

- **A framework publish train IS required.** `system.getFailureContributions` is
  a new method on a mounted cap: its router lives in the generated
  `server/backend` closure and its type in `packages/types`, so it reaches a
  node only inside a published `@camstack/server` (D16). Deploying
  `addon-post-analysis` / `addon-pipeline` alone ships the providers and the
  counting — correct, and inert, because nothing can call them. The addons must
  also be redeployed: the manifests now declare `failure-contribution`.
- **Storage cost: zero.** Nothing is persisted. The RAM ceiling is
  `MAX_KEYS` (1024) counters per process at ~200 B, ≈100 KB, against processes
  that declare RSS budgets in the gigabytes. Reasons past
  `MAX_REASONS_PER_KEY` (16) fold into `other` rather than being dropped, so
  the partition never stops summing to the loss.
- **No new log line runs at frame rate.** Every existing line on these paths
  (`enrichment crop native miss` at DEBUG, `capture queue full` throttled to one
  per camera per minute, `plate: read discarded`, `inference timed out`) is
  unchanged. The counters add none.
- **`enrichment-crop` reports one reason where the operator can see four.**
  `worker-lease-gone`, `no-registry-entry` and `jpeg-encode-failed` are runner-
  side, and `pipelineRunner.getNativeCrop` answers an ROI miss with `null`
  carrying no reason — while `FrameHandle` has no `deviceId`, so the runner
  could not attribute the split per camera even if it reported one. Splitting it
  is a cap change on the reply. Until then the honest name is `native-miss`,
  which is what the caller can stand behind.
- **`inference` reports no `variant`.** The slot exists and the operator asked
  for "which model". `awaitInferenceBounded` wraps `processFrame`, which runs the
  camera's whole pipeline graph behind one deadline; nothing at that seam knows
  which step held it. A guessed variant would look like an attribution and be a
  label. Absent, never invented.
- **Stranded memory (#4) is NOT armed here, deliberately.** `strandedMb` is
  `rss - heapUsed - external` and all three are process-internal;
  `metrics.node-processes-snapshot` is built from `ps` and `/proc`, which cannot
  see any of them. `heap-watch` computes the number inside each heavy runner and
  only logs it, and there is no runner→node self-report hop for it to travel
  on. Adding a nullable `strandedMib` column that nothing writes for the very
  process the operator asked about — `pipeline-analytics` — would be a leftover
  that reads as verification. The costed next step is in
  (planning repo: sessions/sessions.md). <!-- drift-ok: moved to the private planning repo -->

## Enforcement

- `packages/types/src/metrics/__tests__/failure-counters.spec.ts` — 9 specs on
  the primitive: per-camera attribution, the denominator, the partition
  identity, variant separation, the unnamed-camera refusal, read-without-reset,
  the reason fold and the key cap.
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/failure-report-wiring.spec.ts`
  — 6 specs through the REAL `createCaptureCrop`, `CaptureScheduler` and
  `personOverVehicle`, including one that asserts 500 attempts emit **zero** log
  lines.
- `packages/addon-pipeline/src/pipeline-runner/__tests__/failure-report-wiring.spec.ts`
  — 2 specs through the REAL `PipelineRunner` timeout path, one of which pins
  that a timeout is never counted as its own denominator (the timeout branch
  falls through to the same `return`).
- Disarmed and re-armed, with the counts observed: enrichment-crop miss note
  (1 red), enrichment-crop denominator (2 reds), scheduler `onStarted` (1 red),
  `personOverVehicle` containment (2 reds), inference timeout note (2 reds), the
  double-count guard (2 reds).
- No standalone guard script: the contracts live behind typed seams
  (`CaptureCropDeps.noteCropOutcome`, `CaptureSchedulerOptions.onStarted`,
  `PipelineRunnerConfig.noteInferenceOutcome`, `IFailureContributionProvider`),
  so a violation is a type error or a red spec.
