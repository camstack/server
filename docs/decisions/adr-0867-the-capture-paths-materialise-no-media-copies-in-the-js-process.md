---
id: D867
title: The per-track capture paths materialise no media copies in the JS process
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-media-dispatcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/native-frame-transport.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/keyframe-crop.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/shared/frame/box-drawer.ts
  - packages/addon-post-analysis/src/shared/frame/encode-crop.ts
  - packages/system/src/kernel/gc-census.ts
  - packages/system/src/kernel/heap-watch.ts
---

## Context

Measured passively on the live hub: `pipeline-analytics` RSS 540-880 MB, about
48 MB/s of freshly faulted pages, one to two FULL GCs a second by day, `heapTotal`
330-376 MB for 160-215 MB live, and glibc retaining 100-240 MB. The GC was driven
by external-memory pressure, not by a filling heap: the cause is media `Buffer`
churn on the per-track capture paths, each of which materialised a copy of a
surface that already had a private owner. Raising a limit or tuning malloc would
have hidden it and kept the cost (the standing rule: memory ceilings are patches,
remove the allocation).

What each site was doing:

- `resolvePinnedFrame` and the un-pinned batch path copied the decoded <=640 RGB
  frame (`Buffer.from`), although `getRemoteFrame` is the transport's full-frame
  fetch and the buffer it returns is allocated per call and read by every
  consumer — 0.66 MB per captured frame.
- The boxed timeline tiles (`firstFrame`/`snapshot`/`lastFrame` and their clean
  twin) fetched the 960 px frame, DECODED the runner's JPEG to RGB in JS
  (`cropReplyToRgb`), drew, and re-encoded — for a destination that is a stored
  JPEG. 3.2 MB of buffers per tile pair.
- Key frames travelled `MediaStore` -> `file.base64` -> `sharp(Buffer.from(base64))`
  -> RGB -> a defensive `Buffer.from(rgb.bytes)` copy: a 0.4-0.8 MB string, its
  decode, the RGB surface (6.2 MB at 1920 wide) and a copy of it.
- `rankIdentities` / `assignUniquePerFrame` / `enrollmentPromiscuity` wrapped
  every gallery vector in `new Float32Array(s.embedding)` on every probe: about
  3200 samples x 2 KB = 6.5 MB of garbage per probe.

## Decision

A per-track capture path never copies a buffer it owns, never decodes to RGB in
JS a frame whose destination is a stored JPEG, and never builds a base64 string
for a reader in the same process.

1. A fetched frame is private to its caller: no `Buffer.from` of it.
2. A consumer that only re-encodes (boxed tiles) receives the wire JPEG
   (`getNativeFullFrameJpeg`) and draws + encodes in ONE libvips pipeline
   (`drawBoxedJpeg`); the RGB path stays for consumers that need pixels
   (the display-crop fallback, the debug crop).
3. In-process media reads use `MediaStore.getBytesById`; `getById` (base64) is
   for callers that cross a wire. Across addons the rule is unchanged: a ticket
   from `ctx.peerBytes` (D613), never a base64 field.
4. The face gallery is held once as `Float32Array` (built when the gallery
   loads) and scored by identity; a plain array is still accepted and wrapped
   per comparison, with bit-identical scores.
5. `sharp` takes the `Uint8Array` as is — no `Buffer.from` in front of it.

## Consequences

Measured by `capture-path-allocations.spec.ts` (bytes materialised in the
process, 8 rounds, counted not sampled):

| path | before | after |
| --- | --- | --- |
| boxed tile 960x540 (tile + clean twin) | 25.37 MB | 1.45 MB |
| keyframe crop 1920x1080 | 105.33 MB | 47.46 MB (the RGB decode that remains is the crop's input) |
| pinned 640x360 frame | 5.27 MB | 0 |
| face probe, 3200 samples | 50.02 MB | 0.02 MB |

The tile now exists as RGB only inside libvips. `getNativeFullFrameJpeg` is also
a raw native fetch for `native-fetch-guard.spec.ts`: the dispatcher's allow-list
is 3, not 2. The un-boxed 640 fallback and the display-crop fallback still
decode to RGB, on purpose.

Diagnostics added, passive: the GC census line carries the V8 trigger flag names
(`gcFlags=ALL_EXTERNAL_MEMORY:12,...`), the first `[mem]` line after boot names
every V8 space (the 415 MB boot floor needs attributing — not fixed here), and
the `analytics resident heartbeat` carries `mapSizes`.

### Passive verification plan (after the next `@camstack/server` + addon deploy)

On `[mem] hub/pipeline-analytics`, over a day-time window against a day of the
old build: major/minor GC ratio (`gc=majN/minM`, `gcMajPerMin`) down, and
`gcFlags=` no longer dominated by `ALL_EXTERNAL_MEMORY`; `minflt/s` from
`/proc/<pid>/stat` under 5 000/s (was about 48 MB/s of fresh pages); `external`
and `arrayBuffers` day peaks; `RssAnon` from `/proc/<pid>/status`. No profile or
heap snapshot on a live runner.

## Enforcement

`capture-path-allocations.spec.ts` (current path allocates a fraction of the
removed one), `event-media-dispatcher-jpeg-tiles.spec.ts` (no RGB fetch for a
tile; pinned frame is the fetched buffer by identity),
`face-matcher-gallery-float32.spec.ts` (the gallery vector reaches the scorer by
identity; scores bit-identical), `keyframe-crop.spec.ts` (bytes and surface are
not copied), `media-store-bytes-read.spec.ts`, `gc-census.spec.ts`,
`heap-watch-first-line-spaces.spec.ts`, and the count-exact
`native-fetch-guard.spec.ts`.
