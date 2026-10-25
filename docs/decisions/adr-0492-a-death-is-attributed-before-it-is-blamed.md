---
id: D492
title: A death is ATTRIBUTED before a backend is blamed, and a child waits for its source
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/decode-failure-attribution.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/egress-source-readiness.ts
---

## Context

An Echo session on the Baby monitor froze after a second of video while the
audio — which rides the WebRTC Opus plane, not the MPEG-TS egress path — played
on untouched. Three separate defects were tangled in it, and each one hid the
next.

Measured on the hub over twelve hours on 2026-09-13, `-hwaccel vaapi` was
quarantined three times for the whole process, thirty minutes each:

| Time | ffmpeg said | Whose fault |
| --- | --- | --- |
| 16:33 | `Device creation failed: -12` … `Cannot allocate memory` (hevc) | the backend |
| 16:50 | the same | the backend |
| 17:48 | `Error opening input: Invalid data found` on `rtsp://127.0.0.1:8554/…` | **nobody's** |

The third is a RACE, not a verdict: the broker had logged `dial rate-limited —
deferring` and then `rfc4571: publisher materialized {materializeMs=5486}` —
the child had been spawned seconds before anything was serving that loopback.
It never reached a decoder at all, and it cost every other camera on the node
its hardware decode for half an hour.

The first two are real, and their cause is ALLOCATION, not throughput: with the
two `inference_pool.py` workers resident (718 MB + 529 MB RSS) holding
`/dev/dri/renderD128`, creating a VAAPI device for an HEVC decode returns
ENOMEM while `intel_gpu_top` shows Render/3D at 0 % and rc6 at 60 %. A busy GPU
and a GPU that will not hand out another device are different problems.

The freeze itself was a fourth thing: `-tune zerolatency` enables x264's
`sliced-threads`, so a frame leaves the encoder as five NAL slices sharing one
RTP timestamp with one marker bit. A libwebrtc depacketiser sees five
frame-starts per frame-end. The first attempt at a fix put
`-x264-params sliced-threads=0` into the profile's `outputArgs` — and
`EgressEncodeSchema` omits `outputArgs` on purpose (D67), so the flag never
reached ffmpeg and the live argv proved it.

## Decision

**A failure is attributed before a backend is blamed.** `isDecodeBackendFailure`
reads the child's own words: an input that could not be opened, a connection
refused, data that is not a stream — none of those are the decoder's, and none
of them may cost the backend its quarantine. An unattributable death still
blames the backend, because a silent GPU failure is the more expensive mistake.

**A child waits for its source, under a bound, and the wait is never a
refusal.** `waitForSourceMedia` holds the spawn until the source broker has
carried a packet (15 s, polled flat at 250 ms). A source that says nothing by
the deadline is spawned against anyway — a push broker awaiting its first frame
and a dead one look identical from here. A source nobody can answer for is
UNKNOWN, and the wait ends at once rather than spending the deadline on a
question with no answer (D393).

**A knob that crosses `EgressEncodeSchema` is a NAMED field.**
`singleSlicePerFrame` on `VideoEncodeSchema`, translated to
`-x264-params sliced-threads=0` for `libx264` only, and part of the sharing key.
Not `outputArgs`: an opaque array is hashed into the key, so two consumers
meaning the same thing spelled differently would stop sharing one child.

## Consequences

A backend that fails for a reason this file has not seen is still quarantined —
the default is to blame, and the list of exonerating patterns is the thing that
has to grow. The wait adds up to 15 s to a COLD acquire whose source is not yet
live; it adds nothing to a warm one, which is every ordinary case.
`singleSlicePerFrame` now separates two children that would previously have
shared one, which is correct and which does mean one more ffmpeg for a consumer
that asks for it while another does not.

Not decided here: whether the egress children can share ONE VAAPI device rather
than each creating its own. That is the remaining half of the ENOMEM, and it is
open.

## Enforcement

`decode-failure-attribution.spec.ts`, `egress-source-readiness.spec.ts`, and —
for the named field — `ffmpeg-sharing-key.spec.ts` (it separates two requests
differing only in it) plus `ffmpeg-invocation.spec.ts` (the flag reaches the
argv, after `-i`, and never for a hardware encoder). Removing the argv push
fails that last test; verified.
