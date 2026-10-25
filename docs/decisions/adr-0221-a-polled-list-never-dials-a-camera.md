---
id: D221
title: A polled list never dials a camera — only the sources that LEAVE the server are mirrored
status: superseded
superseded-by: D224
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/repeat-warn-sampler.ts
---

> **Superseded by [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
> the same day.** The rule below — a polled view never performs a fallible read
> that leaves this server — still holds. WHERE it is enforced was wrong: this
> record put the mirror in the CONSUMER, and the mechanism it reimplemented
> already existed in each provider (`createRuntimeStateBridge`), merely
> configured with a 10s window against a 5s poll. The consequence that
> `CameraSwitchService` "is the only such path on this server" is FALSE — the
> privacy-mask editor writes the cap directly — so the mirror was stale by
> design on the one write an operator makes. The sampling half of this record is
> unchanged and still in force.

## Context

Opening the admin Cameras page wrote **337 WARN lines in one minute** on the live
hub on 2026-08-21 (17:15). The page is one `pipelineOrchestrator.getCameraStatuses`
polled every 5 seconds; that call composes `CameraStatus.switchedOff` for every
camera, and composing it reads eight authorities per camera (D113).

Seven of the eight are in-hub reads that answer in 5–15ms. The eighth,
`privacyMask.getOptions` + `getStatus`, **dials the camera**. So 29 cameras × 2
camera calls × 12 polls a minute = 696 device round trips per minute, for two
facts (is the video mask on, is the microphone on) that change only when an
operator changes them.

The first attempt at this problem, on 2026-08-08, was the per-source bound
(`SOURCE_TIMEOUT_MS = 1_200`). It fixed the right thing — one slow source no
longer consumed the budget of the seven that had already answered — and it made
the volume worse, because every slow camera now spent the *entire* bound on every
poll and announced it. Two second-order costs followed:

- the whole call was pinned at ~1250ms, since some camera in a 29-camera fleet is
  always slow;
- the six cheap authorities queued behind 58 outstanding camera probes and began
  timing out themselves. **158 of the 337 lines were `recording.getDeviceConfig`**
  — a source that answers in 9ms when it is asked on its own.

Raising the budget was considered and rejected: it makes the stall longer, not
shorter. Caching the whole authority read was considered and rejected: six of
those sources are cheap and must stay live, or an operator's recording toggle
would go unseen on the very page that shows it. Dropping the two planes from the
list and rendering them "unknown" was considered and rejected: `switchedOff` is
the badge that separates DISABLED from BROKEN, and a permanently-unknown badge
is the 2026-08-08 inversion by another route.

## Decision

**A view that is POLLED never performs a fallible read that leaves this server.**
The sources that leave — and only those — are served from a per-device mirror
(D49): the cold read awaits the probe so the first render is a real answer, every
read after it is answered from the mirror and refreshes in the background once the
entry is older than the refresh window, and **a refresh that answers nothing
changes nothing** — an uninformative plane never overwrites an informative one,
only the retry clock moves. Every WRITE this server routes to a mirrored authority
invalidates that device's entry. Sources that stay in-hub are NOT mirrored; they
are read live on every call.

Correspondingly, **a fault line on a per-device path that a polled call fans out
over is sampled per `(device, source)`**: the first occurrence in full, tagged with
the numeric `deviceId`, then one line per minute carrying
`suppressedSinceLastLine`. The message text does not change, so a grep still finds
it. The `CameraStatus.degraded` **entry is never sampled** — only the line — or the
payload would start claiming a stage was fine because the log had already said so
once.

## Consequences

- The two camera-native planes can be up to one refresh window plus one poll
  stale. That is bounded, and it is bounded against facts only an operator
  changes; the alternative on offer was `null` — genuinely unknown — on roughly
  one poll in ten, plus a 1.2s stall on all of them.
- `CameraSwitchService` and `CameraStatusService` must share ONE mirror instance.
  Two would drift the moment either refreshed, and D113 exists to stop those two
  surfaces disagreeing.
- Any FUTURE write path to `privacyMask.setMask` / `setAudioEnabled` that does not
  go through `CameraSwitchService` must invalidate the mirror itself. Today that
  class is the only such path on this server.
- Adding a ninth authority that leaves the server means adding it to the mirror,
  not to the fan-out.

Measured on the live hub, 29 cameras: `getCameraStatuses` **1251–1322ms → 120–466ms**,
and log volume under a worse fault than the original burst (the recorder fully
wedged, all 29 cameras degraded) **89 lines/min against 337**.

## Enforcement

`packages/addon-pipeline-orchestrator/src/__tests__/switch-authority-camera-probe.spec.ts`
pins all three halves against the real `readSwitchAuthorities`: a minute of 5s
polls dials the camera at most twice while `recording.getDeviceConfig` is still
read on all twelve; a warm read against a hanging camera returns in under 500ms
rather than spending the source bound; six polls of a failing camera leave at most
two lines, the first carrying `tags.deviceId`.
`privacy-plane-mirror.spec.ts` <!-- drift-ok: deleted with the mirror by D224 -->
pinned the D49 half — a refresh that answers nothing does not erase what was
known — and the write-invalidation.

No guard script. The shape is not mechanically detectable from a diff; review is
what catches a new fan-out to a device on a polled path.
