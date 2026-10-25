---
id: D263
title: The join-burst bound is a property of the CONSUMER, not of the stream
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/rtsp/join-burst-admission.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts
---

## Context

[D57](./adr-0057.md) bounds the RTSP join burst at `PRIME_MAX_SPAN_MS` (2 000 ms
by default) and, over that bound, withholds it **whole** — a window cut from the
ring no longer starts at a keyframe, so half a burst is not decodable. The
withheld session then joins at the camera's next IDR.

The bound was written as a number **per camera stream** because at the time
every RTSP consumer re-emitted what it received. It exists for that shape of
consumer only: an ffmpeg copy of the restream feeding a HomeKit leg has ~zero
decode headroom, never drains a backlog, and forwards the burst's compression to
its peer as jitter — measured, a 2 996 ms burst became 3 030 ms of
controller-visible jitter. WebRTC was already exempt, structurally rather than
by a flag: its bootstrap reads `StreamBroker.getRtpPreBuffer()` directly and
never traverses this decision.

`join-burst-bound.ts` already stated the consequence without drawing it: the
burst's span at join is the time since the last IDR, **uniform in `[0, IDR]`**,
so "a camera with a 4 s GOP is withheld on roughly half its joins".

The fleet runs 100-frame GOPs at 25 fps — a **4 000 ms** IDR interval. Measured
over 6 h of live logs, `detectionIntentServed` over detection dials:

| served fraction | cameras | `forkToFrameMs` p50 |
| --- | --- | --- |
| ~100 % (1441, 3836, 592) | 3 | **1 487 / 1 655 / 1 946 ms** |
| 44-61 % | 11 | 4 531 – 5 369 ms |
| 30 % (637) | 1 | **10 807 ms** |

The three cameras never withheld are the three fastest in the fleet, and the one
withheld most is the slowest. Two independent readings put the IDR interval at
4 000 ms and refute the "8.0 s" that `session-decode-coordinator.ts` had claimed
for device 108 (corrected in place; 108 measures 51 % served, the fleet norm).

Two fixes were proposed and rejected before this one. **Raising
`joinBurstMaxSpanMs`** is the same number applied to every consumer and re-opens
the HomeKit failure D57 exists to prevent. **`preRollMs`** hands the session
history from *before* the motion edge, which adds real analysis latency — a
subject seen at t−4 s reported now — and the requirement is that detection is
LIVE.

## Decision

Admission to the join burst is decided by one pure function of the joining
consumer (`admitJoinBurst`), not by the stream's bound alone. A session that
declared the **detection** intent on its dial path is exempt from the SPAN
bound — it drains the burst rather than re-emitting it, so there is no peer to
jitter, and it fast-forwards to the live edge and begins emitting at NOW. It is
**not** exempt from `maxPackets`: that ceiling is a defensive backstop against
RTP timestamps that stopped describing the stream, and in exactly those cases
`spanMs` is meaningless. Every other consumer keeps D57 unchanged. No new
setting, and no new way to declare a consumer — the `/muted-detection` dial-path
suffix already carried the bit.

## Consequences

The saving is **not yet measured**: this was decided in a read-only session, so
the load-ledger entry (`docs/architecture/load-ledger.md`, 2026-08-28) is open
and carries the after-measurement procedure — `detectionIntentServed` over
detection dials must go from ~0.5 to ~1.0, `primeWithheldSpanMs` on the
unconditional `restream dropped packets` warn must go to 0, and `boundSpanMs`
for non-detection consumers must stay 2 000.

`preRollMs` is untouched and stays 0. It answers a different question (analysing
the seconds before the trigger) and must not be reached for to fix a cold start.

Camera 637 is a genuine long-GOP outlier (~6.7 s inferred) and is now the only
camera where the packet ceiling, not the span bound, could bind. Watch it.

## Enforcement

`join-burst-admission.spec.ts` pins each population's decision in isolation, and
`rtsp-detection-intent-prime.spec.ts` proves it end to end on a real
`RtspRestreamer`: over a 3 000 ms burst on a 4 000 ms-GOP stream a detection
session receives **≥2** RTP frames while a recording leg and a HomeKit-style
muted leg on the *same stream* receive **0**. Disarming the exemption drops the
detection session to 0 frames; disarming the packet ceiling turns the
over-packet case from `'packets'` to `'none'`. Both were confirmed red.
