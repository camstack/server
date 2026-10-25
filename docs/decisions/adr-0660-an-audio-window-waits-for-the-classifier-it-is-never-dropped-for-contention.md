---
id: D660
title: An audio window WAITS for the one classifier — it is never dropped because another camera got there first, and a window nobody classified says so
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/audio-analyzer/audio-classify-queue.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-subprocess-channel.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-pipeline.ts
  - packages/addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-device-attachments.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-window-accumulator.ts
  - packages/addon-post-analysis/src/pipeline-analytics/audio-classify-outcome.ts
  - packages/addon-post-analysis/src/notification-center/audio-rule-matcher.ts
---

## Context

One inference subprocess serves every camera a node analyses: YAMNet
(`yamnet_audio.py`) on Linux, the Apple SoundAnalysis CLI on macOS. Both
backends are single-channel — each holds ONE `pendingResolve` slot, so two
overlapping `classify()` calls clobber each other. The analyzer serialised them
with a global `pipelineBusy` flag, plus a per-camera in-flight flag and a 500 ms
minimum interval, and every window that met any of the three was answered
`{ labels: [], inferenceMs: 0 }` and forwarded.

Windows (1024 ms, 16 kHz f32) arrive from per-camera pollers (200–500 ms) in
BURSTS, so on the hub (~23 cameras) one camera won each burst and the rest were
thrown away. Measured live 2026-09-27: 1–10% of windows labelled on every camera
(living room: 177 loud windows/h, 18 labelled), the YAMNet process at 7.5% CPU —
starved, not overloaded — and a label-mode crying + scream rule that never
fired. Downstream the discarded window was stored and forwarded exactly like a
window that was classified and heard nothing above the floor (`classification`
absent), so nothing could tell silence from "nobody listened" (D393), and no
line said a window had been dropped (D391).

## Decision

Every window goes through ONE queue in the analyzer, above the backend, so the
rule holds for YAMNet and Apple SoundAnalysis alike (`AudioClassifyQueue`):
exactly one inference at a time; per camera at most ONE window waits, and a
newer window from the same camera SUPERSEDES it and inherits its place in line —
the only contention drop; cameras are served in arrival order. There is no
per-camera minimum interval: with a FIFO a camera re-queues behind everyone
already waiting, which is the fairness the 500 ms interval approximated; a
window is ~1 s of audio, so a camera cannot sustain more than ~1/s, and the
interval only ever bit on a poll batch that flushed two windows together — the
burst it then discarded. The poller does NOT await the classifier (it must stay
at the live edge for supersession to mean anything); results are emitted in
window order.

Every analysed window carries `classifyOutcome`: `classified`, or
`not-classified` with a reason (`superseded` | `error` | `timeout` | `disposed`). It rides
the `AudioResult` frame (optional there only for pre-D660 frames — absent means
unknown), the NC audio sample, and the stored level-path audio row
(`AudioEvent.classifyOutcome`, optional, additive JSON field: old rows keep
their shape and read as unknown). Labelled rows are stamped `classified`.

Drops are reported, never per window: one `audio classify accounting` line per
camera per minute, only for a camera that lost a window, with `tags: { deviceId }`
and the classified / superseded / errors / disposed counts. The cap's
`classify` method throws on a window that never ran rather than returning an
empty result.

Near-miss: when YAMNet reports `crying` or `scream` (macro) BELOW the camera's
`minConfidence`, one `audio near-miss below floor` line per camera per minute
(label, score, floor, suppressed count). The list is FIXED: knowing which labels
the Notification Center's rules actually watch would need a cross-addon read or
a new transport from the analyzer, and a diagnostic line is not worth either.
YAMNet only reports a raw label at ≥ 0.05, so any appearance is a real signal.

The one running inference ALWAYS ends. Both backends now share
`AudioSubprocessChannel`, which rejects a waiting request on ANY exit — the old
copies rejected only on a non-zero exit CODE, and a signal exit (`code null`:
dispose's SIGTERM, the memory watchdog, an engine swap, an OOM-kill) left the
request, and therefore the whole queue, waiting forever — and on `dispose()`
before the kill. A reply carrying `error` (YAMNet answers a Python exception
that way) is a failed inference, not an empty one. Every inference is bounded
at 5 s (a hub YAMNet window takes ~33 ms: 7.5% of one core at ~2.3 windows/s,
ONNX on one thread; 5 s is ~150× that, and every camera waits behind it); a
timeout is logged with `tags: { deviceId }`, the backend is killed and the next
window respawns it lazily, and the window is `not-classified/timeout`. A
backend that exited is dropped the same way. Per camera at most 16 windows may
await their result in the attachment (a healthy camera holds ~1–6 under those
bounds); past it windows are dropped, counted, and reported once a minute.

Rejected: raising the busy gate into a per-camera lock only — the
backends are single-slot, a per-camera lock lets two cameras overlap; an
unbounded FIFO — a stalled model would grow it without bound; keeping the
poller awaiting the classifier — the camera falls behind the live edge and the
broker FIFO takes the drop instead, silently.

The dead `audio-analyzer/audio-analyzer-provider.ts` (no importer; it built its
own pipeline and called `classify` with no gate) was deleted.

## Consequences

**Label rules will fire MORE often.** `NC_AUDIO_CONFIRM_HITS_DEFAULT = 2` in
`NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT = 5` s was tuned while 90–99% of windows
were discarded ("YAMNet labels only one to three frames per episode"). At ~1
classified window per second per camera, a ~2 s false positive now reaches two
hits: expect more label notifications, possibly the old single-sound "Pianti"
false positive back, and denser audio episodes/markers in pipeline-analytics.
The remedy is per rule (`confirmHits`) or per camera (the floor), not a new
default made on a starved stream.

Level frames (dBFS meter, markers, NC level windows) are now emitted after
their window is classified or superseded — ~1–2 s later than before on a busy
node. Stored timestamps are the window's own, so data is unchanged; only live
freshness lags.

Under sustained overload (inference slower than cameras × 1 window/s) each
camera still gets classified about once per round of the queue, and the rest of
its windows are counted as superseded — visible, per camera, once a minute.
Classification latency is now bounded by the camera count × inference time
instead of being zero-or-dropped. A window can be emitted after the camera was
detached (it was already queued). Anything that reads audio rows or frames and
wants "was this heard?" must read `classifyOutcome`, not the absence of labels.
`@camstack/types` changed (new schema, required field on
`AudioAnalysisResult`), so it must be published with the addons.

## Enforcement

Tests, each disarmed once: `classify-fair-queue.spec.ts` (burst from N cameras
all classified in arrival order; supersession of the older pending window only,
counted and reported; overlap-detecting single-slot fake for both backend
names; error → not-classified; near-miss rate limit),
`audio-device-attachments.spec.ts` (poller keeps draining, results in window
order), `audio-result-event.spec.ts` and `audio-classify-outcome.spec.ts`
(propagation to the frame, the NC sample and the stored row). No guard stops a
new early-return in `analyseChunk` — review only.
