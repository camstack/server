---
id: D471
title: A pixel coordinate is an integer, and a trajectory is stored compressed
status: accepted
date: 2026-09-12
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/position-codec.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
---

## Context

The hub's settings database is 1 117 MB. Attributed per table and per column,
on a COPY of the live file (never the live file — see D468):

| | MB | % |
| --- | --- | --- |
| `pipeline-analytics:tracks` | 211.6 | 19.0 |
| `pipeline-analytics:media` (+139 MB of indexes) | 135.2 | 12.1 |
| `pipeline-analytics:motion-events` (+115 MB) | 126.1 | 11.3 |
| `recorder:segment-hours` | 66.1 | 5.9 |

Within `tracks`, **`positions` is 94.9 %** — 186.5 MB over 30 459 rows, 162
bytes per position. And a position looked like this:

```
{"x":2827.2000000000003,"y":611.4,"timestamp":1788253537934,
 "bbox":{"x":2725.2000000000003,"y":394.8,"w":204,"h":433.2}}
```

Eighteen characters for a coordinate in PIXELS. Not precision — the float tail
of a number with no exact binary representation, serialised in full and
persisted 1.7 million times. Field names, the first hypothesis, are only 27 B
of the 162.

Measured over 20 130 real positions and projected onto the table:

| | MB | |
| --- | --- | --- |
| as stored | 186 | |
| rounded to integers | 136 | −27 % |
| base64(gzip) | 35 | −81 % |
| **both** | **29** | **−84 %** |

## Decision

Positions are **rounded to integers** and stored **gzipped** (base64 inside the
existing JSON column). One codec, `position-codec.ts`, owns both directions.

**No migration.** `decodePositions` reads all three shapes that reach it — the
`z1:` string this writes, a plain array (the column parsed for us), a plain
JSON string (it was not) — so a row converts itself the next time it is
written, and a row that never is stays readable forever.

## Consequences

- **Rounding is safe only because of D399.** Before it, the ONLY way to tell a
  full-frame box from a native-resolution recovery box was that full-frame
  boxes are exact multiples of 1.2 while recovery boxes are full-precision
  floats. `TrackPosition.source` now says it outright, so the fractional part
  carries nothing. Had this been done a release earlier it would have destroyed
  a signal with no test to notice.
- **base64, one day after D462 removed it.** Column types are
  `TEXT | INTEGER | REAL | JSON | BOOLEAN` — there is no BLOB, and teaching the
  settings backend one is not worth doing in the subsystem that caused a
  six-hour outage the same morning (D468). It costs ~9 MB against raw bytes and
  still leaves the column five times smaller. D462's base64 was pure overhead
  on a wire that could carry bytes; this one buys 5× on a wire that cannot.
- **A malformed stored value decodes to an EMPTY trail, never a throw.** The
  timeline then draws a track with no path — which an operator can see — rather
  than failing the page, which they cannot.
- `observations` still counts the same array in the same statement, so the
  column cannot disagree with the blob it describes.

## Enforcement

`position-codec.spec.ts` (10 tests) pins the round-trip, the three input
shapes, and that garbage is empty rather than fatal.

`zone-test-reads-encoded-positions.spec.ts` exists because of the branch this
change would otherwise have broken in SILENCE. `rowMatchesZone` opened with
`if (!Array.isArray(positions)) return true` — "cannot be tested, pass" — so an
encoded column would have turned the server-side zone prefilter OFF while every
symptom said it was on: the timeline would simply show more tracks than the
drawn zone contains, which nobody reads as a bug. **Nothing in the 6 105-test
suite failed when the encoder was wired in.** The new spec is disarm-checked:
restoring `Array.isArray` turns it red.
