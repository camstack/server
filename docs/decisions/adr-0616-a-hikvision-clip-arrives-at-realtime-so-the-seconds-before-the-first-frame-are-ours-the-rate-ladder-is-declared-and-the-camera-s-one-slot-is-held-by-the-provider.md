---
id: D616
title: A Hikvision clip ARRIVES at realtime — so the seconds before the first frame are ours to give back, the rate ladder is declared rather than promised, the camera's one replay slot is held by the provider, and a still is cut from the copy we already fetched
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/addon-provider-hikvision/src/clips/clip-file.ts
  - packages/addon-provider-hikvision/src/clips/clip-stream-mux.ts
  - packages/addon-provider-hikvision/src/clips/clip-replay-rate.ts
  - packages/addon-provider-hikvision/src/clips/replay-lane.ts
  - packages/addon-provider-hikvision/src/clips/clip-still.ts
  - packages/addon-provider-hikvision/src/clips/clip-still-refusal.ts
  - packages/addon-provider-hikvision/src/clips/rtsp/rtsp-replay-session.ts
  - packages/types/src/capabilities/videoclips.cap.ts
---

## Context

The operator tested Hikvision clips on the live fleet (camera 1436) and filed
four complaints: *"ci mette parecchi secondi a partire una clip"* [a clip takes several seconds to start], *"non
generiamo gli snapshots"* [we do not generate the snapshots], *"ho provato a fare seek … e' morto tutto"* [I tried to seek … everything died],
*"l'accelerazione sulla clip pare non funzionare?"* [the speed-up on the clip seems not to work?]. Every one of them turned
out to have the same fact underneath it, and that fact had never been measured.

**A Hikvision RTSP replay is not a fetch. It delivers the recording at the
speed it was recorded.** Measured on 1436, 2026-09-23:

| what | measurement |
| --- | --- |
| replay delivery | 176 access units in 14 274 ms at 12.5 fps = 14.08 s of media in 14.27 s of wall clock — **1.01×** |
| whole-clip file fetch, cold | **22.3 s** for an 18 s clip (18 s of replay + the 3 s quiet window + the mux) |
| whole-clip file fetch, warm | 48 ms — the operator's 0.86 s reference was a warm read |
| Reolink, for contrast (D612) | 49–62× realtime; the whole clip is in hand inside a second |

Everything D597/D604/D612 assumed about a clip stream was written against that
Reolink number. Reached from this wire, the same code does four different
things.

### 1 — Where the seconds go

The broker's stream path, measured end to end from the hub log against
T0 = 09:39:40.079:

| leg | cost | whose |
| --- | --- | --- |
| RTSP `DESCRIBE`/`SETUP`×2/`PLAY` | **222 ms** | the camera's, and it is excellent |
| the rate probe: 16 access units HELD before ffmpeg is spawned | **1 301 ms** | ours — 16 frames at 12.5 fps IS 1.28 s when they arrive at 1× |
| ffmpeg spawn → first byte at the peer | **2 793 ms** | ours |
| **time to first frame** | **4 316 ms** | |

The last leg decomposes against the real clip (18 s, 4K HEVC, 12.5 fps,
GOP 50 — keyframes at 0, 2.32, 6.32, 10.32 …), fed to ffmpeg at 1×:

- `-analyzeduration` 5 s / `-probesize` 5 MB are ffmpeg's defaults and they are
  paid in wall clock here. The init segment reached the peer at **3 889 ms**.
- `frag_keyframe` alone closes the first fragment at the NEXT keyframe, so the
  first picture spans a whole GOP.
- ffmpeg's AVIO buffer holds the 942-byte init segment until 32 KiB has piled
  up behind it, so the peer saw nothing at all — not even `ftyp` — until the
  first fragment closed.

With `-analyzeduration 0 -probesize 32768`: init at **171 ms**, first fragment
at 2 269 ms. Adding `-frag_duration 500000 -flush_packets 1`: first fragment at
**219 ms**, and the whole 18 s output grew by 4 044 bytes (0.04 %).

The 16-unit probe is the other second, and it is buying nothing. The spans on
this camera are exactly 7 200 ticks of a 90 kHz clock, every one of them, and
`estimateReplayFps` computes `(n−1)·rate ÷ (last − first)` — which for equal
spans is `rate ÷ span` for EVERY n. The sixteenth unit produces the same number
as the fourth.

### 2 — The stills

