---
id: D568
title: A clip is FETCHED by cmd 5 and completion is a short idle window proved by the decoded duration — the replay stream is not a faster fetch
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-truncation.ts
  - packages/addon-provider-reolink/src/clips/clip-service.ts
---

## Context

[The clip-streaming note](../design/2026-09-20-clip-streaming.md) measured, on
592, a cmd 5 download at **2352 / 3048 / 2507 ms** for a sub clip and a replay
delivering **635 frames of a 42 s clip in 430 ms**, and called the replay "a
burst, not a 1× feed". Read as a fetch transport that is five times faster than
the one the file path uses, the honest move looked like swapping the transport
UNDER the file path — keep `+faststart`, the duration, seek, Range, download,
export and the cached copy, and just fetch the bytes over the replay.

Re-measured 2026-09-20 late evening against
`@apocaliss92/nodelink-js@0.7.10`, read-only, one session per device, on 107
(E1 Outdoor PoE, mains standalone) and on the Home Hub 639 (child ch 0):

**The premise holds — the replay IS the same file over another transport.** For
every clip, both transports handed back *byte-identical* content: the same
access-unit count, the same keyframe count, the same codec, the same AAC frame
count and the same audio byte count (592 sub: 501 AU / 9 KF / 530 audio frames
/ 275 070 B, both ways; 592 main: 751 AU / 16 KF / 477 audio frames; hub child:
331 AU / 12 KF / 344 audio frames). The replay is not a rendering of the clip,
it is a second way to fetch it.

**The 5× is an artefact of comparing two different completion rules.** Nothing
on the wire ends a cmd 5 transfer, so the library ends it on an idle window —
`DEFAULT_RECORDING_DOWNLOAD_IDLE_MS = 2 000`. **The replay has no end marker
either**: across nine replays, `close` never fired on its own; it fired only
when the caller called `stop` (once at +75 s). So the note compared the
replay's *transfer* against the download's *transfer plus two seconds of
waiting*. With the same 200 ms completion window on both sides:

| | cmd 5, idle 2 000 (today) | cmd 5, idle 200 | replay, last frame + 200 |
| --- | --- | --- | --- |
| 592 sub, 31–34 s, ~0.6 MB | 2 361 – 2 726 ms | **1 040 – 1 062 ms** | 530 – 670 ms |
| 592 main, 30 s, 20–24 MB | 6 373 – 7 195 ms | **2 829 – 3 571 ms** | 2 730 – 3 050 ms |
| 639 child sub, 22 s | 3 384 ms | **1 668 ms** | 1 200 (warm) – 1 550 (cold) ms |

`idleTimeoutMs` is already a parameter of `downloadRecordingDemuxed`, already
declared on this repo's narrow `ClipMediaApi`, and is not passed. Six
repetitions at 200 ms and two at 100 ms on a 20 MB main clip returned
**byte-identical** output every time (20 430 752 B in, 636 AU, 13 KF, 409 audio
packets). The library's own header measured the largest inter-chunk gap on a
101 s clip at 59 ms.

**And a truncated fetch is detectable after all.** The listed `sizeL` never
matches the received byte count (855 071/637 304; 815 675/596 464;
987 399/731 352) — that is what closed the cheap completion test in the note.
But the DECODED duration matches the catalog row's own window to about a
second on every clip measured (33.856 s for a 34 s row, 30.537 for 31, 21.951
for 22, 32.017 for 31). The row already knows how long the clip is.

**What the replay costs, per topology.** It opens a second TCP connection and
logs in on it — `resolveSocketTag` routes every `replay:*` key to a pool tag of
its own, with no override, confirmed in `lsof` (2 → 3 established sockets) on
both devices. On a hub child that is exactly what D549 17 forbids. And it does
not even win there: on 639 the replay lost to a 200 ms-idle download when its
socket was cold (1 550 vs 1 668 ms is inside the noise, and the FIRST replay of
a process cost **4 735 / 4 763 ms**, reproduced in two separate runs). "Warm"
means *within 10 s of the previous replay* — `SOCKET_POOL_KEEPALIVE_MS` — which
a clip fetch in a provider's real lifetime almost never is.

## Decision

**The clip file path fetches by cmd 5. The replay stream is not adopted as a
fetch transport on any topology.** Completion stays an idle window because
neither transport has an end marker, and that window is short (200–500 ms, not
2 000) and **proved, not assumed**: a pass whose decoded `durationSeconds` is
materially shorter than the catalog row's own `endMs − startMs` is a TRUNCATED
fetch, named and retried, never muxed into a clip an operator would take for
complete.

