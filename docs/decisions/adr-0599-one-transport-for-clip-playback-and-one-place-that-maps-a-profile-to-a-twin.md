---
id: D599
title: One transport for clip playback, and one place that maps a profile to a twin
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-twins.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-path-choice.ts
---

## Context

D597 gave clip playback a second transport and split the asks between them:
the STREAM for `low | mid`, the FILE for `high`. The reasoning was D576 — a
Reolink recording exists as two files, the main twin is roughly 33× the bytes,
and stage 1's replay opened the sub file, so handing a `high` ask to the stream
would have served the cheap copy under the expensive name.

Two things were wrong with the split.

**It was the wrong cure.** The disease is a silent substitution, and the cure
for that is `served` — a field already on the dial's answer, already stating
which twin the stream carries. Refusing instead made `high` look *unsupported*
rather than unavailable for that one recording, which is a different and worse
lie: `readClipBytes` had served the sub copy with a warning in exactly that
case since D576, so the two methods answered the same question differently.

**It put one behaviour on two planes.** Which profile you ask for decided which
transport you got, so a bug in the stream appeared on `low` and not on `high`,
and every future change to playback had two implementations to keep in step.
The system already has a profile ladder; the transport is not part of it.

Underneath both sat a third problem the split had hidden: `ClipTwin`'s own doc
comment said *"Nothing else in this addon may decide which one a call means"*,
and **three** call sites decided it independently — `getClipPlayback`,
`readClipBytes` and the dial — with the dial disagreeing with the other two.

## Decision

`chooseClipTwin(profile, row)` in `clip-twins.ts` is the only function that
maps a requested profile onto a twin. It returns the twin, the file, what will
actually be `served`, and whether that is a `downgraded` answer. All three call
sites ask it.

`high` reaches for the main twin; everything else, including an absent profile,
is the sub. A `high` on a recording whose main twin does not exist is served
the sub copy and says so — never refused, never silent.

Clip playback has ONE transport: the stream, for every profile.
`chooseClipPath` no longer reads the profile at all. The file path is what a
broker with no dial falls back to, not a second class of ask.

## Consequences

- The broker must READ `served`, and does: a `high` ask answered with anything
  else logs it, per camera. Nothing read that field before, which is this
  repo's recurring failure — a decision written where nothing executes it.
- The line fires on a DOWNGRADE, not on any difference. `mid` maps onto the sub
  twin by design, so a line on `served !== asked` would fire on every ordinary
  clip and mean nothing.
- `PrepareStreamDialInput.twin` widens from `Extract<ClipTwin, 'sub'>` to
  `ClipTwin`. The narrow type was the split expressed in the type system.
- `high` over the stream costs roughly 33× the bytes of `low`. That is now an
  honest consequence of what was asked, paid by the ask, rather than a reason
  to route it elsewhere.
- Deploy order matters and has no fallback: `streamDialWired` is the broker's
  own compiled-in closure, not a question asked of the provider. A broker
  deployed ahead of its provider picks the stream, gets `NOT_IMPLEMENTED`, and
  refuses by name with a deploy hint. **provider-reolink first, then
  addon-pipeline.**
- ~~Still open: the stream is VIDEO ONLY.~~ **Closed by
  [D600](adr-0600-a-clip-stream-carries-sound-transcoded-by-the-provider-and-the-broker-only-frames-and-paces-it.md)**,
  the same day: the provider transcodes the AAC to the session's negotiated
  codec and muxes it as a second track, the demuxer follows it, and a clip
  that is silent says which kind of silence it is.
- And the cure this record claims was NOT wired on the path that serves it:
  `clip-stream-route.ts` opened `row.subFileName` whatever twin the dial had
  minted, so a `high` ask was answered `served: 'high'` and streamed the sub
  copy — the exact substitution above. Found and fixed under D600, which
  carries the twin on `ClipStreamTarget` beside the audio ask.

## Enforcement

`clip-twins.spec.ts` pins the mapping, including the invariant that `served`
is `high` if and only if the twin is `main` — the lie stated as one assertion,
whatever produces it. `clip-path-choice.spec.ts` pins that every profile gets
the same answer for every wiring combination, so a profile branch cannot come
back. `clip-stream-feeder.spec.ts` pins both that the downgrade is logged and
that an ordinary `mid` clip stays quiet. Each was proved by removal.
