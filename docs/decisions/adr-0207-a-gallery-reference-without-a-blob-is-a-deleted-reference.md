---
id: D207
title: A gallery reference whose blob is not on the filesystem is a deleted reference
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retention/gallery-reconcile.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
---

## Context

The 2026-08-17 recordings-volume wipe destroyed the pixels of 28 of 32 enrolled
face samples while their rows survived, keys intact. The boot relocate (D197)
was then written to REPORT those rows but leave them standing, on the theory
that a pixel-less embedding still matches. The theory aged badly the moment the
cluster face model became flippable (D199): a pixel-less row can never be
re-embedded, so it strands on every model change, drags the operator-facing
`unrecoverable` count around forever, and blocks the auto-reembed loop's
convergence signal. Meanwhile nothing in the system ever collected it — the
orphan audit exempts identity media by design (deleting a LIVE sample because
its track aged out would degrade recognition, which is a different failure
entirely). Three days of "cannot show the face" silently meaning "cannot
recognise the person after the next flip" is what forced the operator's rule.

## Decision

When the media reconcile runs, it also walks the enrolled gallery: a sample
whose `mediaKey` resolves to no blob on the filesystem (row gone, or row
present and file gone) is a DELETED sample — the reference is removed through
the same path the operator's delete uses (blob cleanup, row, cover heal). Four
bounds make this survivable: a grace window (a fresh write race is not a wipe),
abort-on-probe-error (an unreachable volume must never read as "all missing"),
a per-run reclaim ceiling, and keyless rows are counted, never touched.

## Consequences

The gallery can no longer accumulate dead references — but it also means a
blob deleted by hand IS a sample deletion, deliberately. The relocate pass's
`missing` count is now a pre-collection report, not a standing state; the log
line names each removed reference with its identity. Anything that wants to
keep a vector without pixels (there is no such consumer today) would have to
argue with this record first.
