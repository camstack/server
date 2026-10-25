---
title: addon-provider-hikvision — package notes
covers:
  - packages/addon-provider-hikvision/**
---

# addon-provider-hikvision — package notes

Moved verbatim from `packages/addon-provider-hikvision/AGENTS.md` on 2026-10-09 so that root +
package `AGENTS.md` stay inside the 32 KiB Codex reads. That file keeps
the intro and the skill pointers and links here; edit the notes HERE.

## The camera has ONE playback slot, and it does not forgive

`rtsp://…/Streaming/tracks/<id>/?starttime=…` is a REPLAY session, and this
firmware serves one at a time per camera. A session nobody tore down blocks
every later one with **`SETUP` → 500**, while `ContentMgmt/search` on the same
camera keeps answering normally, so the camera looks half-broken and is not.
Measured the hard way (D605): an abandoned ffmpeg held 1436 for three hours.

- A `SETUP` 500 says **nothing** about whether the clip exists. Never retry it.
- **The provider holds the slot itself** (`replay-lane.ts`, D616). The stream,
  the file fetch and the still mint all take a lease per `deviceId`; a second
  ask waits only as long as a slot BEING released would take and is then
  refused `replay-busy` / 503. Nothing here may dial a camera whose slot we
  know we hold — a fact the provider owns is never learned from a 500.
- Every exit `TEARDOWN`s — including the ORDINARY one. `finish()` sends it on
  every exit that has a session, and `releaseSocket` `end()`s the socket with a
  bounded flush: **`socket.destroy()` discards a queued `write()`**, which is
  how a clip fetch used to walk away holding the camera for 60 s.
- `RtspReplaySession.close()` resolves when the SOCKET IS GONE. "The run
  returned" is a different fact from "the slot is free"; a lease released on
  the first is the bug back again.
- If you probe by hand, kill your process by **pid** and verify with `ps`.

## A played-out replay goes QUIET — it does not close

No end-of-stream marker, **zero RTCP**, socket left open until the camera's own
60 s timeout. So:

- quiet AFTER media (`RTSP_SEGMENT_QUIET_MS`, 3 s) = the segment ended;
- quiet BEFORE any media (`RTSP_IDLE_TIMEOUT_MS`, 15 s) = a failure;
- an RTCP packet re-arms **neither** — a keepalive counted as media would hold
  a finished clip open for a minute.

A single idle rule files every complete clip as `idle`, and fourteen unit tests
will not notice.

## A replay is paced at 1x, and that decides the rate ladder

246 access units in 18.9 s for a 19 s segment on 3833; 176 in 14.27 s on 1436,
**1.01x**. It is the transport, not a knob. `Rate-Control: no` (3.97x,
measured) is deliberately not wired — D605 says why.

Two consequences that are easy to get wrong (D616):

- **The broker's pacer eats `rate` seconds of media per second while the socket
  supplies one**, so anything above 1x drains a buffer that never held the rest
  of the clip. This provider declares `CLIP_PLAYBACK_OPTIONS.realtimeStream`
  (`[0.25, 0.5, 1]`), not `.stream`. A rate it cannot deliver is never offered.
- **Every access unit the rate probe HOLDS is 80 ms of the operator's wait.**
  The probe stops as soon as three consecutive spans are identical, which on
  this fleet is always (7 200 ticks, every frame). Time to first frame was
  4 316 ms and is ~750 ms; 222 ms of that is the camera and the rest was ours —
  ffmpeg's input probe, `frag_keyframe` waiting out a 4 s GOP, and the AVIO
  buffer sitting on a 942-byte init segment.

## A 1x source needs a CUSHION, and the broker owns it

The pacer plays media time at `rate`; this wire delivers media time at ~1x. At
rate 1 those are the same speed, so the queue never builds and the first jitter
empties it — measured live as `clip-stream:starved { headMs: 480, arrivedMs:
480 }`, the two equal to the millisecond, after which the viewer fell back to
live. `CLIP_STREAM_PREROLL_MS` (600 ms, in `addon-pipeline`) is the fix, and it
is a SHORTFALL: a source that already holds the clip pays nothing.

Measured through the broker's own demuxer: media arrives at 1.017x in lumps of
160–320 ms, worst deficit ~196 ms, and a zero cushion produces **70 starves**
over 26 s. Do not re-derive this from the frame rate — the lumps come from the
mux's `-frag_duration`, not from the camera.

## A still NEVER spends the camera's playback session

There is no playback-still endpoint on this firmware:
`Streaming/channels/<id>/picture` is the LIVE view, which for a clip from
yesterday is worse than no picture. So a still is cut from the clip's own
archived MP4 (`clip-still.ts`), at the MIDPOINT — the first frame of a motion
segment is the moment before the subject arrived. `-ss` goes BEFORE `-i`, and a
seek that produces no frame is a named 204, never a black one.

**`mintStill`'s gate is a `stat`, and nothing below it may reach the network.**
A clip whose bytes are not held is refused `media-not-held` / **final**. This
is not caution, it is measured: a 24 h listing on 1436 is 20 rows spanning
**898 s**, the viewer asks for the thumbnails of the rows on screen, and at
1.01× arrival filling that screen once cost fifteen minutes of the camera's
only playback session. Shipped as 1.2.126 and reported within minutes
(*"stiamo bombardando la camera per uno snapshot"*). After: **112 ms for the
whole screen, zero replays.**

- **A viewer asking for the tiles it can see IS a prefetch.** "We have no
  prefetch pass" was true and irrelevant.
- **A lane that queues speculative work behind a user's tap is worse than one
  that refuses it.** The first fix was a yield protocol so a still would give
  the slot back; it helped against ONE competing ask and did nothing against
  eleven mints each re-taking the slot. It is gone, along with the `still`
  purpose and the fetch-abort signal — nothing speculative touches the camera,
  so `ReplayPurpose` is `stream | file` and both are somebody waiting.
- **What puts a picture on a clip is a fetch the operator asked for.**
  `fileFor` mints the still on the way past, free, over bytes already on disk.
  The thumb store holds 2 000 files against the media scratch's ten, so the
  picture outlives the recording.
- `media-not-held` is not `unsupported` (which claims this source can never
  mint) and not `queue-full` (which promises a still that is coming — the
  promise that produced the bombardment).

## A clip stream with SOUND needs `-max_interleave_delta`

ffmpeg buffers packets to interleave two inputs — video on stdin, µ-law on
`pipe:3` — and for a LIVE fragmented stream any window at all is wrong. Without
the flag a six-second clip delivered **1 KiB** (the init segment) by its
halfway point and then dumped 3.78 MB at input EOF; the silent version
delivered 1 299 KiB. The operator saw a player that never started.

- **`0` means UNLIMITED, not "no window".** It reproduces the fault exactly.
  The value must be small and positive; 100 ms is two and a half of this
  camera's 40 ms µ-law frames.
- **It is not a rate mismatch.** The timelines measure 4.80 s of video against
  4.80 s of audio, ratio 1.000. Do not go looking for `-ar`.
- **It is not the probe size**, which was the obvious suspect: 32 KiB → 768 KiB
  all reproduce it, as does removing the probe flags. Do not re-try that.
- A mux that takes frames and emits only a header is now CUT by name
  (`mux-no-media`, 64 access units / 64 KiB) with ffmpeg's stderr attached.

**And measure the output TIMELINE, never the total.** A stream that dumps
everything at EOF has a perfectly healthy `bytesOut`.

## ffmpeg comes from `ctx.deps.ensureFfmpeg()`

The pinned jellyfin build, resolved once in `onInitialize` and threaded into
`createClipService`. Until D616 this addon spawned `'ffmpeg'` from PATH — a
different binary with different defaults on every node it runs on.

## Credentials never reach an argv

The replay client sends digest on its own socket. Handing ffmpeg
`rtsp://user:pass@host/…` would put this camera's password in every `ps` on the
hub for the length of the clip — and it measured unusable anyway (no output in
three minutes). `HikvisionCamera.getClipCamera()` is the one seam, in-process.

## Three things `ContentMgmt` says that are not true

- **`search`'s `codecType` is `H.264-BP` for H.265 media.** Decode from the
  SDP's `a=rtpmap`, or from `record/tracks`. Never from `search`.
- **`record/tracks`' `framerate` is `2.26 fps` on a track that measures 12.5.**
  Never budget from it; the rate is measured from the replay's RTP timestamps.
- **`NO MATCHES` arrives with `responseStatus: true`.** Key off
  `responseStatusStrg`.

And `numOfMatches` is the size of the page in hand, not the result: results are
OLDEST-first, so a reader that does not page answers with yesterday's footage.

## The track list is not uniform across this fleet

1436 lists one archived track (101); 3833 lists 101 AND 103 and only 101 is
`trackType=video`. Take the enabled VIDEO track, never "the first enabled one".
Track **102** is a trap: `DESCRIBE` answers 200 with a 720p SDP and then
delivers the 4K main stream — never probe for a twin by DESCRIBE.

## `SETUP` the MEDIA control, never the session one

The `a=control` before the first `m=` is the aggregate URL. `SETUP` on it
answers **415** and the camera closes the socket, so one wrong request costs the
whole session. `parseRtspSdp` cannot return it.