`toClip` said `thumbnailUnavailable: { reason: 'unsupported' }`. That was true
of the camera's ISAPI — its only picture endpoint is
`Streaming/channels/<id>/picture`, which is the LIVE view, a picture of now for
a clip from yesterday — and false of this provider, which already holds the
recording: `prepareClipFile` muxes a `+faststart` MP4 into the scratch for the
player's URL, the export and the byte offer, and D605 § 7 / D558 make that ONE
fetch serve every ask. A still is the cheapest ask of them all: `ffmpeg -ss` on
that file cut a 640×360 JPEG of 27 633 bytes in 1.8 s of cold decode, touching
no camera.

### 3 — The seek that killed everything

The evidence:

```
09:24:45  a clip stream was cut { branch: "peer-closed",  elapsedMs: 10145 }
09:25:00  a clip stream was cut { branch: "peer-stalled", elapsedMs: 14510 }
09:25:07  a replay session could not be opened
          { branch: "camera-refused",
            reason: "SETUP of the video track answered 500" }
```

D605 already knew this firmware serves ONE playback session and that a session
nobody tore down blocks every later one for the camera's own 60 s timeout. Two
things were nevertheless true in the code:

- **`socket.destroy()` discards whatever `write()` queued.** `close()` wrote
  `TEARDOWN` and destroyed the socket in the next statement.
- **The ordinary end of a segment never wrote one at all.** A Hikvision replay
  goes quiet with the socket open, so `finish({ kind: 'complete' })` — the
  commonest exit there is, and the one every file fetch takes — walked away
  holding the slot.

And nothing serialised the two callers. The stream route and the file fetch
each opened a replay whenever asked, so a viewer moving from clip A to clip B
dialled B while A was still holding the camera. The 500 that came back says
nothing about the clip, and the surface read it as "this clip is broken" — the
exact disease D611/D315 name: a fact the provider owns, learned from a wire.

### 4 — The acceleration

There is no per-transport rate declaration. `CLIP_PLAYBACK_OPTIONS.stream`
offers `[0.25, 0.5, 1, 1.5, 2, 4]`, a ladder D612 measured against Reolink's
49–62× arrival. The broker's pacer consumes `rate` seconds of media per second
of wall clock while this socket supplies one, so 2× and 4× drain a buffer that
never held the rest of the clip. The picture stops; ten seconds later the
provider's drain gate reports `peer-stalled`, which names the wrong end of the
pipe. Nothing anywhere said "the pacer ran out".

### 5 — What the first cut of rule 4 got wrong, measured in production

Rule 4 below originally let a still PAY for the recording when it was not
held, kept subordinate by a yield protocol. That was wrong, and it was wrong
within minutes of shipping (`provider-hikvision` 1.2.126). The operator: *"le
clip di hikvision non partono piu', stiamo bombardando la camera per uno
snapshot e non c'e' una coda?"* [the Hikvision clips no longer start, are we bombarding the camera for a snapshot and is there no queue?]

The arithmetic he could see and the design could not. `listClips` over 24 h on
1436 answers **20 rows**; the viewer draws them and asks for the thumbnails of
the ones on screen. Measured on the live camera the same hour, those 20 clips
span **898 seconds** — 29, 124, 100, 150, 89, 32, 40, 49, 18, 22, 19, 12, 6,
44, 44, 18, 18, 20, 22, 42 s — and at 1.01× arrival that is **fifteen minutes
of the camera's one playback session** to fill one screen. Eleven of them were
not held. A file fetch of a 14 MB clip measured **32.7 s with the lane
otherwise idle**.

Two things were wrong, and the second is the general lesson:

- **"No prefetch pass" was true and irrelevant.** The prefetch arrived from the
  other side: a viewer asking for the tiles it can see IS a prefetch, and a
  provider that treats each tile's GET as an individual operator request has
  simply moved the budget somewhere it cannot see it.
- **The yield protocol solved the wrong problem.** It let one competing ask
  evict one speculative holder. It did nothing about eleven mints that each
  re-take the slot the moment the previous one lets go. **A lane that
  serialises speculative work behind a user's tap is worse than one that
  refuses the speculative work** — the operator gets minutes of nothing instead
  of a fast, honest refusal, and the lane is what makes it look like a hang.

### 6 — The latency work shipped a clip that would not play, and the cause was none of the obvious ones

