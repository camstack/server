---
id: D211
title: A timelapse runs on ONE declared clock — selected frames are retimed on the output grid, pass-1 concatenation uses the mapped durations, and the delivered file is measured against the plan
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/export-ffmpeg-args.ts
  - packages/addon-pipeline/src/recorder/addon/export-source-playlist.ts
  - packages/addon-post-analysis/src/notification-center/timelapse/pacing-check.ts
  - packages/addon-post-analysis/src/notification-center/timelapse/mp4-duration.ts
---

## Context

The scheduled timelapse chain already had one clock lesson on record: dense
ranges are stated in wall time and ffmpeg's `t` runs over the concatenation, so
the recorder maps one into the other (`export-dense-map.ts`, born of export
`57d14363`). The night of 2026-08-20→21 proved the mapping was necessary but
not sufficient, twice, on the same delivered file (export `3a62ec17`, camera
101, rule "Timelapse front door"):

- **The output grid was the input's.** The select filter's retiming was
  `setpts=N/FRAME_RATE/TB` — `FRAME_RATE` is the INPUT stream's nominal rate
  (25 fps here), so the frames `select` kept were parked on a 25 fps grid and
  the trailing `fps=12` decimated ~52% of them, blindly, dense and base alike.
  Delivered: 594 frames where the plan selected ~1250; base cadence 60 s
  instead of 30, dense 2–3 s instead of 1. Reproduced offline through the
  exact argv: 19 frames out of a 40-frame plan; with the output grid, 40/40.
- **Two summations of "how much footage precedes this instant" disagreed.**
  The dense map sums the segments' DECLARED `durMs`; pass 1 fed the HLS
  demuxer, which stitches segments by their CONTENT length. Real segments
  disagree with their declared duration (one measured `durMs=11000` against an
  11.95 s PTS span), the disagreement is cumulative, and by the end of the
  10 h night the two clocks were ~495 s apart — so the 31 s dense range for
  the 06:26 person fired over 06:18, footage that held nothing.

Both defects were invisible from the log, which reported the PLAN
(`timelapse produced … denseRanges=9 detections=13`) and never the file. The
first diagnosis — "the planner missed the detection" — was wrong: both stores
(tracks and object events) and the plan were correct to the second.

## Decision

Three rules, one per layer:

1. A timelapse `select` chain retimes kept frames on the OUTPUT fps grid —
   `setpts=N/(<outputFps>*TB)` — never on the input's `FRAME_RATE`. A trailing
   `fps` filter may pin CFR metadata but must be an identity pass.
2. Timelapse pass-1 concatenation reads the export's FFCONCAT list
   (`<exportId>.src.ffconcat`, `-f concat -safe 0`), whose `duration` lines
   carry the SAME `durMs` values `export-dense-map.ts` sums. The two sides of
   the wall→stream translation must be the same numbers by construction; any
   per-segment declared/actual mismatch stays bounded and non-cumulative.
3. Every scheduled timelapse render is followed by a PACING CHECK that
   measures the delivered file (its mvhd duration, read from the bytes the
   publisher already fetches) against the exact plan the render used — same
   ranges, same availability rows, same cadences, one authority. A detection
   window that received no slowdown is a WARN with `tags:{deviceId}` naming
   who, when and how many frames were owed. The check is best-effort and
   bounded: it never fails or delays a window beyond its timeout.

## Consequences

- The m3u8 source playlist remains for non-timelapse exports; timelapse
  renders now write (and clean up) a sibling ffconcat file per export.
- The check costs one extra `readExportBytes` per window per night, bounded at
  20 s, and is wired through an optional renderer port — a wiring without it
  logs the skip rather than silently not checking.
- A recorder change that reintroduces a second clock (or a decimating filter
  stage) will surface as `timelapse pacing check: …` WARNs on the next
  scheduled window, not as an operator report weeks later.

## Enforcement

- `export-ffmpeg-args.spec.ts` asserts the output-grid retiming (and that
  `FRAME_RATE` never appears) and the concat-demuxer argv; `buildExportConcatList`
  is asserted to emit the mapped `durMs` values.
- `pacing-check.spec.ts` pins the verdict against the real numbers of the
  2026-08-21 delivery (594 frames / ~1250 planned ⇒ `no-slowdown`).
- The check itself is the runtime guard: a regression WARNs nightly in the hub
  log with the device tag.
