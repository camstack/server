---
id: D375
title: A segment's media timeline must fit the window the recorder measured for it — the feeder repairs a wider gap and says so, it never sleeps one out
status: accepted
date: 2026-09-06
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/recorded/segment-pts-repair.ts
  - packages/addon-pipeline/src/stream-broker/recorded/recorded-feeder.ts
---

## Context

Device 4374 ("Robot piano terra Camera", a Dreame robot whose stream is built on
demand behind an `rfc4571` relay) recorded fine, scrubbed fine, and would not
play. On 2026-09-06 the operator landed playback at 20:36:28 inside a range with
two more minutes of footage ahead of it. The server served the seek
(`recorded:seek-outcome {deviceId=4374 outcome=served state=playing totalMs=14}`),
the client announced `playback:ready {state:"playing", waitMs:11}` — and one
frame stayed on the track for 16 s until the player was torn down. The only
server-side evidence was a single census line:

```
recorded:play-census {deviceId=4374 profile=low reason=stop windowMs=0
  pacedAus=150 segments=1 prefetchWaitMsMax=0 stalls=0
  lastReadMs=4 lastDemuxMs=6 lastBytes=1259868 cursorMs=1788719788356}
```

`cursorMs` is the seek target, unmoved: `paceSegment` pushed **zero** video
access units in 16 s. `windowMs=0` is not a contradiction — `notePacedSegment`
opens the census window when a segment finishes pacing, so a window that reads 0
means the very next thing after that segment was the stop.

The first two hypotheses were both wrong and both cost time. **(a) A gap between
segments.** This camera's lazy stream does leave ~1 s cracks —
`1788719780000+9955` then the next segment at `1788719791000` — but `locate`
answers that crack correctly (`{kind:"gap", nearestEdgeMs:1788719791000}`,
verified live against the hub) and `prepareNext` already jumps to
`nearestEdgeMs`. **(b) The last segment still open for writing.** Also no: the
segments the operator was inside had been finalized for minutes.

The cause is (c), and `ffprobe` on the exact file named by `lastBytes` says it
in one line:

```
$ ffprobe -v error -show_format -show_streams \
    /media-fast/recordingsLow/4374/low/2026/09/06/18/1788719780000-9955-1259868.m4s
duration=83.360900              # the recorder measured, and the index reports, durMs=9955
packet,0.000000,K__             # the IDR
packet,73.494500,___            # the next frame — 73.5 s "later"
...
packet,83.340500,___            # 150 packets, correctly spaced among themselves
```

Every segment this camera wrote between 20:31:20 and 20:38:35 has the same
shape, and the fabricated offset grows monotonically — 1.5 s on the first, 113 s
on the last — then resets when the stream is rebuilt. Camera 101, same profile,
same hour: `realDur=8.006` against a declared 7 989 ms, PTS `0, 0.040, 0.080`.
Nothing is missing from the 4374 files; only the offset between the key frame
and everything after it is invented.

`paceSegment` sleeps every inter-AU delta with `sleepUntil`, unbounded. Resuming
at 8 356 ms into the segment it computed the first paced frame as due
`73 494 − 8 356 = 65 138 ms` later, and slept. Scrubbing kept working the whole
time because a scrub decodes one key frame per position and never consults an
inter-frame delta — which is exactly why the fault looked like a playback
feature rather than a file.

Fixing the writer was considered and rejected as the fix: the recorder's
`-reset_timestamps 1` recipe is proven across every other vendor on this
cluster, the stamps arrive already wrong from the relay, and no recorder change
can repair the ~500 s of footage already on disk that the operator is trying to
watch. Refusing to play such a segment was rejected too — the frames are all
there and correctly spaced.

## Decision

**A recorded segment's media timeline must fit the window the recorder measured
for it.** `durMs` is already the authority everywhere else on the recorded path
— the cursor (`startMs + (ptsMs − firstPtsMs)`), `clampIntoSegment`, and the
forward lookahead's `prepareNext(startMs + durMs)` all read it — so an inter-AU
gap **wider than `durMs`** is provably not footage: no segment can hold more
silence than it holds time. The feeder collapses such a gap to the segment's own
median cadence before anything paces it (`repairSegmentPts`, applied at every
demux seam the feeder owns: the full-segment load and both scrub-fragment
reads), and **logs it** — `recorded:segment-pts-repaired` with `deviceId`,
`startMs`, `durMs`, `discontinuities`, `collapsedMs`, `spanBeforeMs`,
`spanAfterMs`, once per distinct segment start.

A gap that still FITS the window is left exactly as it is: a camera that really
stalled for 4 s inside a 10 s segment recorded 4 s of stall and the viewer must
see it. And a segment with no usable declared window is paced as written —
without an authority to judge a gap against, inventing one is worse than
trusting the file.

## Consequences

- Playback of a camera whose source stamps drift no longer freezes; the picture
  and the playhead advance, and the fault is named per camera instead of being
  slept out in silence.
- The repaired timeline is a *display* timeline. Frames inside a damaged segment
  are shown at the segment's median cadence, not at the instants the source
  claimed — which is the only reading available, since the source's claim does
  not fit the segment at all.
- A healthy segment costs one pass over the PTS array and no allocation: the
  repair returns the input array itself when nothing was wrong.
- It forbids pacing a delta the segment cannot contain, anywhere on the recorded
  path. A future reader added to the feeder must go through the same seam.
- It does **not** absolve the writer. If this shape spreads beyond one relayed
  robot, the recorder's ingest is the next thing to look at — the repair makes
  that investigable, because every damaged segment now names itself in the log.

## Enforcement

`packages/addon-pipeline/src/stream-broker/recorded/__tests__/segment-pts-repair.spec.ts`
pins the rule (healthy series untouched by identity; a gap inside the window
honoured; a gap outside it collapsed) and
`__tests__/recorded-feeder-pts-repair.spec.ts` pins the behaviour end-to-end on
the real 4374 shape — 150 access units, IDR at 0, the rest at 73 494 ms + 65 ms
steps in a 9 955 ms window. Neutralising `repairSegmentPts` turns the feeder
test red with exactly the field symptom: one access unit pushed, the cursor
still on the seek target. The same file also guards the two hypotheses this
record rejected — crossing a real inter-segment crack, and a segment whose read
is shorter than its declared window.