1.2.129 reached the fleet and the operator could not play a clip on 1436 at
all. One session, the decisive numbers: **129 access units into the mux, 1 298
bytes out** — ten bytes per frame of 4K HEVC — `pushed: 0` on the broker, and a
player that gave up after 10.6 s. The camera side was healthy throughout (130
video units, 256 audio packets, `droppedPayloads: 0`, `teardown: "sent"`) and
every leg of the latency work was visibly working (`probeUnits: 4`,
`sinceDialMs: 696`). What it produced was a header and no media.

**Three suspects were tested against the live camera and all three were
wrong.** `CLIP_MUX_PROBE_BYTES` at 32 KiB against a **550 354-byte** first
access unit looked damning, and is not the cause: every probe size from 32 KiB
to 768 KiB reproduced the fault identically, and removing the flags altogether
reproduced it too. `-frag_duration` was not the cause. The pinned jellyfin
8.1.2 build, new to this addon since D616 wired `ensureFfmpeg`, was not the
cause. And ffmpeg's stderr said **nothing at all** — it was not failing, it was
waiting.

**The cause is the muxer's interleaving window, and the distinguishing variable
is SOUND.** Measured through the real producer, real camera, pinned build, over
a six-second clip:

| ask | delivered to the peer by the clip's halfway point |
| --- | --- |
| `none` | 1 299 KiB |
| `opus` | **1 KiB** — the init segment |
| `pcmu` | **1 KiB** |

With audio, nothing moved until the inputs ENDED, when all 3.78 MB arrived in
one burst. It is not a rate mismatch: the two timelines measured 4.80 s of
video against 4.80 s of µ-law, a ratio of 1.000. ffmpeg was buffering to
interleave video on stdin against µ-law on `pipe:3`, and for a live fragmented
stream any window at all is wrong.

**And none of this was visible.** A mux that takes frames and emits only a
header is the branch D391 names, and the provider had no line for it — the
only evidence anywhere was a broker counter and a peer giving up.

### 7 — The clip started, and then stopped after 880 ms

The mux fix reached the fleet and the operator saw a clip begin — and stall a
second later. Captured live on 1436:

```
15:18:20.031  clip-stream:first-frame  { sinceDialMs: 1280, ptsMs: 0 }
15:18:20.514  clip-stream:starved      { rate: 1, headMs: 480, arrivedMs: 480, pushed: 7 }
15:18:20.973  clip-stream:disposed     { pushed: 12, queued: 2, headMs: 880 }
15:18:21.001  replayed source-RTP pre-buffer (instant start)   ← back to LIVE
```

**`headMs === arrivedMs`, exactly.** The pacer had consumed precisely
everything that existed. A pacer at rate 1 against a source that arrives at 1×
is two clocks of the same speed with nothing between them: the queue never
builds, so the first jitter empties it. This was only reachable because the
earlier work made clips play at all — before it, nothing played, so nothing
could starve.

**Who ended it: the viewer, not us.** `peer-closed` on the provider names the
branch, not the cause. The order is unambiguous — `clip-stream:disposed` at
.973, the viewer's live fallback at 15:18:21.001 — and the only paths that
dispose a clip feeder are `goLive`, `leaveClip` and `enterRecorded`. The viewer
judged the clip dead and went live; `goLive` disposed the feeder; the feeder's
teardown destroyed the dial; the provider reported the socket it lost.

**The cushion, derived end to end** through the real producer and the broker's
OWN demuxer, four runs against the real camera: media arrives at **1.017×**, in
lumps of **160 ms (p50) to 320 ms (max)**, and the worst deficit against a
zero-cushion pacer is **189 / 193 / 194 / 196 ms**, always at the same point in
the clip. Replaying that curve through the pacer at each candidate cushion:
**0 ms → 70 starves**, 200 ms → 0 but with 4 ms left, 600 ms → 0 with 404 ms
left.

## Decision

**A transport that arrives at REALTIME is a different transport, and every
place that assumed otherwise says so.** Four rules, one per complaint.

1. **Nothing is held or probed for information the caller already stated.** The
   mux is told `-analyzeduration 0 -probesize 32768` on EVERY input (an input
   option applies only to the input that follows it, so the µ-law pipe needs
   its own or it holds the video hostage), the stream form adds
   `-frag_duration 500000` and `-flush_packets 1`, and the rate probe STOPS as
   soon as three consecutive inter-unit spans are identical
   (`replayFpsIsExact`). That last one is arithmetic, not a confidence
   threshold: equal spans give the same estimate for every n, so stopping early
   cannot change the answer, and a clock that varies by one tick falls through
   to the full 16-unit window unchanged. Measured time to first frame:
   **4 316 ms → ~750 ms**, of which 222 ms is the camera's.

