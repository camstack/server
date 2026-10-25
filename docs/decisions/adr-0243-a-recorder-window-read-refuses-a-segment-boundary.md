---
id: D243
title: A recorder window read refuses at a segment boundary, never splices
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/mfra-index.ts
  - packages/addon-pipeline/src/recorder/gop-range-read.ts
  - packages/addon-pipeline/src/recorder/addon/recording-provider.ts
  - packages/types/src/capabilities/recording.cap.ts
  - packages/addon-benchmark/src/benchmark-addon.ts
---

## Context

The replay clip's `recording` source (`docs/design/plans/2026-08-26-clip-replay-on-pipeline.md`)
needed `(deviceId, fromMs, toMs, profile) → bytes` — a WINDOW, not the single
instant `RecordedStillPorts`/`readGopBytes` already answer. The recorder
stores footage as one self-initializing fMP4 file per segment (~60 s):
`ftyp`+`moov` head, then a sequence of `moof`+`mdat` fragments, each
independently decodable, each segment its OWN init.

Two ways to answer a window that runs past its covering segment: (a) fetch
the covering bytes from the SECOND segment too and concatenate, or (b)
refuse and name why. (a) was not attempted — concatenating two files that
each carry their own `ftyp`+`moov` into one byte stream and feeding it to
ffmpeg via `-i pipe:0` is not something this repo's mov demuxer has ever
been asked to do, and nothing here proves it decodes as one continuous
timeline rather than erroring or silently dropping the second file. Building
and testing that mechanism was out of scope for wiring a gap in a feature
whose real cases (10-30 s replay windows) fit inside one ~60 s segment
essentially always.

## Decision

A window read (`recording.readWindowBytes`, `readGopWindowRange`,
`fragmentsInWindow`) answers ONLY from the ONE segment its `startMs` names.
When the requested `toMs` runs past that segment's own end, the read
REFUSES (`{ kind: 'spans-multiple-segments', segmentEndMs }`) rather than
degrading to a shorter answer or attempting to splice a second segment's
bytes in. The caller (the replay's `fetchReplaySourceBytes`) turns this into
a named, human-readable refusal reason, the same shape a preflight or an
empty frame-plan already refuses with — never a generic thrown error.

Within one segment, the walk stops on a TIME condition (the next fragment's
own start reaching `toMs`), with a byte cap only as a safety ceiling — never
the primary stop condition, so a well-formed window is never silently
truncated without the caller being told (`reachesRequestedEnd: false`).

## Consequences

- A replay window that happens to straddle a segment boundary (rare, given
  segment length vs. typical window length) is refused instead of served —
  the operator sees "shorten the window or align it to one segment", not a
  silently-shorter or silently-wrong clip.
- If a future window use case genuinely needs multi-segment spans (a much
  longer replay, or segments shrunk well below today's ~60 s), this decision
  is the one to revisit — and it should start with proving ffmpeg can
  actually decode two concatenated fMP4 files from one pipe before building
  around the assumption that it can.
- The single-segment constraint is enforced at the CALLER's read (compare
  `toMs` against the segment's own `startMs + durMs`), not at the mfra/moov
  parse level — `fragmentsInWindow` itself has no opinion on segment
  boundaries, it just walks a `tfra` table.

## Enforcement

Nothing automatic — a guard here would need to know what "one segment"
means at the call site, and the two callers of `readGopWindowRange` (this
module's own `readWindowBytes` handler) already encode the check inline.
Covered by test: `packages/addon-pipeline/src/recorder/addon/__tests__/recording-provider.spec.ts`
("REFUSES a window that runs past the covering segment").
