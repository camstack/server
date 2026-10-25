---
id: D619
title: A value that travels in a narrow field is minted and compared in that field's width
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/addon-provider-reolink/package.json
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-feeder.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-http.ts
---

## Context

Reolink clips returned zero bytes. Every clip, every camera, for an evening —
and intermittently before that, which is what made it look like the cameras.

The Baichuan header's `channelId` is the replay **session handle**: minted
fresh per transfer, echoed by the camera on the reply and on every chunk, and
used as the discriminator that stops an abandoned transfer's in-flight tail
from being adopted by its successor (`reolink-baichuan-js`, 60ec9c7). The
library minted it from `nextMsgNum()`, a **16-bit** counter. The wire field is
**8 bits**: `encodeHeader` writes `writeUInt8(channelId & 0xff, 12)` and
`decodeHeader` reads `readUInt8(12)`.

So the camera echoed the byte it was sent, and the lock compared that byte
against the unmasked mint. **From the 256th command of a connection onward,
every frame of every cmd 5 replay was rejected as `foreign-channel`, for the
life of that connection.**

The arithmetic, from three independent live samples:

| minted | echoed | difference | `minted & 0xff` |
| ---: | ---: | ---: | ---: |
| 2497 | 193 | 2304 = 9 × 256 | 193 |
| 2516 | 212 | 2304 | 212 |
| — | 48 | — | minted ≡ 48 (mod 256) |

Two things made it expensive to find. It is **time-dependent, not
camera-dependent**: below 256 the mint and the echo agree, so it "worked
earlier today" and reappeared later, which reads as a flaky camera. And a
transfer receiving none of its **own** chunks cannot be ended by the idle
timer either — `armIdleFinish` only finishes once chunks have arrived — so it
hung to the 120 s deadline **holding the camera's single replay lane**, three
attempts per clip, six minutes of dead camera per tap.

The visible symptom was therefore a queue: the lane depth climbed 11, 12, 13,
14, 15, 16 in seven seconds and never came back down. The first hypothesis,
that the queue was the defect, was wrong. The queue was the shadow.

## Decision

**A value that travels in a field of width *n* is minted, locked and compared
in that width.** Not masked at the write and compared wide; not trusted to be
small enough in practice. One exported function owns the narrowing and every
site passes through it — `toWireChannelId` in the library's case — because
masking at the mint alone leaves an override path free to re-open the same gap
at the comparison.

Its corollary, in this repo: **a request nobody is waiting for is abandoned at
the moment it is abandoned, not at a timeout.** `ClipStreamOpener` now takes an
`AbortSignal`; a feeder torn down mid-open aborts before touching the
connection, and an already-aborted signal never dials. It had no cancellation
seam at all, and `ClipStreamConnection.destroy()` does not exist until response
headers arrive — which a *queued* provider never sends. Measured: disposed at
18:17:51.470, released by the provider at 18:18:10.443, **29 973 ms later**,
which is exactly the `waitedMs ≈ 30 000` on all sixteen queued entries. They
were not abandoned late. They were never abandoned at all.

## Consequences

The discriminator space is 256 rather than 65 536. That is ample — the app's
own captures use handles in 40…170, and the space only has to separate a
transfer from the tail of its immediate predecessor.

The two masking sites are **redundant by design and no test can pin either
alone**: masking at the mint makes the locked value already a byte, masking at
the comparison makes an unmasked mint harmless, and only disarming BOTH turns
the suite red. That is recorded in the code so the next reader does not delete
one as dead — which is exactly how this class of defect is reintroduced.

A severed Reolink run still cannot stop its camera: nothing on the wire aborts
one and the only lever is throwing from the next chunk, which a zero-chunk
transfer never gets. The lane is deliberately **not** released early — that
would start the next transfer against a replay nobody stopped, which is what
the residue machinery exists to prevent — so it is NAMED instead:
`cut-not-honoured`, with `heldSinceCutMs`.

## Enforcement

A regression test in the library: walk the shared counter past 255, feed the
frame with the byte the camera really echoes, assert it is **accepted**; and
first assert against the real codec that a handle above 255 is truncated at
all.

That second half is the load-bearing one. The existing contamination tests
build a `BaichuanFrame` object directly, so the encode/decode round trip — the
only place the truncation happens — never ran, and they were green throughout.
A fake that skips the transformation under test is this repo's most repeated
blind spot (see the working-style note in CLAUDE.md); here it hid a total
failure of the feature for a day.

Nothing guards the wider rule. Review only, which is worth writing down.