2. **A rate the transport cannot deliver is never offered.**
   `CLIP_REALTIME_SOURCE_RATES = [0.25, 0.5, 1]` and
   `CLIP_PLAYBACK_OPTIONS.realtimeStream` is the third envelope; the Hikvision
   provider returns it. Below 1 is free — a slower pacer only lets the buffer
   grow. This is D612's own rule reaching the case it did not yet have, and the
   answer is the DECLARATION, never a pacer that promises and stalls. **And the
   pacer that runs dry now says so**: `clip-stream:starved`, once per run, with
   the rate and the head, because a branch that accepts work and produces
   nothing is the branch D391 names.

3. **The camera's one replay slot is HELD BY THE PROVIDER, and given back.**
   `TEARDOWN` goes out on every exit that has a session to tear down — not only
   on an explicit `close()` — and the socket is `end()`ed with a bounded flush
   rather than destroyed out from under it. `RtspReplaySession.close()` now
   resolves when the SOCKET IS GONE, because "the run returned" is a different
   fact from "the slot is free", and every caller holds its lease until then.
   `replay-lane.ts` serialises the stream, the file fetch and the still per
   deviceId: a second ask waits only as long as a slot that is BEING released
   would take (the teardown flush plus a margin) and is then refused BY NAME —
   `replay-busy`, 503, with the holder and the wait — with the surface still
   alive. It is never queued behind a replay that is still playing, because at
   1× that is the whole length of somebody else's clip.

4. **A still is cut from the copy we already fetched, at the clip's
   MIDPOINT — and it NEVER spends the camera's playback session.** That slot is
   one slot and playback is what earns it. `mintStill`'s gate is a `stat`:
   bytes already in the scratch are cut (`ffmpeg -ss <mid> -i <scratch>
   -frames:v 1 -f mjpeg`, one frame, no network), and a clip whose bytes are
   not held is refused **`media-not-held` / final** — nothing below that gate
   may reach the camera. The midpoint because the first frame of a motion
   segment is the moment BEFORE the subject arrived; `-ss` before `-i`, so it
   is an index seek rather than a decode of everything up to it. A seek that
   lands past the end, or a file that will not decode, is a named 204 and never
   a black frame (D315).

   **The one thing that puts a thumbnail on a Hikvision clip is a fetch the
   operator already asked for.** `fileFor` mints the still on the way past —
   after the lease is released, over bytes already on this disk — so playing,
   exporting or reading a clip leaves it with a permanent picture (the still
   store holds 2 000 files against the media scratch's ten, so it outlives the
   recording it was cut from). That is why `media-not-held` is FINAL and still
   TRUE: it is not "never", it is "not until something that earns the camera
   fetches this clip".

   `media-not-held` is deliberately not `unsupported`, which claims the source
   can never mint, and deliberately not `queue-full`, which promises a still
   that is coming — the promise that produced the bombardment.

   **The absence is reported as an OFFER answered finally, not as
   `thumbnailUnavailable`.** Two reasons, and the first is the honest one:
   D315 separates *not yet known* from *not installed*, and a still that
   appears the moment the operator plays the clip is `not yet`, which is what
   an offer plus a final refusal says exactly. The second is mechanical:
   `thumbnailUnavailable.reason` is a Zod enum on the cap OUTPUT and is
   validated by the hub's own installed `@camstack/types`, so widening it is a
   framework train (publish types → server → install) while
   `ClipStillRefusalCode` travels only in the `x-camstack-reason-code` HEADER
   and is not validated anywhere. The cost of the offer is one `stat` and a
   204 per tile — a 20-tile screen measured **112 ms and zero camera contact**.

**And the lane carries only work somebody is waiting for.** `ReplayPurpose` is
`stream | file`. The `still` purpose, the speculative-yield protocol and the
`AbortSignal` that abandoned a fetch mid-pass are all REMOVED rather than left
in place: nothing speculative reaches the camera any more, and a mechanism
nothing uses reads as a design this addon has (the leftover rule).

**And a live clip stream never waits to interleave, nor fails silently.**
`-max_interleave_delta 100000` is on every clip mux. **`0` is not "no window",
it is UNLIMITED** — it reproduced the fault exactly — so the value is small and
positive: 100 ms, two and a half of this camera's 40 ms µ-law frames. With it
all three audio asks deliver ~1 278 KiB by the same halfway point the silent
stream does.

