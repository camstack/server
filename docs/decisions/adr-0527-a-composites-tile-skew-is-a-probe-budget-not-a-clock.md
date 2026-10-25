---
id: D527
title: A composite's tile skew is a probe budget, not a clock
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/grid-stream-invocation.ts
  - packages/types/src/ffmpeg/invocation.ts
---

## Context

The operator reported the camera grid "funziona abbastanza male" [works rather badly], and then, after
the pacing revert, the precise symptom: fluid picture, one tile permanently a few
seconds behind the other.

The first explanation was wrong, and had already cost a release. It was that a
`/muted` dial is served only at the next IDR, so two tiles join a key-frame
interval apart and `overlay` — which pairs inputs BY PTS — marries frames from
different moments for the life of the child. That story is coherent, the join
spread is real (four joins of one restream: 1830 / 3987 / 3985 / 4025 ms), and
it produced `-use_wallclock_as_timestamps`, which wrecked the output pacing (ten
stalls over a second in an 18 s run, against none) and was reverted.

It was wrong because nobody had measured the join spread of the two sources
**against each other**. Joined in parallel they landed 438-599 ms apart, five
runs, never more. The same two sources inside ONE ffmpeg were 4-5 s apart, read
straight off the cameras' burnt-in clocks in a single composed frame:

```
13:11:21 | 13:11:23        and the EARLIER input is the late one
```

That asymmetry is the whole finding. ffmpeg opens its inputs one after another,
and each open blocks in `avformat_find_stream_info` until its budget is spent.
Input 0 is connected and receiving while ffmpeg is still opening input 1; its
frames pile up; `overlay` then pairs input 0's oldest with input 1's newest. The
lag never closes, because both advance one frame per output frame.

The budget was the cost. `-probesize` counts BYTES, and 1 MB of a 640x360
sub-stream is tens of seconds of video, so the `-analyzeduration 1s` next to it
never got to stop anything. The same sum is the ~9 s cold start that had been
accepted as the price of waiting for the slowest source: it was never the
slowest source, it was all of them in series.

## Decision

A multi-input composite sets `analyzeDurationUs: 0` and `probeSizeBytes: 32` on
every input, so each open returns from the SDP without reading media. Tile skew
in a composite is diagnosed at the INPUT OPEN before anything re-times the
media: re-stamping inputs by arrival is not a fix for it and costs the pacing.

Measured on the hub, the live grid's two sources, three runs each, production
input args otherwise identical — time to first composed frame, and the skew read
off the two burnt-in clocks in that frame:

```
  1 s / 1 MB     8986, 9728, 9712 ms      skew 5 s, 5 s, 4 s
  0   / 32       2281, 2270, 2304 ms      skew 1 s, 1 s, 0 s
```

## Consequences

The probe reads nothing, so it must survive what it is not told. Checked before
shipping: h264, h265 and a derived (`mid-to-low`) source all open `rc=0`; a 20 s
run produces 200 frames of 200 either way, so the pacing this path already lost
once is untouched; the skew is still 0 at 25 s into a run, because it is fixed at
start-up and does not drift. A source whose codec is NOT derivable from its SDP
would fail to open rather than degrade — which is the right failure, but it is
why this is a composite rule and not a global default.

What remains is the genuine join spread, bounded by one key-frame interval. If
it ever matters, the answer is to start the inputs from a join point we hold
(`flv-join.ts` already is one), never to re-time the inputs.

A third camera appeared to sit 5 s ahead of the other two and did not: its own
OSD clock runs ~3 s ahead of the hub's. A burnt-in clock is an excellent
instrument for RELATIVE skew between runs of the same pair, and says nothing
about absolute latency until it is checked against the hub.

## Enforcement

`grid-stream-invocation.spec.ts` pins the whole argv, including these two
values, and carries the measurement next to them.
