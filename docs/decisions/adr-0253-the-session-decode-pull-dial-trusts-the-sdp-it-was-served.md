---
id: D253
title: The session-decode pull dial trusts the SDP it was served, and never re-probes it
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-pipeline/src/session-decode/pull-demuxer-open.ts
  - packages/addon-pipeline/src/session-decode/decode-worker-child.ts
  - scripts/check-pull-demuxer-open.ts
---

## Context

A cold detection session cost **5.25 s at the median** from attach to first
decoded frame (p25 3.7 s, p90 19.5 s, n=2 501), and `forkToFrameMs` was 4 689 ms
of it. Nothing between the fork and the first frame was timed, so the number
could not be attributed to anything.

Two explanations were proposed before any measurement, and **both were wrong**:

- *"The decoder waits for the next IDR."* It is what
  `session-decode-coordinator.ts` says, with device 108 at an 8.0 s IDR interval
  and dials measured 1.8 → >40 s. Measured over 6 h on the live fleet:
  `withheld = 0` on **every** camera on the `restream prime (lat-probe)` line,
  and join-burst `spanMs` p50 of 160–1 733 ms against `PRIME_MAX_SPAN_MS = 2000`.
  No join is held back, so no session waits for an IDR. The burst span is the
  current GOP's age at join, uniform in `[0, IDR]`, so its median is `IDR/2`:
  the fleet's real IDR interval is **1.7–3.5 s** and 618 sits at ~1.9 s. The
  detection join-burst exemption already fixed this.
- *"Seed the session from the broker's prebuffer."* Already the case. The prime
  comes from the **current-GOP** ring (`rtpPreBufferSupplier`) — the same
  bootstrap WebRTC and every ordinary RTSP join get — available whenever the
  source is live, independent of the per-stream `preBuffer.enabled` toggle.

The measurement that settled it pairs, per camera, the broker's `restream prime
(lat-probe)` line (emitted when the burst is served, i.e. *after* the RTSP
session reached PLAY, i.e. after `avformat_open_input`) with the following
`session-decode: detection first frame`. **65–79 % of `forkToFrameMs` is spent
after the keyframe is already in the decoder's hands** (637: 7 859 ms of 10 807;
618: 4 216 of 5 325; 102: 3 080 of 4 773; 1441: 1 297 of 1 655). A manual trace
on 102 agrees: burst drained at 0.41 s, first decoded frame at 3.17 s.

Exactly three things live in that window: `avformat_find_stream_info`,
`Decoder.create`, the first decode. On an RTP input the container declares no
frame rate, so the probe drains the burst in milliseconds and then waits on
**live** packets to estimate one — and it is re-paid on every re-dial.

The probe is redundant on this URL specifically. The worker never dials a
camera: it dials the broker's **own** restream, which refuses PLAY until it
holds the parameter sets (`RtspRestreamer.isReady()`), and whose SDP is built by
`sdp-builder.ts`, which always emits `sprop-parameter-sets`. If
`avformat_open_input` succeeded there, libav has already parsed an SDP that
fully describes the video stream and populated `codecpar` from it.

## Decision

The session-decode pull dial opens its demuxer through one seam
(`openPullDemuxer`) which passes `skipStreamInfo: true` and derives geometry
from the SDP-supplied extradata via `parseExtradata()`. It re-opens **with** the
probe only when the opened input did not describe a video stream carrying
extradata, and says so when it does. `CAMSTACK_DECODE_PROBE_STREAM_INFO=1`
restores the unconditional probe inline.

Passing **parameters** is not passing a **stream**: libav still demuxes the RTP
itself. This is explicitly not the AnnexB seed push
(`StreamBroker.decoderSeedBuffer`), which hand-depacketizes a byte stream and
produced zero decodable frames on Reolink's 4K FU-A rfc4571 — the reason pull
mode exists at all.

## Consequences

The saving is not yet measured in production: this change was made in a
read-only session, so the ledger entry
(`docs/architecture/load-ledger.md`, 2026-08-28) is **open**, with the A/B
procedure written down. The env flag is what makes that A/B cost no second
deploy — `demuxerOpenMs` with the flag set minus without it *is* the probe's
cost, per camera.

It also means `demuxerOpenMs` has two readings that are not the same
measurement, so `streamInfoProbed` travels beside it on every line. A number
whose meaning depends on an invisible flag is worse than no number.

What now has to stay true: the detection worker must keep dialling the broker's
own restream. A URL whose SDP does not describe the codec falls back to the
probe rather than failing — a slow start is a latency regression, a wrong start
is a camera that detects nothing, and this path has shipped that failure before.

## Enforcement

`scripts/check-pull-demuxer-open.ts` (wired into `.github/workflows/ci.yml`):
`openPullDemuxer` is declared once, nothing under `session-decode/` calls
`Demuxer.open` directly except the adapter injected into the seam, and the
decode worker imports it. `pull-demuxer-open.spec.ts` asserts the probe **does
not run** — counted at the `skipStreamInfo` flag, never at the decoder's output,
because a decoder that starts anyway is precisely what would hide the defect.
