---
id: D591
title: A clip byte read names the provider that holds the file
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-file-source.ts
---

## Context

Onboard clips played for a flash and stopped. The app-side trace (added the
same day) showed the command completing every hop — tap, stage, dispatch, port,
inject, `playClip arrived`, `playClip sent to the broker` — and the hub then
answered:

> `clip playback: byte fetch failed` … *"native:reolink:onboard:0:… is an
> analytics visit — a window over recorded footage with no file behind it."*

That sentence is the RECORDER's videoclips provider, which implements
`readClipBytes` solely to explain that it has no file. The clip belongs to
`provider-reolink`.

`videoclips` is a device-scoped collection with several providers on one
camera, and the same read proved the point from outside: `provider: 'recorder'`
returns that refusal, `provider: 'provider-reolink'` returns the bytes. The
broker named neither — and the broker lives in `addon-pipeline`, **the same
addon that registers the recorder's provider**, so the in-process resolution
handed it its own sibling. Every onboard clip, every time.

`listClips` learned this on 2026-09-20 (D554: naming is REQUIRED, "absent means
the bound provider" was a sentence no code implemented). The same hole was one
method over, and nothing stopped it being reached.

## Decision

`videoclips.readClipBytes` takes `provider`, **required**, and the name travels
the whole way: the clip row's source → the app's dispatch → the `playClip`
control message → `ClipPlaybackHandle` → the byte read. Every hop carries it;
no hop derives it.

Deriving it from the clip id's prefix was the alternative and is exactly what
D482 forbids — an id's shape is not a fact about who owns the bytes. The app
already knows the answer, because it listed the row from that provider.

The export path takes the same field: its subject has carried `provider` all
along and `fetchClipBytes` dropped it, so an export of an onboard clip had the
same latent bug.

## Consequences

The control message is versioned by its schema: a `playClip` with no provider
is REFUSED rather than guessed at, so an old viewer against a new broker gets a
named refusal instead of the recorder's confusing sentence. The viewer and the
broker therefore ship together.

A member provider does not read the field — it is already the one being asked.
It exists so the CALLER decides, instead of an in-process lookup deciding for
it.

## Enforcement

`timeline-session-clip.spec.ts` refuses a `playClip` that names no provider and
asserts the name reaches the feeder's handle. The type made the two remaining
call sites (the broker and the recorder's export) fail to compile, which is how
both were found.
