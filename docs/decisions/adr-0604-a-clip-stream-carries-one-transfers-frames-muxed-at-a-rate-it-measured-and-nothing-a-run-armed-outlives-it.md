---
id: D604
title: A clip stream carries ONE transfer's frames, muxed at a rate it MEASURED — and nothing a run armed outlives the run
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-stream.ts
  - packages/addon-provider-reolink/src/clips/clip-stream-mux.ts
---

## Context

A 42 s clip on 3628 (a hub child of 639) failed for the operator and played on
the next try. Four lines, one `clipKey`
(`96f63f63f390f74bb85805ed7c06370fc7c77bb6`), read back from
`addons.getLogs` — three of them belong to ONE run, which is the whole story:

```
16:41:22.165  dial minted   ── and 16:41:22.171, a SECOND dial on the same clip
16:41:22.169  run A starts  (16:41:22.173: run B "queued behind another on this host")
16:41:22.294  A is muxing   fps 15, fpsSource timestamps, probe 16, probeAudioFrames 15
16:41:22.405  A was cut     peer-closed, accessUnits 55, bytesOut 1193
16:41:22.406  B starts      ── ONE MILLISECOND after A was cut
16:41:22.466  B is muxing   fps null, fpsSource UNMEASURED, probe 16, probeAudioFrames 15
16:41:24.758  B "came up short"  accessUnits 640, 38.52 s against a 42 s row, retried false
16:41:31.540  C landed whole     accessUnits 635, 42.21 s, fps 15, bytesOut 1 129 468
16:41:33.198  "a clip stream was cut"  mux-audio-stalled, accessUnits 640,
                                       bytesOut 1 169 577  ── B's OWN numbers, 8.4 s
                                       after B had already answered
```

**Two defects, and neither is the one the shape of the log suggests.**

### 1. B streamed the tail of A, and every number it reported is that

The library's replay listener cannot tell one transfer from the next.
`sendBinaryFileInfoListReplay5` pins `msgNum` to `0` for every cmd 5 replay
and, on a hub child, to the same header channel id; the listener locks
`streamMsgNum` / `lockedChannelId` / `lockedStreamType` on the FIRST frame it
sees and filters on nothing else. And a cut transfer is never stopped at the
camera — nothing on the wire aborts one, the producer's only lever is to throw
from the next chunk (D597) — so the frames still in flight for A were handed
to B, ahead of B's own first frame.

The arithmetic closes with no slack. Against C, the same file on the same
camera: B decoded **106 access units against 635**, **666 audio frames against
661** — the same five extra of each — and spanned **38.52 s against 42.21 s**,
short by **3.69 s**, which is exactly where A stopped (55 units at 15.04 fps =
3.66 s). B's probe therefore read five timestamps at ≈3.6 s and then eleven
from zero, a NEGATIVE span, and `estimateVideoTiming` answers anything but
`timestamps` only when the span is ≤ 0. So the probe failure, the five extra
units, the five extra audio frames and the `stream-short` verdict are one
cause. It is not a race, not a property of the first GOP, and not a reopen
"leaving state" anywhere in this repo: it is the camera still sending.

`stream-short` was a false alarm. The pass was complete; its duration was
measured across two transfers.

### 2. The stall never happened, and the rate omission is not neutral

`mux-audio-stalled` at 16:41:33.198 is run B's own gate, 10 s after it armed
at ≈16:41:23.2 and 8.4 s after B had answered `served`. Nothing disposed it.
Node emits no `drain` after `end()` — `afterWrite` guards the event with
`!state.ending` — so a gate armed on the last write can NEVER be disarmed, and
the flush grace (15 s) is longer than the drain window (10 s), so an armed
gate can also fire INSIDE the run, cutting a mux that is merely finishing.

Measured on real bytes, the production `buildClipStreamMuxArgs` spawned with
the production four-pipe `stdio`, fed a real camera elementary stream and real
ADTS in media order at 18× (`scratchpad/clips/clip-stream-pipe-repro.mjs`):
the audio pipe is armed at EOF on **every** run, with **zero** `drain` events
after `end()`. This is not the rare case; it is the ordinary one.

The same experiment REFUTES the two-pipe deadlock the omitted `-r` was
supposed to cause: with `-r` and without it, both pipes back up identically
(540/162 refused writes, same peak buffers) and ffmpeg exits 0 either way. The
omission costs something else entirely, and worse: **omitting `-r` is not "no
rate", it is ffmpeg's own default**, which is the elementary stream's nominal
number — the one D567 exists to refuse. On this fleet's own camera bytes the
same 42.1 s of audio came out against **63.0 s** of video without `-r` and
42.0 s with it.

## Decision

**A clip stream carries the frames of ONE transfer, is muxed at a rate it
measured itself, and nothing it armed outlives it.**