`CLIP_MUX_PROBE_BYTES` is **256 KiB**, chosen between two measurements rather
than on the hunch it was the bug: first byte 721 ms at 32 KiB, 752 ms at
256 KiB, 1 126 ms at 768 KiB. Eight times the headroom for 31 ms. The record
says plainly that it fixes nothing, so the hypothesis is not re-tried.

**And a mux that accepts frames and produces no media is CUT by name.** Past
{@link CLIP_STREAM_NO_MEDIA_ACCESS_UNITS} (64 units — 5.1 s at 12.5 fps, more
than one 50-frame GOP), output still at or under
{@link CLIP_STREAM_INIT_ONLY_BYTES} (64 KiB) is `mux-no-media`, with ffmpeg's
own words attached — and `muxStderr` now travels on EVERY cut, not only on the
refusal that happened to be holding the closure. A blank player for ten seconds
becomes a named refusal in five.

**And a pacer never starts on a cushion it has not got.**
{@link CLIP_STREAM_PREROLL_MS} is 600 ms of media, and it is charged as a
SHORTFALL rather than a delay: the anchor is pushed out by what is missing, so
the first frame still paints as fast as it ever did, and a source that already
holds the clip — Reolink at 49–62× — pays nothing at all. A stream that ENDS
during the pre-roll re-anchors immediately, because a cushion that is never
coming must not hold the tail of a short clip hostage. And a starve REBUILDS
the cushion before resuming (`clip-stream:refilled`): resuming on the first
unit that arrives spends it again at once and starves on the next hiccup, which
is a stutter where one rebuffer would do.

**And the pinned ffmpeg is finally wired.** This addon has always spawned
ffmpeg and always fallen back to `'ffmpeg'` on PATH, because `addon.ts` never
called `ctx.deps.ensureFfmpeg()` — a different binary with different defaults
on every node the provider runs on. It is resolved once at init, and a failure
to resolve it is NAMED.

## Consequences

- **A still costs one `stat` and, at most, one frame of local decode. Never a
  camera.** The trade is that a clip nobody has opened has no picture, and says
  so. Measured on 1436 the hour this landed: 20 rows on screen, 10 served a
  real JPEG (275 KB) and 10 a truthful final 204, **587 ms cold / 98–117 ms
  warm for the whole screen, zero replays opened**. The same screen under
  1.2.126 would have spent **898 s** of the camera.
- **The still store's bound is what makes this accumulate.** 2 000 files and
  64 MiB against the media scratch's ten files: the picture outlives the
  recording, so a camera slowly acquires a thumbnail per clip anyone has ever
  opened and never loses one.
- **A FILE fetch still holds the camera for the clip's own duration, and a
  playback asked for during one is refused in 3 s.** Observed live the hour
  this landed: a 150 s clip fetched through the file route held the slot for
  145 086 ms, and clip streams asked during it answered `503 replay-busy` with
  `holder: "file"` and `heldForMs` on the line — which is how it was diagnosed
  in seconds instead of being mistaken for the regression again. This is the
  camera's one slot and there is nothing here to fix: what matters is that the
  refusal is immediate and NAMED instead of the queue reading as a hang. The
  same event proved rule 4's second half — that clip now carries a permanent
  still, minted on the way past by the fetch somebody actually asked for.
- **`decode-failed` joins `ClipStillRefusalCode`.** Hikvision's mint has a
  failure mode Reolink's does not — ours. Folding it into `camera-refused`
  would send an operator to a camera that answered perfectly. The viewer's
  reason table does not know the code yet and will show its generic text.
- **`replay-busy` is the stream route's vocabulary, not the export's.** The
  file path's outcome travels on `ClipExportFailure`, a cross-provider enum in
  `@camstack/types` that a Hikvision-shaped fact has no business widening, so
  it is folded to `camera-refused` in ONE place (`asExportFailure`) with the
  branch kept in the detail and in the lane's own log line.
- **`-frag_duration` costs 0.04 % of the bytes** and one `moof` every half
  second. The broker's fMP4 demuxer parses `moof`/`trun` and does not require a
  fragment to begin at a keyframe.
- **The realtime ladder is a third envelope, not a parameter.** A provider must
  still be able to do nothing but NAME one of them (D612), which is what makes
  "the declaration may not promise what no clip can be given" structural.
