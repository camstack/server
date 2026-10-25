---
id: D563
title: A still that is QUEUED is loading, not refused — the 204 says which, in its own header, because a client that classifies the server's prose is already wrong
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-still-refusal.ts
  - packages/addon-provider-reolink/src/clips/clip-data-plane.ts
  - packages/addon-provider-reolink/src/clips/clip-thumb-queue.ts
  - packages/addon-provider-reolink/src/clips/clip-service.ts
  - packages/ui-library/src/composites/clips/clip-tile-media.ts
  - packages/ui-library/src/composites/clips/clip-thumbnail-fetch.ts
  - packages/ui-library/src/composites/clips/clip-still-retry.ts
  - packages/ui-library/src/composites/clips/ClipTile.tsx
  - packages/ui-library/src/lib/format-duration.ts
---

## Context

[D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
decision 5 gave a clip tile three shapes and a rule: a still that cannot be
minted answers **204** with `x-camstack-reason`, and the surface LATCHES that
refusal rather than retrying against a camera that just said no. The five
reasons were `queue-full`, `sleeping`, `camera-refused`, `no-keyframe`,
`no-catalog-row`.

Two things about that were wrong, and both were measured on camera 107 (E1
Outdoor PoE, mains, TCP) on 2026-09-20.

**The reasons are not one kind of answer.** `sleeping`, `camera-refused`,
`no-keyframe` and `no-catalog-row` mean *it will not happen*, and latching is
right. `queue-full` means *you are in the queue* — the provider's lane serves
one CoverPreview in flight per host behind a 16-deep FIFO
(`clip-thumb-queue.ts`) and refuses past that INSTANTLY rather than holding a
request open. Latching it leaves a tile permanently blank for a still that is
seconds away. And it is not the edge case. Firing one page's 60 mint URLs in
parallel, exactly as a first paint does (`TILES_PER_PAGE = 60`):

    60 parallel mints on 592  →  17 × 200 image/jpeg
                                 43 × 204 queue-full

The same 60 URLs asked one at a time all answered 200. So **43 of the 60 tiles
of the first page were blank, for ever, for stills the camera was about to
produce.** 349 of that camera's 400 rows in 24 h carry a mint URL.

**And the surface was classifying the server's prose, badly.** The route sent
the whole sentence in the one header —
`queue-full: 16 thumbnail mints already waiting for host 192.168.x.x` — while
`clip-tile-media.ts` keyed its table on the bare token. No key ever matched.
Every refusal on this fleet, deferred and final alike, rendered as
`Refused: <prose>`. The rule this proves is the general one: a client that
pattern-matches a server's words drifts the first time a word changes, and here
it had drifted before it shipped.

A third defect on the same rows, from the same measurement: every clip carries
a complete `timeRange` and the tile drew none of it — and the NEWEST row, the
one the operator sees first, carries an `endMs` that is not an end. Its file is
`…/RecS03_DST20260920_192927_000000_2B1E808_0.mp4`: the second timestamp is
zeros and the size field is `0`, which on this camera means the recording is
still being written. The `endMs` comes from the camera's own `<endTime>` block
in the `FileInfoList` reply (nodelink-js `parseRecordingFilesFromXml`, copied
through by `clip-catalog.ts`), and for an open file it is FROZEN at whatever
the index entry held when it was created. Read three times — 17:37:06, 17:37:35
and 17:44:39Z — it said 17:29:56 every time, for a file that started at
17:29:27 and was still growing fifteen minutes later. A 29 s duration on a clip
that plays for a quarter of an hour is worse than no duration.

## Decision

**A 204 says whether to come back, in its own header, and the branch that
refused decides.** The route answers with three headers beside the prose it
already sent:

| header | what it is |
| --- | --- |
| `x-camstack-reason` | the provider's / camera's own words, verbatim, unchanged |
| `x-camstack-reason-code` | ONE token from `ClipStillRefusalCodeSchema` |
| `x-camstack-disposition` | `deferred` \| `final` |
| `retry-after` | seconds, on a `deferred` answer only |

There is deliberately **no table mapping a code to a disposition**, in the
provider or in the surface. A table is a second authority and it is the one a
new code forgets to join. Instead `clip-still-refusal.ts` exports two
constructors typed so narrowly that the wrong pairing does not compile —
`deferStill` takes only `queue-full | camera-backoff`, `refuseStill` takes the
`Exclude` of those — so a code added to the cap enum lands in `refuseStill`'s
domain by default and a branch has to opt INTO deferring it.

**The surface reads the disposition; it never infers one.** A `deferred` tile
keeps showing LOADING — a named loading state, not a bare skeleton — and comes
back on `planStillRetry`'s schedule: exponential from 4 s, ±25 % jitter, capped
at 30 s per wait, **4 retries and then it stops and SAYS why**. The server's
`retry-after` is taken only when it is LONGER than the curve, so a provider
answering `retry-after: 1` for a whole page cannot turn this into 43 requests a
second. Exponential because a fixed interval either hammers or dawdles;
jittered because 43 tiles refused in one paint would otherwise return in one
instant and refuse together again; bounded because a tile that asks for ever is
the other way to show the operator nothing.

Retry — not a push, and not a client-side queue. **A deferred refusal is
free**: the lane rejects past capacity without touching the camera, so asking
again costs one cheap HTTP round trip to the addon and zero Baichuan commands.
A push would need a channel, a subscription and server-side fan-out of 60 tile
identities to save requests that cost nothing; a client-side queue would be a
second copy of the authority that already lives where the camera's real
constraint is. Scroll-into-view alone saves nothing here — the 43 refusing
tiles are the ones already on screen.

**A missing or unrecognised disposition is FINAL.** That is not a fallback
guess, it is the behaviour that already shipped: an addon built before this
record sends no such header and its tiles latch exactly as they used to,
instead of gaining a retry loop against a build nobody tested it with.

**A clip draws its length, from the one formatter the product has** —
`RecordingPanel`'s, promoted to `lib/format-duration.ts` rather than copied a
fourth time. **And a clip still being written declares it** (`Clip.inProgress`)
and draws `Recording…` instead of a duration. `endMs` stays a number, because
it is the best bound the mint window and the byte fetch have and every consumer
requires one; the flag says what that number is WORTH.

## Consequences

- The wire grew two headers and the cap enum grew a ninth code
  (`camera-backoff`, which the queue could already produce and which nothing
  named). `ClipStillRefusalCodeSchema` is now the one vocabulary; a new refusal
  has to be added there before it can be sent.
- Worst case a tile makes 5 requests instead of 1. On a 60-tile page whose lane
  is full that is ~240 requests to the addon over ~60 s, none of which reaches
  the camera, against 43 tiles that currently show nothing at all.
- The retry budget is sized against the drain it has to outlast: one page is 60
  tiles at one mint in flight, so the tail tile is ~60 mints away, and the four
  waits total ~58 s un-jittered. A shorter budget would be theatre. If the
  page size or the lane depth changes, that sizing is the thing to re-check.
- `ui-library` and `provider-reolink` are different trains and ship
  independently; both orders are safe by the paragraph above, and both were
  specced.
- `Clip.inProgress` was **not on the wire** when this landed: the schema, the
  tile and its specs were in place, but nothing measured the flag and `toClip`
  had nothing to copy, so the `Recording…` state was unreachable in production
  and the newest row kept showing its frozen 29 s.
  [D567](adr-0567-a-clip-carries-the-sound-the-download-already-held-and-is-muxed-at-the-rate-it-was-delivered-at.md)
  closes that: `isFileStillBeingWritten` is the measurement and `toClip` is the
  one site that copies it.
- `latchMintRefusal` is gone, replaced by `describeRefusal`. It took a bare
  string and had no room to say "come back", which is how the defect survived
  review the first time.

## Enforcement

- `packages/ui-library/src/composites/clips/__tests__/clip-tile.test.tsx` —
  every cold-state assertion is made with **nothing awaited**. That is the
  specific gap the previous pass on this surface had: the honest-state specs
  all passed while the wire lied, because each one warmed the state before
  asserting it. Here the first paint, the deferred paint, the exhausted budget
  and the pre-D563 addon are each asserted from the state a real first paint is
  in, and each was confirmed to go red when its fix was removed.
- `clip-still-retry.spec.ts` pins that the schedule grows, jitters, caps,
  floors the server's hint, outlasts a 60-deep drain, and STOPS.
- `packages/addon-provider-reolink/src/__tests__/clip-still-refusal.spec.ts`
  and `clip-thumb-queue.spec.ts` pin that the queue refuses with a TYPE
  carrying its own measured wait, and that a camera failure is not that type.
- `clip-data-plane.spec.ts` pins the three headers, the `retry-after`, and that
  a FINAL refusal is warned with `tags: { deviceId }` while a deferred one is
  not — 43 warnings a paint is how a real drop stops being visible.
- Nothing guards "the client must not classify the prose" mechanically. The
  type of `describeRefusal`'s input is the closest thing: it takes the headers
  as they arrived, and the only branch is on `disposition`.