1. **A timestamp that goes BACKWARD is the previous transfer, not this one.**
   Before the mux exists, everything held is DROPPED and the probe starts
   again — nothing has reached the peer, so the residue simply is not part of
   this stream — and the drop is named (`stream-transfer-residue`) with the
   units and audio frames it cost. After the mux exists there is nothing to
   drop: the jump is named (`stream-timestamp-jump`) and this pass's duration
   becomes `null`, so it is judged `unknown` and never `short` (D393). A
   number measured across two transfers is not this recording's duration.

2. **The rate probe is a WINDOW, not a deadline, and an unmeasurable rate is
   REFUSED.** A window that cannot measure is widened to
   `CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS` (128, ≈8 s at 15 fps), and past
   it the stream is refused by name (`rate-unmeasured`) before a byte reaches
   the peer — the route still owns the status line, and the camera is not
   retried, because this is not a camera flake. `buildClipStreamMuxArgs` still
   omits `-r` for a `null` rate, because that is what the flag means; no
   producer passes one. D567 said the rate is measured, never assumed; this
   closes the door it left open, which was assuming it via ffmpeg.

3. **A gate dies with the hop it guards, and with its run.** The two mux input
   gates are disposed the moment their inputs are `end()`ed — an ended input
   is flushing, not stalling, and the flush timer already bounds that phase —
   and a run that has ANSWERED can no longer be severed at all
   (`ClipStreamRun.done`). A late sever would destroy a finished response and
   file a served stream as a defect, which is what the operator's log did.

## Consequences

- **`stream-short` keeps `retried: false`, and that stays right.** The bytes
  are at the peer and a second pass cannot replace them (D597). What changes
  is that the verdict is now computed over one transfer's timestamps, so the
  case that produced it here cannot recur; and the case where it fires with a
  cut is gone, because a served run can no longer be cut. Recovery, when a
  stream really is short, belongs to the consumer that can re-dial — it is not
  built, and nothing pretends it is.
- **Audio cannot deadlock the video, and never could.** ffmpeg reads the input
  whose next dts is lowest; while it reads one, the other's `write()` returns
  false and Node buffers in this process — bounded by the clip (≈350 KB of
  ADTS for 42 s), never blocking the producer. What the two pipes CAN do is
  starve each other's drain gate, which is why each hop has its own gate and
  why both must die at EOF.
- **A u32 timestamp wrap mid-clip reads as a residue drop or a named jump.**
  Before the mux it costs at most the held probe; after it, an unknown
  duration — where today it silently yields a negative span and a `null`
  duration anyway. The clips path has never been seen to wrap (the live
  `rfc4571` path has).
- **A camera that genuinely delivers no measurable rate loses its stream**
  rather than playing at the wrong speed with no way for anyone to tell. On
  this fleet every measured pass says `fpsSource: timestamps`; the refusal
  exists for the pass that cannot.
- Nothing was woken: 4263 was off limits, and 3628/640/3628/3629 were read
  only through logs already written.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/clip-stream.spec.ts` (27, +6).
Every gate reverted in turn, RED confirmed, restored byte-identical (sha256),
GREEN re-confirmed — **7 reverted, 7 red, 7 identical restores, 7 green**:

| reverted | red |
| --- | --- |
| keep the previous transfer's held units | 1 |
| never restart the probe on a backwards timestamp | 2 |
| measure the duration across two transfers | 1 |
| mux without `-r` instead of refusing | 2 |
| judge the probe at the first window, never widen | 1 |
| leave the mux inputs' gates armed after EOF | 1 |
| let a finished run still be cut | 1 |

**One line is NOT a gate and is recorded as such**: `disposeGates()` in the
run's `finally` is hygiene — it stops a stray timer existing after the answer
— and no test can distinguish it, because the EOF disposal and the `done`
guard already cover every path a test can build. Removing it alone leaves the
suite green, and it is not counted above. The first version of the
armed-at-EOF test was VACUOUS for the same reason and is recorded rather than
smoothed over: its fake `pipe:3` was a `PassThrough`, which moves the write to
its readable side and emits `drain` immediately, so no gate ever armed. It is
now a `Writable` that accepts the byte and never reports taking it — what a
real ffmpeg's fd 3 does — and the flush case is proved with a mux whose exit
is delayed past the drain window.

The two live measurements are review-only, in
`scratchpad/clips/clip-stream-pipe-repro.mjs`: the real four-pipe spawn with
and without `-r` (63.0 s of video against 42.1 s of audio, vs 42.0 s), and the
audio pipe armed at EOF with zero post-`end()` drains.

**Not fixed here, and it is the deeper hole**: the library accepts the
previous transfer's frames because nothing on the replay discriminates one
transfer from the next (`msgNum` is always 0) and because a cut transfer is
never stopped at the camera. Every guard in this record is downstream of that.
A library that carried a per-transfer discriminator, or a stop, would make the
residue impossible instead of recoverable.
