---
id: D601
title: Two tracks, one origin — a discontinuity may not re-base per track
status: accepted
date: 2026-09-22
applies-to:
  - packages/addon-pipeline/src/stream-broker/recorded/feed-clock.ts
---

## Context

`MonotonicClock` maps source PTS onto a strictly increasing output clock, and
`markDiscontinuity(gap)` re-bases it past `this.lastOutMs` so a seek is
unmistakable to the receiver. Recorded playback ran TWO instances — 90 kHz for
video, 8/48 kHz for audio — and its comment said they "`markSeek()` together to
stay A/V aligned".

They do call it together. It does not help, and it cannot: `lastOutMs` is each
instance's OWN last output, and the two differ by however far apart the
interleave left them. So every discontinuity replaced the real A/V offset with
that gap — in the same direction each time, and never gave it back.

Measured on the clock alone: the skew grows by a fixed step per seek and never
returns (10–23 ms a seek on a synthetic fixture). On a real clip with a coarser
interleave, **900 ms over three forward seeks** — found while building the clip
stream's audio (D600), which had inherited the same two-clock shape.

It reaches the peer. `setLiveFeedGate` arms the session's audio rebase ONCE, at
the live→recorded switch, not per seek — so after that single rebase the
feeder's stamps flow through with a constant per-track offset, and the drift
travels with them.

## Decision

The base and the source anchor are shared: one `FeedOrigin` per feeder, two
clocks. With one anchor, `out_video − out_audio` is `(vPts − aPts) / rate` —
exactly the source offset, which is the entire content of lip sync — and there
is nothing left to keep in step.

`lastOutMs` stays per track: monotonicity is a promise to ONE receiver track,
and clamping video against audio's last stamp would move video.
`markDiscontinuity` opens its gap past the origin's high-water mark — the
furthest EITHER track reached — so the paired calls the feeder already makes
produce one gap, not two.

A clock constructed without an origin gets its own, so every other user is
byte-for-byte unchanged.

## Consequences

- Audio is now measured from the VIDEO anchor rather than from its own first
  sample, so a recording whose first audio AU sits 20 ms after its keyframe
  stamps that audio at 20 ms instead of 0. The ABSOLUTE value never reaches the
  peer — `writeRecordedAudio*` rebases the first recorded frame onto the live
  stream's continuity — but two tests asserted it, and they asserted the
  per-track anchoring this record removes. They now assert the offset AND the
  spacing.
- The same shape existed on the clip stream and was fixed there first (D600)
  by giving the demuxer one origin for both tracks. This is the file path
  catching up; the two are now the same idea in two places, not two ideas.
- It changes nothing at rate ≠ 1: `hasAudioSink` already requires `rate === 1`,
  and only the video clock is given `setRate`.

## Enforcement

`feed-clock.spec.ts` pins both directions: with one origin the skew after three
seeks is the skew after none, and with separate origins it grows every time —
asserted as a SHAPE (strictly increasing), not a magic number, because how big
it gets is the interleave's business.

The feeder's own wiring is pinned behaviourally, not by reading the source: the
two audio-push tests assert the offset that only a shared origin produces, and
they go red when the feeder's `audioClock` is given its own origin back. That
gap was real — the first disarm of the feeder left all 451 recorded tests
green, because the drift was pinned on the class and nothing checked that the
feeder used it.
