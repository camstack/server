---
id: D405
title: The review ARCHIVES the note it clears — the corpus outlives the track
status: accepted
date: 2026-09-08
supersedes: D353
applies-to:
  - packages/types/src/interfaces/debug-note-archive.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/archive-debug-note.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/debug-note-archive-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-flags.ts
---

## Context

D353 put `debugNote` on the track row beside `debug` and gave the hub one
invariant: **a patch carrying `debug: false` clears the note in the same
statement.** That invariant is correct and is not in question here — a track
that presents a question without the flag that explains it is a leftover
reading as a live request, on surfaces (the admin Events grid) that have no
note UI and would never think to clear it.

What was wrong was the mechanism, not the invariant: the clear was a DELETE.

The viewer's "Analizzata" button sends exactly `debug: false`. So finishing a
review destroyed every note written during it. Measured on 2026-09-08:
deriving the debug-modal preset list from real notes could only read the 11
marks still open that afternoon — the 25–27 notes from that morning's sweep
were already gone. **The corpus this product needs in order to learn what keeps
going wrong was being erased by the act of reviewing it.**

And even a note nobody reviewed did not last: `debug` deliberately does not pin
against retention (D353, D81 — it is attention, not durability), so the column
ages out with its track. Both halves of the loss had the same shape — the note
was stored as an attribute of something transient.

Two alternatives were rejected before this one:

- **Stop clearing the note.** This is the obvious fix and it breaks D353's
  invariant for every surface written afterwards. Rejected: the invariant is
  the thing keeping a debug set readable.
- **Pin the track that carries a note.** Turns a diagnostic mark into a
  durability bit — the exact asymmetry D81 built the staging budget to contain
  — and makes the corpus cost megabytes of 4K keyframes per remembered
  sentence, to keep 500 characters of text.

## Decision

**On review, a debug note is not deleted — it is ARCHIVED, and the archive
outlives the track.**

- `debug: false` still clears `debugNote` from the track row, in the same
  statement, whatever the caller sent. D353's invariant survives literally and
  is not weakened anywhere. What is superseded is only D353's *"it lives and
  DIES with the flag"* — it still dies **on the row**; it no longer dies.
- Before the clear, `applyTrackFlags` APPENDS the note to
  `pipeline-analytics:debug-note-archive`, carrying the text, `deviceId`,
  `sourceTrackId`, the track's `firstSeen` / class / display label as the row
  it just read already knew them, and the ms-epoch of the archiving. The
  archive is written from the note's OWN read — no second store round trip.
- The archive is **not** a track row and **not** subject to track retention.
  It is classified `never-orphaned` by hand, and its track column is named
  `sourceTrackId` rather than `trackId` precisely so the ownership derivation
  in `collection-classification.ts` cannot see it and cascade the corpus away
  with the tracks it describes. The name is the honest one: provenance, not a
  live reference.
- **Bound: `MAX_ARCHIVED_DEBUG_NOTES = 5000` rows, fleet-wide, oldest
  `archivedAt` evicted first, trimmed on append.** Global rather than
  per-device because the corpus is only ever mined fleet-wide ("what keeps
  going wrong", not "what goes wrong on 102"), and a per-device bound
  multiplies the ceiling by the fleet. A COUNT rather than an age because an
  age clock would delete a note for being old, and an old note is the most
  valuable row in the table — the pattern it describes has had time to repeat.
  The number is sized off the measured rate: one sweep produced 25–27 notes,
  so call a heavy day 100; 5 000 is ~50 such days and, at a few sweeps a week,
  several years. Cost at the ceiling is ~3 MB of text (a note is capped at
  `MAX_TRACK_DEBUG_NOTE_LEN` = 500 chars, metadata under 100 bytes), against a
  `tracks` table measured at 4.6 MB for one 501-row page.
- **An empty note archives nothing**, and archiving is **idempotent per
  `(sourceTrackId, note)`**: the row id is `sha256(trackId ' ' note)`
  truncated to 128 bits, so the primary key itself refuses the duplicate and
  reviewing twice cannot double the corpus. Idempotency from a derived key
  rather than a read-modify-write, which two concurrent reviews could
  interleave through.
- The corpus is readable: `pipelineAnalytics.listArchivedDebugNotes` —
  newest-first, optional `deviceId`, `limit` (default 200). `auth: 'protected'`,
  matching `setTrackFlags` next door: the notes are written from the viewer by
  an authenticated non-admin session, and a corpus only an admin can read is a
  corpus the person who wrote it cannot use.

**How this fails, stated once.** The archive is this system's bookkeeping; the
flag is what the operator pressed. So a failing archive write **never blocks
the flag write and is never retried** — the button does what it says even when
SQLite is busy, and the caller is a synchronous cap method someone is waiting
on. What it must not do is lose the sentence quietly: the failure line is
`logger.error`, carries the **note text verbatim** plus `tags: { deviceId }`
and the trackId, and the words are recoverable from the log by hand. The
`append` itself therefore THROWS rather than swallowing (unlike the ops-log's
best-effort append) — only the caller holds the text and the camera, so only
the caller can preserve them. The TRIM is the one best-effort part: the row has
already landed, and failing an append because housekeeping could not run would
report a note lost that is sitting in the table.

## Consequences

- One extra round trip on the clear path (an existence check, then an insert),
  paid only when a reviewed track actually carried a note. Nothing on the
  frame path, nothing per-device, nothing on a timer.
- `ResolvedTrackFlags` grew three OPTIONAL read-only context fields
  (`startedAt`, `className`, `label`). They are not flags and nothing writes
  them; they exist so archiving needs no second read. A row that never knew one
  omits it and the archive stores `null` — an absence must never be rendered as
  a value.
- The archive triggers on any patch that CLEARS a standing note, not only on
  `debug: false`. An operator who empties the note box is destroying words too,
  and the same table should keep them. Editing a note to a DIFFERENT value does
  not archive the previous one: that is an author revising their own sentence
  before filing it, not a review retiring it.
- Something now has to be true elsewhere: this table must never acquire an age
  sweep, and must never be routed through `derived(...)` in
  `collection-classification.ts`. Both would silently restore the exact loss
  this record exists to end.
- The archive is not a durability pin on anything. The track a note names is
  expected to be gone, and the row is deliberately unable to bring it back —
  it keeps the sentence and enough context to identify the moment, never the
  media.

## Enforcement

Tests, at both levels, plus two existing guards that now cover the table:

- `.../pipeline/__tests__/archive-debug-note.spec.ts` — the note reaches the
  archive BEFORE the row is written, the clear still happens, an empty note
  archives nothing, and a FAILING archive costs neither the flag write nor the
  words (the note text is asserted present in an `error` line tagged with the
  camera).
- `.../store/__tests__/debug-note-archive-store.spec.ts` — idempotency per
  `(track, note)`, a second note on the same track kept, the same sentence on a
  different track kept, the count bound evicting oldest-first, a failed trim
  leaving the landed row, and the newest-first / device-filter / limit read.
- `scripts/check-age-keyed-retention.ts` already refuses a new age-keyed delete
  under `pipeline-analytics/store/` and refuses an unclassified collection, so
  the two ways of undoing this are caught rather than reviewed.

No new guard script. The rules here are about one cap body and one store, and
the two guards above already cover the structural half.