## Consequences

- The file keeps everything it buys — `+faststart`, a known duration, seek,
  Range, the download link, the export subsystem's input, and an LRU copy the
  second viewer gets free (D549 22).
- A sub clip lands in ~1.0 s instead of ~2.4 s and a 20 MB main clip in ~2.9 s
  instead of ~6.4 s, on every topology, with no new socket, no library change
  and nothing held open.
- **The replay stream stays unused in this repo**, including the four consumers
  built on it (`getRecordingVideoViaStreaming`, `createReplayHttpServer`,
  `createRfc4571TcpServerForReplay`, `createRecordingReplayMp4Stream`,
  `createRecordingReplayHlsSession`). The fast-preview mode proposed in § 8 of
  the design note is not built: after the completion rule is matched, it buys
  0.3–0.5 s on 592 and nothing on a hub, for a second socket D549 17 forbids.
- The one thing the file path still cannot do is show a frame before the fetch
  finishes (replay first keyframe 66–280 ms warm). That is a real gap and it is
  accepted: against a ~1 s sub fetch that then seeks instantly and forever, it
  is not worth a transport.
- If the replay is ever wanted for something else, two facts carry over: it has
  **no end-of-clip signal**, and its idle watchdog is **inert** — the replay's
  `BaichuanVideoStream` is constructed without an `api`, so `restartNativeStream`
  returns immediately. Measured: a finished replay held for 75 s delivered
  exactly one copy (431 AU), no gap, no restart. The design note's warning that
  the watchdog would re-request the clip does not hold for the code as written.

## Enforcement

The guard is the duration check itself, in the fetch path. Implemented
2026-09-20 in `clip-truncation.ts` (`CLIP_IDLE_WINDOW_MS = 300`,
`CLIP_IDLE_WINDOW_RETRY_MS = 2 000`, `CLIP_DURATION_SHORTFALL_TOLERANCE_S =
1.5`, `judgeClipDuration`) and wired in `clip-service.ts`'s `prepareClipOnce`:
one pass on the short window, and a shortfall past the tolerance is logged
`truncated-fetch` with `tags: { deviceId }` and its numbers, retried ONCE on
the long window, and — if it is still short — served but named
`truncated-after-retry`, which is how an operator tells a truncated fetch from
a short recording. The retry never serves less media than the pass it
replaces. `clip-fetch-completion.spec.ts` pins all of it.

**300 ms, one number on every topology.** Five times the largest inter-chunk
gap measured inside a live transfer (59 ms), which is the margin the hub-child
case argues for — its bytes ride the PARENT's socket, shared with every other
read on that hub. A second, longer constant for children was rejected: 200 ms
already returned byte-identical content on 639, so both sides of such a branch
would be guesses, and what makes a short window safe is the duration check,
not the window.

**1.5 s of tolerance, and only on a SHORTFALL.** The worst shortfall measured
is 0.463 s and the row's window is whole seconds, which can cost a second more
on its own; a relative tolerance was rejected because the shortfall did not
scale with clip length (0.049 s at 22 s, 0.144 s at 34 s). A decode LONGER
than the row is routine and never truncation.

Verified read-only on the live fleet the same evening, through the provider's
own `createClipService` (catalog → row → fetch → mux → LRU), alternating
passes on one session per device, the same clip, fresh data dir each pass:

| | before (no `idleTimeoutMs`) | after (300 ms) | content |
| --- | --- | --- | --- |
| 592 sub, 42 s row | 3 013 / 2 625 ms | **903 / 898 ms** | identical: 313 579 B, 11 KF, 15.000 fps, 43.254 s, 677 AAC / 351 363 B |
| 3628 (639 child ch 0), 16 s row | 2 964 / 2 804 ms | **1 068 / 1 115 ms** | identical: 444 955 B, 9 KF, 15.000 fps, 15.686 s, 247 AAC / 128 193 B |

Six further 592 clips fetched at 300 ms (26 s to 121 s rows) judged `complete`
with zero false positives; one row answered with **zero bytes at 300 ms AND at
2 000 ms**, on separate attempts, so that failure is not a window artefact —
it is the one `fetchClipBytes`'s landing gate already retries (D58).
