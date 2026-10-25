---
id: D606
title: Each control asks the question it depends on
status: accepted
date: 2026-09-22
applies-to:
  - camstack/src/clips/clips-surface.ts
---

## Context

The operator: the clips timeline is *"completamente staccata"* — the heatmap
and a working playback bar are both lost — and the same battery camera in the
same stopped state shows a disc on the STREAM in one mode and a bar in the
other. *"È inconsistente."*

`resolveClipsSurface` made four claims about a body of files, and one of them
was an accident.

**Sound, and kept:** `playhead` and `scrub` follow the BODY's axis. No epoch
runs down a list of files, so a position line measures nothing and a timeline
drag would land on the recorder's footage — a different camera-moment
entirely. (`scrub` here is only ever the timeline drag; the file-relative seek
is a separate control, and the two were already correctly apart.)

**The accident:** `transport: false`. The playback band addresses the frame's
OCCUPANT, and the frame always has one — on that surface it is the live
session, on screen, playing. A body of cards underneath has no standing to
withdraw play/pause, go-live and rate over a picture that is running.

That single claim is what forced the workaround: with the band gone, a battery
camera on hold inside its own clip list had no way to start the live at all —
no poster control, no disc, no band — so `overlay-play-pause.ts` grew a
`batteryHold` short-circuit that draws a disc on the stream. Its own docstring
had already written the rule that undoes it: *"a battery hold is a STREAM
state, not a time control."*

**Second-order accident:** `timeAxis` also gated the day strip, and the
argument for hiding it was about the VERB — "a drag there commits a seek into
our recorder's footage" — not about the strip. A file carries a wall-clock
start, so the day does address it.

## Decision

**Each control asks the question it depends on.**

- The **transport** asks about the PLAYER. The frame is always occupied, so the
  band is drawn on every surface. It stays a field rather than becoming an
  invariant, so a fifth surface must still say so out loud.
- The **playhead** and the **timeline drag** ask about the BODY's axis.
  Unchanged.
- The **day strip** asks about the DAY, which both bodies address. Only its
  target changes: over a list of files its bands are the FILES and a press
  opens one (`clipAtEpoch` puts a press between two clips on the later one —
  the answer `clipAxisOffsetToEpoch` already gives). Over an epoch body with a
  clip held it stays withheld, because a press there would have to leave the
  clip first and nothing in this app does that except go-live.

`timeAxis` is retired. It was the last field answering two questions, and its
claim is now `axis !== 'epoch'`, so the two cannot disagree.

## Consequences

- The `batteryHold` short-circuit is DELETED, and its precondition is pinned
  rather than assumed: a test asserts every clips surface keeps the band, so a
  future surface that withdraws it fails on the day it is written instead of
  on the day a battery camera cannot be started.
- It closes a hole D602 left: the bar did not know about the forward-only
  limit, so a backward drag was refused INVISIBLY and the knob snapped forward
  — the "reads as broken" outcome that declaration exists to prevent. The
  track now draws the spent stretch and stops the drag at it, from the same
  `clipSeekAllowed` vocabulary rather than a second one.
- No server change: `clipTransport` already carried everything the bar draws.

## Enforcement

`clips-surface.spec.ts` pins the transport on every arm and the strip's verb
per body; `overlay-play-pause.spec.ts` pins that the gate reads only the two
LAYOUT facts. That second one was **vacuous on its first pass** — it scanned
for `readonly \w+:` which does not match `readonly batteryHold?: boolean`, so
it passed with the field it forbids still present. Fixed, and the disarm is
red.