- **Item 4 is not user-visible until the viewer reads `getPlaybackOptions`.**
  The viewer at `4fe64afa` calls it nowhere, still parses the removed
  `clipTransport` message, and falls through to `LEGACY_CONTROLS` — free seek,
  backward step, and its own six-rate ladder. D612 said the viewer ships first
  and it has not; until it does, the hub declares honestly and the viewer draws
  what it always drew.

## Enforcement

Every gate below was proved by removing it, watching the named test fail, and
restoring the file byte-identical.

| gate | where | disarm → |
| --- | --- | --- |
| both inputs carry `-analyzeduration 0 -probesize` | `clip-mux-and-rate.spec.ts` | 1 failing |
| the stream form carries `-frag_duration`/`-flush_packets`, the file form neither | `clip-mux-and-rate.spec.ts` | 1 failing |
| the probe stops on a metronomic clock, and not before three equal spans | `clip-stream-producer.spec.ts` | 1 failing |
| `TEARDOWN` reaches the camera on the ORDINARY end of a segment | `rtsp-replay-session.spec.ts` (a real socket) | 1 failing |
| the lane refuses by name rather than dialling | `replay-lane.spec.ts` | 1 failing |
| the SERVICE wires the lane: 503 `replay-busy`, and the camera asked once | `clip-service-replay-lane.spec.ts` | 1 failing |
| the realtime ladder never exceeds 1, and every declared rate is inside the broker's clamp domain | `packages/types/src/__tests__/clip-playback-options.spec.ts` | 1 failing |
| the Hikvision provider declares the capped ladder | `videoclips-provider.spec.ts` | 1 failing |
| the pacer that runs dry says so, once per run | `clip-stream-feeder.spec.ts` | 1 failing |
| the provider OFFERS or VOUCHES, never asserts absence | `videoclips-provider.spec.ts` | 1 failing |
| the still is cut at the MIDPOINT, with an input seek | `clip-still.spec.ts` | 1 failing |
| an empty ffmpeg answer is `no-keyframe`, never a frame | `clip-still.spec.ts` | 1 failing |
| **a still request opens NO replay** — the gate is a `stat` | `clip-still-never-fetches.spec.ts` | 2 failing |
| the refusal is FINAL, so a tile does not come back for it | `clip-still-never-fetches.spec.ts` | 1 failing |
| a fetch the operator asked for mints the still on the way past | `clip-still-never-fetches.spec.ts` | 1 failing |


| a mux that takes frames and emits only a header is CUT, with ffmpeg's words | `clip-stream-producer.spec.ts` | 1 failing |
| a healthy stream that has not filled a fragment yet is NOT cut | `clip-stream-producer.spec.ts` | 1 failing |
| the muxer never waits to interleave, and the window is positive | `clip-mux-and-rate.spec.ts` | 1 failing (twice: removed, and set to 0) |
| the probe holds more than the 32 KiB it shipped with | `clip-mux-and-rate.spec.ts` | 1 failing |
| a pacer waits for the cushion when the source has not got one | `clip-stream-feeder.spec.ts` | 1 failing |
| a source that already holds the media is charged NOTHING | `clip-stream-feeder.spec.ts` | 4 failing |
| a starve rebuilds the cushion instead of sawtoothing | `clip-stream-feeder.spec.ts` | 1 failing |

**Verified on the live camera, not only in a suite.** With all 20 rows loading
their thumbnails concurrently, a clip tapped in the same breath reached its
first frame in **783 / 640 / 656 / 641 ms** across four runs, against 4 316 ms
before D616 and "minutes, or never" under 1.2.126. The hub's own lines for one
of those runs: `replay session is playing` at +~170 ms, `clip stream is muxing`
`{ probeUnits: 4, fps: 12.5 }` at +500 ms — the metronomic early-exit firing in
production, against the 16 units it used to hold — first byte at +641 ms, and
`replay session ended { teardown: "sent" }`. **One** replay session was opened
for the whole run; the twenty tiles opened none.

Five consecutive acceptance runs after the final deploy (1.2.129): **656 /
712 / 644 / 670 / 660 ms**. `media-not-held` is logged at `debug`, not `warn`:
it is the designed steady state of every list — ten per screen on this camera —
and warning it would bury the `camera-refused` that level exists for.

**Not enforced, and worth knowing:** that the `TEARDOWN` is FLUSHED rather than
discarded has no failing test. On loopback, `write()` followed by `destroy()`
still delivers, so the spec's real socket cannot reproduce the defect the fix
addresses. The `TEARDOWN`-is-sent half is gated; the flush half is review only.
