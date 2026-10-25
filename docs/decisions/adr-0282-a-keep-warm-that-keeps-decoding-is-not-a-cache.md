---
id: D282
title: A keep-warm that keeps decoding is not a cache — park cost must be measured against fork cost, not assumed
status: superseded
date: 2026-08-29
supersedes:
superseded-by: D453
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/index.ts
---

## Context

`DETECTION_KEEPWARM_MS` (15 s) holds a detached camera's detection decode worker
so the next motion event adopts it instead of re-forking. It was introduced
because an `on-motion` camera is detached one `motionCooldownMs` after every
motion event, so the phase-gate keep-warm had never once applied to the
population that actually pays the cold start.

The mechanism works exactly as designed. Measured on the live hub over 6 h
(823 attach/detach cycles across 20 cameras, from `attachCamera` /
`detachCamera` / `warm detection decode` log lines):

| gap from `detachCamera` to next `attachCamera` | share |
| --- | --- |
| ≤ 5 s | 35.6 % |
| ≤ 15 s (the window) | **50.1 %** |
| ≤ 60 s | 63.9 % |
| ≤ 300 s | 83.5 % |

Observed adoption was 402 / 823 = 48.8 %, matching the 50.1 % the distribution
predicts. The window is not mistuned: it sits on the median of a bimodal
distribution, and the hit rate is what the gaps allow.

What was never measured is the cost of a park. The premise was that a parked
worker is idle — "its frames go nowhere: the camera is unregistered, so
`reserveDetectionFrame` returns false and no pixels are ever materialized".
That is true of the PARENT and false of the CHILD. `decode-worker-child.ts`
drives `for await (const frame of decoder.frames(demuxer.packets(...)))`, which
is fed by the demuxer and gated by nothing; `minIntervalMs` throttles inside
`FrameSlot.publish`, i.e. **after** the H.264/H.265 decode has already happened.
`shouldMaterializeFrame` saves the parent's RGB `toBuffer` and nothing else.

Confirmed on live traffic rather than by reading: across 122 park windows with
two or more worker metrics samples fully inside them, `framesDecoded` advanced
in **122 of 122** — at 10 fps on device 3829 and 25 fps on device 3835, the full
source rate — and `deliveredFps` stayed at 5–8.4 in **121 of 121** samples whose
entire 10 s window lay inside a park. Zero parks stopped decoding. A parked
worker is a running worker; a decode-worker child measures 40–80 % of a core.

The arithmetic that follows is not close. Over 6 h, 420 parks expired unadopted
× 15 s = 6 300 worker-seconds of decode thrown away, plus ~1 850 useful ones —
≈ 0.19 of a core burned continuously to save 402 forks. For that to break even a
single cold fork would have to cost **10.2 core-seconds**. Measured
`forkToFrameMs` is 540–3 476 ms of *wall* time, most of it the idle wait for the
next IDR (`firstDecodeMs` 210–1 651 ms); the CPU in a fork is a node child boot
plus `demuxerOpenMs` 2–11 ms and `decoderCreateMs` 2–7 ms — well under one
core-second. The keep-warm is net-negative by roughly 25×, and the curve is
monotonically negative at **every** window length, including 2 s. The break-even
adoption rate at 15 s is above 100 %, so no camera and no tuning can rescue it:
device 112, the best in the fleet, adopts 69 %.

## Decision

A keep-warm may only park work that is CHEAP while parked. Parking a decode
worker that keeps demuxing and decoding at source frame rate is not caching a
result, it is paying for the result twice — once for the session that ended and
again for the one that may not arrive. Before a keep-warm window is added,
widened, or defended, the parked cost per second and the avoided cost per
adoption must both be measured, and the window justified against the *measured*
gap distribution. `DETECTION_KEEPWARM_MS` must not be raised; the earlier
instruction not to raise it still binds, now for a stronger reason than the
join-burst cold start it was originally about.

## Consequences

This record does not change the code. Making the park cheap is a worker-protocol
change (a `pause`/`resume` that stops the child's decode loop while parked) whose
cost is paid in detection latency: a resumed worker must wait for the next IDR,
which `firstDecodeMs` puts at 0.2–1.6 s on this fleet. That trades ~0.19 of a
core against added latency on ~50 % of motion events and is an operator's call,
not a refactor. The alternatives are: shorten the window towards 0 (cheapest,
regresses first-frame latency on the 50 % that currently adopt), or stop the
decode while parked (keeps the process and the RTSP connection, pays the IDR
wait). Doing nothing keeps a measured ~0.19 core burning on discarded frames and
keeps a parked worker's broker restream lease pulling packets through
`stream-broker`, which is the most saturated process on the host.

Whichever is chosen, the `WarmDetachedDecode` doc comment must stop claiming the
parked worker's frames "go nowhere" without saying that the decode still runs —
that sentence is why the cost was never questioned.

## Enforcement

Nothing automated, review only. The measurement is reproducible from Loki:
`framesDecoded` deltas from `session-decode metrics` lines bracketed by
`detachCamera` and `warm detection decode expired|reusing`, per `deviceId`. A
guard cannot express "the parked thing is cheap"; what it can express — and what
a future session should add if the park is made cheap — is a test that a parked
worker's `framesDecoded` does NOT advance.

## Superseded by D453 (2026-09-11)

The measurement in this record is the reason the keep-warm was removed rather
than tuned. It was re-verified on 2026-09-11 — the park path still sets nothing
the child decode loop reads, and 768 windows expired in three hours — and then
acted on: `DETECTION_KEEPWARM_MS` and `WarmDetachedDecode` no longer exist. D453
also removed ~150 ms and ~100 MB from the fork this park was avoiding, which
only widens the arithmetic here.
