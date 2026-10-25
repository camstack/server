---
id: D353
title: A debug note belongs to the TRACK and lives and dies with the flag it explains
status: accepted
date: 2026-09-05
supersedes:
applies-to:
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-flags.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
---

## Context

The operator asked for the debug flag to carry a note — "what should be checked
here" — because the flag on its own says *look at this* and nothing about what
for, and a debug set reviewed hours later is a list of tracks with no question
attached.

**It was built in the wrong place first.** The note was added to the viewer's
GLOBAL `advanced.debugMode` switch (Settings → Advanced, viewer commit
`a091fac`): one note per app install, stored in the settings document, re-stated
into the shipped log bundle on every boot. That is a note about a SESSION, and
the thing it was meant to annotate is an EVENT. The operator's verdict was
immediate: "il debug è completamente sbagliato, andava messo sul pulsante di
debug per traccia". The global version and its five i18n keys were removed.

The per-track flag is written from three surfaces that do not know about each
other (admin Events grid, viewer track detail, viewer cluster detail), only one
of which has any note UI at all. So the question is not only *where the note is
stored* but *who owns the invariant that a note without a flag is meaningless*.

## Decision

`debugNote` is a column on the TRACK row, beside `debug`, written through the
single existing cap method `pipelineAnalytics.setTrackFlags`, and the hub — not
any surface — owns its coupling to the flag:

- a patch carrying `debug: false` CLEARS the note in the same statement,
  whatever the caller sent with it;
- a patch carrying a note for a track whose debug is off, and is not being
  turned on, is DROPPED and logged (`tags: { deviceId }`);
- an OMITTED `debugNote` leaves the stored one alone, which is what lets a
  surface turn debug on when the operator declined to type anything.

The bound (`MAX_TRACK_DEBUG_NOTE_LEN`, 500) is on the Zod schema at the wire,
not on a `TextInput`.

The viewer sends the flag and the note as two separate patches, in that order:
the flag write is dispatched BEFORE the prompt opens, so refusing to write a
note cannot cost the operator the flag they asked for. Editing the note later is
a long press on the lit button — without it the only way to change a note would
be the off/on cycle that clears the note being changed.

## Consequences

- The note is per-track state and it ages out with the track. It is not a
  durability pin: `debug` never pinned and this does not change that.
- A track can never present a note without the flag that explains it, on any
  surface, including ones written later that never think about the rule.
- Two round trips for "flag it and say why". That is the price of the ordering
  rule above, and it buys the guarantee structurally rather than by comment.
- The column is `TEXT` NULLABLE with no default, like `debug`: a row written
  before the column reads back ABSENT, never as an empty note somebody typed.
- `TrackFlagsSchema` gained a REQUIRED `debugNote` (absent resolves to `''`).
  The viewer's `toTrackFlagsResult` deliberately does NOT reject an answer that
  omits it — the field is additive, and refusing the answer would break all
  three toggles against every hub not yet updated.

## Enforcement

Tests, at three levels:
`packages/types/src/__tests__/track-flags-schema.spec.ts` (the wire bound and
the required/optional split), `.../pipeline/__tests__/track-flags.spec.ts` (the
clear-on-off, the drop-and-log, the cancelled prompt costing nothing),
`.../store/__tests__/track-flags.spec.ts` (persistence, including the
expiry-time persist of a note typed on a live track), and, in the viewer,
`src/components/events/track/__tests__/track-debug-note.spec.ts`, which mounts
the real buttons against a hub stub that mirrors the clear-on-off invariant.

No guard script: the rule is about one cap body, and the tests above fail on
every way of breaking it that has been thought of.
