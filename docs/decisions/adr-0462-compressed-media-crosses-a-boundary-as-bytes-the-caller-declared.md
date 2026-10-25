---
id: D462
title: Compressed media crosses a process boundary as bytes, and the CALLER declares it
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - packages/types/src/capabilities/pipeline-runner.cap.ts
  - packages/addon-pipeline/src/pipeline-runner/on-demand-retention.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/native-frame-transport.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/parked-frame-client.ts
---

## Context

D461 removed the audio relay leg and the hub's byte count fell as projected.
The next reading of `[mem] hub-main` said the audio legs had never been the
largest thing on the plane:

```
pipeline-analytics!pipeline-runner.getNativeCrop       224078kB/219 : r85/d134
pipeline-analytics!pipeline-runner.getParkedTrackFrame 179445kB/70  : r0/d70
pipeline-analytics!snapshot.getSnapshot                 89828kB/62  : r61/d0
```

Four hundred megabytes a minute of already-compressed JPEG, an order of
magnitude above the ~49 MB/min leg D461 had just deleted.

**The `r`/`d` split is what makes this actionable, and it did not exist before
D456.** `r` counts forwards the parent never read; `d` counts the ones it
decoded. `getSnapshot` is 61 of 62 RAW — those megabytes are copied through and
never enter hub-main's heap. `getNativeCrop` is the opposite: 134 of 219
DECODED, and `getParkedTrackFrame` is 70 of 70. On each of those the relay
materialises the payload, and the payload is a **base64 string of 1.8–2.5 MB**.
That is a multi-megabyte old-space allocation several times a second, in the
one process whose `oldSpace` had been measured at 1041 MB.

The first hypothesis was that the crops were too big — a "crop" weighing 1.8 MB
sounds like an over-fetch. It is not: these are `keyFrame` captures at native
resolution with a full-frame bbox and no `maxWidth`, which is what D400 asks
for. Nothing about the MEDIA is wrong. What is wrong is the container.

The consumer's very next statement was `Buffer.from(reply.jpeg, 'base64')`.
Nothing on either side wanted a string. It existed because the schema said
`z.string()`, and the transport was never the obstacle — `NativeCropResult`
has carried `bytes: z.instanceof(Uint8Array)` across this same boundary all
along.

## Decision

Compressed media travels as `Uint8Array`, and **the caller declares that it can
read bytes** (`acceptJpegBytes`). A producer answers `jpegBytes` only to a
caller that asked; a caller that says nothing gets the base64 it always got.
`encodeCrossNodeCrop` is the one place the choice is made, it takes the JPEG's
BYTES, and an ABSENT declaration is never read as consent.

Two fields, exactly one populated — not both. Populating both would pay the
base64 cost that is the entire point of removing.

## Consequences

- A pre-D462 consumer is untouched: it sends no flag and its wire is
  byte-identical. This is what makes the change shippable in ONE release
  instead of the usual two-step, and it is the same shape as D455's audio
  `accept` negotiation rather than a new idiom.
- `ParkedTrackFrame.jpeg` becomes OPTIONAL. A consumer must read both fields
  and treat neither-present as a loss it NAMES — `parked-frame-client` logs it
  with the `deviceId` rather than throwing on `undefined`.
- Two INTERNAL callers were base64-ing and immediately decoding for a round
  trip that never left the process (the park encode, and the same-process
  detail crop). They now ask for bytes. That saving needs no deploy agreement
  with anyone.
- `decodeJpegToRgb` accepts `string | Uint8Array`. Widening it is what lets the
  caller stop encoding purely to be understood.
- **The park store is still typed `Buffer` end to end**, and
  `Buffer<ArrayBufferLike>` is not assignable to the schema's
  `Uint8Array<ArrayBuffer>`, so `getParkedTrackFrame` pays one native memcpy
  (`new Uint8Array(buf)` — never `Uint8Array.from`, which walks the buffer
  element by element). Retyping that chain would remove even that.
- **`IPipelineRunnerProvider` is declared TWICE** — `InferProvider` in the cap
  file, and a hand-written interface in `interfaces/pipeline-runner-capability.ts`
  which is the one consumers import. Adding a field to the cap alone compiles
  and is invisible; this cost an hour of chasing a "stale dist" that was not
  stale. Both must be edited until one of them is deleted.
- This is a cap-shape change: it reaches a node only inside a published
  `@camstack/server` (D16).

## Enforcement

`cross-node-crop-bytes.spec.ts` pins all four arms of the negotiation,
including that an absent declaration is the old wire; `parked-frame-client.spec.ts`
pins `acceptJpegBytes` as part of the REQUEST rather than an implementation
detail. Nothing yet stops a NEW base64 image field being added to a cap — the
`@dbfs-era` guard from D460 is the model for one, and it is not written.
