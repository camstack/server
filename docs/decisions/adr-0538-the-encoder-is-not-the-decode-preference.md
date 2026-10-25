---
id: D538
title: The encoder is decided separately from the decode preference, and a software transcode names its reason
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/ffmpeg-invocation.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/transcode-pipeline.ts
  - packages/types/src/ffmpeg/invocation.ts
---

## Context

`pickVideoEncoder` treated the node's decode preference as the whole answer:
`hwAccel: 'copy'` meant software everything. But `copy` is this fleet's decode
DEFAULT for a specific, defensible reason — forcing a hardware decode
hard-fails on a fragile HEVC source — and it was quietly deciding the ENCODER
too. On a hub with a working Intel iGPU, every egress and derived transcode ran
`libx264`, spending cores a media system does not have to spare, while the GPU
idled. Nothing said so: there was no line anywhere naming a software transcode.

The second half of the same failure was the binary. The bundled ffmpeg carried
no VAAPI at all, so even asking produced `Device creation failed: -12` — a
build property that reads as a resource shortage (D536), quarantined by
`dead-decode-backends` as though it might recover, forever, on a hub where it
could never succeed.

## Decision

The encoder is chosen from what the NODE has and what THIS BINARY can do,
independently of the decode preference: a software decode may feed a hardware
encoder, and ffmpeg's `hwupload` is exactly that. Only an explicit `none`
forces a software encoder. Every software encode names its reason —
`operator-forced-software`, `no-hardware-on-node`, `binary-lacks-encoder` — in
an ERROR line carrying `deviceId`, because on this fleet a software transcode
is a defect and not a fallback. A decode backend the binary does not carry is
refused before the child is built, rather than requested and mourned.

An UNKNOWN capability list is not a "no": a probe that failed means we could
not ask, and the hardware is still attempted, so one bad probe cannot pin a
capable node in software.

## Consequences

- VAAPI encoding needs three things together — `-vaapi_device`, an upload at
  the END of the filter chain, and the encoder — so `FfmpegInvocation` grows
  one field (`hwEncodeDevice`) and emits all three or none. A hardware encode
  fed by a filter GRAPH is refused: the upload has to be the graph's last node,
  and appending a `-vf` to an output a graph already feeds is an ffmpeg error.
- The gain is real only where the binary is capable. On a node still running
  the portable static build, every transcode now says `binary-lacks-encoder`
  once per start — which is the point: the cost stops being invisible.
- `dead-decode-backends` keeps its escalating quarantine, but only for the
  failure it is actually right for: a device that exists in the build and still
  refuses.

## Enforcement

`choose-video-encoder.spec.ts` pins the separation and all three named reasons;
`ffmpeg-vaapi-encode.spec.ts` pins the argv (device before the input, upload
last, nothing at all for a software encoder, refusal with a graph).
