---
id: D515
title: A HomeKit transcode hands the controller ONE slice per access unit, and a GOP measured at the rate it DELIVERS
status: accepted
date: 2026-09-16
supersedes:
applies-to:
  - packages/addon-export-hap/src/mappers/builders/stream-bitrate.ts
  - packages/addon-export-hap/src/mappers/builders/stream-ffmpeg-args.ts
  - packages/addon-export-hap/src/mappers/builders/__tests__/stream-bitrate.spec.ts
  - packages/addon-export-hap/src/mappers/builders/__tests__/stream-ffmpeg-argv.spec.ts
---

## Context

Operator, 2026-09-16: the one H.265 camera on the hub (112, 3840×2160, H.265
on every slot) shows an endless loader in the Home app; the three H.264
cameras are fine. H.264 is pass-through (`-c:v copy -bsf:v dump_extra`),
H.265 is a libx264 transcode — the fault line was the path, not the camera.
The controller's own receiver reports said 0 % loss, ~1 packet lost per
session, and a teardown by the controller at ~30 s: it received everything
and drew nothing. Two earlier failures with this exact symptom are already
recorded in `stream-bitrate.ts` (a 25 s GOP; parameter sets only in
extradata). This is the third of the family.

Two fixes shipped the same evening, on hypotheses, before anything was
captured: lowering the frame rate the budget cannot carry (`fpsForBudget`)
and honouring the H.264 profile the controller selected. The loader stayed.

What settled it was reading the bytes instead of the counters. The exact
argv the builder emits was run inside the hub's container against the same
restream, with a plain-RTP listener on the loopback port — the stream as it
exists one step before SRTP — and once more on a pass-through camera:

| capture | slices per access unit | markers / AU | IDR spacing | x264 |
| --- | --- | --- | --- | --- |
| transcode, as deployed | **11** (11 NAL type 5 per IDR, 11 type 1 per P) | 1 | 12 s | `VBV underflow` on the 2nd IDR |
| pass-through 101/high | **1** | 1 | 4 s | — |
| `sliced-threads=0` | 1 | 1 | 4 s | first packet ~3 s late |
| `sliced-threads=0 -threads 4` | 1 | 1 | 4 s | ~1 s late |
| `sliced-threads=0 -threads 1` | 1 | 1 | 4 s | no delay, no underflow |

`-tune zerolatency` turns on x264's sliced threads; on a 20-core host at
720p x264 caps that at 45 / 4 = 11 slices, so every access unit left the
encoder as eleven NAL units sharing one RTP timestamp and one marker bit.
The session summary had been saying so all along — `videoKeyframes=11
maxKeyframeGapMs=1` is one IDR — but the counter is named "keyframes" and
counts NAL units, so it read as a fast IDR cadence. The Echo had failed on
the same shape three days earlier (`ALEXA_EGRESS_PROFILE.singleSlicePerFrame`,
2026-09-13), and that record explicitly left HomeKit "a question for its own
evidence". This is that evidence.

The first of the two shipped fixes also introduced a regression: `-g` was
derived from the REQUESTED rate (30 fps × 4 s = 120) while `-r` had already
been lowered to 10, so the IDR came every 12 s (`maxKeyframeGapMs=12040`)
and x264 reported `VBV underflow (frame 121)` on the IDR that then had to
fit into a buffer the P-frames had already spent. The second shipped fix is
inert on the bitstream: x264 writes `profile_idc` from the features it uses,
and `ultrafast` disables CABAC, 8×8 DCT and B-frames, so the stream is
Constrained Baseline whatever `-profile:v` says (ffprobe on the capture:
`profile="Constrained Baseline"`, `level=40`). Harmless, but the
`export-hap: encoder profile` line now says something the bytes do not.

## Decision

A HomeKit transcode emits ONE slice per access unit — `singleSlicePerFrame`
on the plan, which the shared builder renders as `-x264-params
sliced-threads=0` — and pins ONE encoder thread (`-threads 1`, an output
option inside the video leg), because the flag alone hands x264 its auto
thread count as frame threads and frame threading delays output by
`threads − 1` frames. `-g` is derived from the frame rate the plan DELIVERS,
after the budget has lowered it, never from the rate that was requested. The
tune stays: it is the lookahead and the B-frames a live path wants gone.

## Consequences

- The encode is single-threaded. A 720p `ultrafast` encode is far inside one
  core; a session is bounded by what one controller asked for, never by the
  host's core count. If a future negotiated shape outgrows one core, the
  number to raise is `HAP_ENCODER_THREADS`, and the cost to re-measure is
  the start-up delay, not the slice count.
- The 421-vs-299 record holds untouched: the bitrate, `-maxrate` and the
  one-second VBV window are exactly what they were. Fewer slices cost fewer
  bits (eleven slice headers and no prediction across slice boundaries),
  which is why the underflow disappeared without raising the ceiling.
- `videoKeyframes` still counts NAL units. With one slice per access unit it
  now equals the IDR count again, which is what every reading of it assumed.
- NOT verified here: that the Home app draws the picture. Every byte the
  controller receives is now the shape the pass-through cameras send and
  those work; the operator's next session on 587 is the proof, read from
  `videoKeyframes` (one per IDR), `maxKeyframeGapMs` (~4000) and the
  session's duration not clustering at the controller's 30 s give-up.

## Enforcement

`stream-bitrate.spec.ts` ("one slice per access unit, and a GOP measured at
the rate we deliver") asserts `-x264-params sliced-threads=0` and `-g 40` for
the 720p30-into-269 kbps case; `stream-ffmpeg-argv.spec.ts` asserts
`-threads 1` and `-x264-params` by POSITION inside the video leg on the
encode branch and their absence on the copy branch, and the flag-by-flag
vector carries both. The earlier `-g` test that asserted 100 frames for a
budget that delivers 10 fps was the regression written down as a test; it
now uses a budget that carries 25 fps.
