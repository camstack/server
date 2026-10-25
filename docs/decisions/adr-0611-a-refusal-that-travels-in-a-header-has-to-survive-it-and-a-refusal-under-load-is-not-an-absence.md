---
id: D611
title: A refusal that travels in a header has to survive it, and a refusal under load is not an absence
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-provider-hikvision/src/clips/clip-data-plane.ts
  - packages/addon-provider-reolink/src/clips/clip-data-plane.ts
  - scripts/check-clip-reason-header-is-folded.ts
  - packages/addon-provider-reolink/src/clips/clip-stream.ts
---

## Context

The operator opened clips in the viewer and reported: the list arrives, nothing
plays, no still. The hub log had the answer and could not deliver it.

**An HTTP header value is Latin-1.** Camera 1436 refused a replay and the
provider built the honest sentence

    SETUP of the video track answered 500 — the camera refused this replay

which went into `x-camstack-reason`. Node throws `Invalid character in header
content` on the EM DASH, and it throws INSIDE the handler: the status is never
written and the client gets a socket hang up. Reproduced in one screen of Node,
and the log shows it fired on every clip he opened — `videoclips: the clip
stream dial handler threw` ×8, one per attempt.

So the mechanism that exists to say WHY a clip did not play was the thing that
silenced it. And the sentence was not a typo: this repository writes its
refusals in prose, and its prose uses `—`, `’` and `…` throughout. Every reason
string was a candidate, on every vendor, and a reviewer cannot see the
difference between a safe sentence and a fatal one by looking at it.

The second failure was found by load, not by reading. Eight clips opened at
once against 1436: three answered a **bare 404 in 0.36 s**, having never
reached the camera, with **not one log line**. The same URL served 200 on its
own a moment later. Hikvision's `fileFor` answers a typed refusal carrying
`code` and `detail`; the media route's adapter was
`file.kind === 'ok' ? file.path : null`, so every named reason became `null`,
and `null` became "this clip does not exist" for a clip the list had just
shown. The sibling STREAM route has always mapped `camera-refused` to 502 with
the reason attached, and Reolink's file route has always logged each null
branch — one route out of four dropped the reason on the floor.

## Decision

A refusal sentence that travels in an HTTP header goes through
`clipReasonHeaderValue` first: it folds the typography this repo writes to its
ASCII equivalent, replaces anything else non-Latin-1 with a visible `?` rather
than removing it, strips control characters so a newline cannot split the
response, and bounds the length. Substitution, never silent deletion — an
operator reading the reason should get a readable sentence, not one with holes
in it.

And a branch that refuses work names the refusal. Where the transport has no
vocabulary to carry it — the media route's contract is `string | null` — the
name lands in the log with `tags: { deviceId }`, because a refusal under load
is not an absence, and 404 is a claim about existence.

### And a queue is not a promise to run

The same session found a third shape of the same disease. Reolink serialises
clip streams per host, and the lane had **no cancellation**: once an entry was
enqueued, `runAttempts` ran for it however long ago the peer went away — with
its full retry budget, against a camera that may be asleep. Measured on 3628, a
battery camera, while the operator moved along a list: the depth climbed 5, 6,
7, 8 and never came back down. Nothing played, because every tap waited behind
every abandoned tap before it, and the only line the log offered was the
neutral `stream-queued`.

So a queued stream whose consumer has gone is DROPPED when its turn comes,
named (`queued-peer-gone`, with how long it waited), and the lane moves on. The
close listener is registered at ENQUEUE, because the close is exactly what
arrives during the wait.

The test fake had to be corrected first: it held ONE close listener where
production is `res.once('close', …)`, an emitter. A fake more forgiving than
production would have hidden a second registration displacing the first —
which is the bug the fix could most easily have introduced.

## Consequences

- `—` in a reason reaches the operator as `-`. A small loss, against a
  response that never arrives.
- The media route still answers 404 for a refusal the camera made, which is
  imprecise. It is now at least diagnosable per camera; making the status
  honest means widening `resolvePath` past `string | null`, which is a
  separate change with its own trade.
- Nothing prevents a NEW header from carrying prose unfolded. The guard is
  scoped to this one header because that is the one that has failed.

## Enforcement

- `scripts/check-clip-reason-header-is-folded.ts`, wired into CI: every
  assignment to `CLIP_STILL_REASON_HEADER` under `packages/` must carry
  `clipReasonHeaderValue(`. It names `.slice(0, 500)` — what all five call
  sites did before — because that LOOKS like sanitising and bounds the wrong
  thing. Proved by reverting one call site and watching the guard name the
  file and line.
- `clip-reason-header.spec.ts` drives a real `http.ServerResponse` rather than
  asserting "is this Latin-1" by hand: the first test PINS the failure (the raw
  sentence hangs the socket), so the fix cannot pass by accident. Four gates
  disarmed one at a time, each red.
