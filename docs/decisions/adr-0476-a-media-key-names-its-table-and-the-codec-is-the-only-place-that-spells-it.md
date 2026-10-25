---
id: D476
title: A media key names its table, and the codec is the only place that spells it
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/types/src/media/media-owner-key.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/analytics-query-facade.ts
  - packages/addon-post-analysis/src/pipeline-analytics/event-thumbnail-resolver.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-shared.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/motion-event-snapshot.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-media-dispatcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/disk-reconcile.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/location-discard-job.ts
  - packages/addon-post-analysis/src/pipeline-analytics/training-export/dataset-plan.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/ui-library/src/composites/cap-settings/RecordingTimeline.tsx
  - packages/ui-library/src/composites/cap-settings/EventBucketStrip.tsx
  - packages/addon-admin-ui/src/components/detection-intelligence/StationarySection.tsx
last-verified: 2026-10-04
---

## Context

A media key addresses a file by its owner: `<ownerType>:<ownerId>:<fileKind>[:<timestampMs>]`.
Every owner type is a TABLE — `track`, `summary`, `face`, `identity`, `plate`,
`vehicle`, `scene` — except `event`, which named three tables at once (motion,
object, audio). That was safe while event ids were UUIDs, unique across
tables. D474 made an event id a SQLite rowid alias, so each table numbers its
rows from 1 independently: `motion:5` and `object:5` are different rows that
both spell `5`. `event:5` stopped naming one row.

The concrete break, found first: `EventStore.getTrackIdForEvent` resolved a
media key's owning track by probing the object-events table and reading a
MISS as "not an object event" — its own docblock named motion and audio as
the misses it relied on. A HIT is no longer proof either: a motion id that
happens to equal a live object id now resolves to that object's track. Wrong
thumbnail, not an error — the failure mode this whole record exists to close
off, because it produces no log line and no exception, only a picture that
does not belong to the row it is shown on.

`packages/types/src/media/media-owner-key.ts` (`MEDIA_OWNER_TYPES`,
`MediaOwnerKey`, `parseMediaOwnerKey`, `formatMediaOwnerKey`,
`EVENT_OWNER_TYPES`, `isEventOwnerType`) already existed before this session,
written and unit-tested (16 tests) but not wired anywhere: `MediaStore`,
`EventStore`, the addon's media resolvers, the UI, and the notification
dispatcher all still spelled the key or its parts by hand, most still naming
`event` as if it were one table. A live-DB data migration (proven on a 1.09 GB
copy: 99 s, 528 559/528 559 rows re-derived from `id = buildKey(...)`, 676
pre-existing orphans left alone) rewrites every resolvable `media` row's
`ownerKind`/`ownerId`/`id` to the split table before this lands — this record
covers the CODE side: routing every reader and writer through the codec so
the migration's target state (no row with `ownerKind = 'event'` except the
676 unreachable orphans) is what the running addon actually expects.

## Decision

**`event` is retired as a media owner kind.** `MediaStore.OWNER_KINDS` (the
authority on what may own media) drops it and gains `motion` / `object` /
`audio`; `@camstack/types`' `MEDIA_OWNER_TYPES` must always be a superset —
enforced by a new guard,
`packages/addon-post-analysis/src/pipeline-analytics/store/__tests__/owner-kinds-authority.spec.ts`.
Every site that built or read a media key by string template now goes through
`formatMediaOwnerKey` / `parseMediaOwnerKey`, or — where the value in hand is
an `OwnerKind` already — passes it straight through rather than re-spelling
it.

**A caller that does not know an event's kind probes `EVENT_OWNER_TYPES` in
order and stops at the first hit** (`readEventThumbnail`,
`AnalyticsQueryFacade.getEventMedia` / `listEventMedia`). This is the shape
the codec's own docblock names it for. It is honest, not exact: a bare id can
still coincidentally exist in two tables, and the probe picks the first
(`motion` → `object` → `audio`). The alternative — refuse to serve until the
kind is known — would blank tiles that render correctly today under the old
`event` scheme; the residual ambiguity is accepted and this paragraph is
where it is written down.

**`getTrackIdForEvent` keeps probing `OBJECT_EVENTS_COLLECTION` only** (only
an object event has a `trackId` column) and gains an optional `ownerType`
parameter: when a caller already knows the kind and it is not `'object'`, the
method returns `null` without querying — "restrict the lookup to object
keys", the alternative the task offered where "pass the owner type" is not
available. Its one real caller (`readEventThumbnail`) still reaches it with a
bare, kind-less id from a URL and cannot supply the parameter; that caller's
own event-files probe (above) is what shrinks how often the ambiguous path is
even taken, by routing every caller that DOES know the kind through an
explicit `motion:`/`object:`/`audio:` key instead of a bare id.

**`MediaStore.deleteForEvents` takes ids GROUPED by table, not a flat
list.** `deleteForOwner` needs one owner kind per call, and a flat id list
can no longer say which table an id belongs to — the same ambiguity as the
read side, on the delete path, where the cost of getting it wrong is
irreversible. `EventOwnedMediaIds = Partial<Record<EventOwnerType, readonly
string[]>>`, declared next to `EventOwnedMediaDeleter` in `event-store.ts`.
Every caller already knows which table produced each id before flattening it
for the old signature — `evictTracklessBefore` reads `motion` and `audio`
separately, `deleteByTrack(s)` only ever touches `OBJECT_EVENTS_COLLECTION`,
`pruneBefore`/`pruneEvents` compute all three counts before concatenating —
so this is exposing a fact every caller already had, not asking for new
work. `EventStore.PruneBeforeResult` gained a `byKind` field alongside the
existing flat `ids` (kept for the callers that only report a count) rather
than replacing it, so `event-store-prune.spec.ts`'s existing assertions on
`ids` did not need to change.

**Every production write site now names the real owner kind**, derived from
what actually produced the id, not guessed: `captureMotionMarkerStill` /
`MotionEventSnapshotCapturer` → `motion`; `EventMediaDispatcher`'s
`faceCrop`/`plateCrop` child-crop writer (fed detection frames — bbox,
className — which only ever come from object events) → `object`; the
training-export dataset plan's per-event owner (fed
`EventStore.queryObjectByTrackIds`, object-only) → `object`; the
notification dispatcher's media-resolution ladder (fed only by
`hasEventMedia`'s two kinds, `object-event` and `package-event`, and a
package event IS an `ObjectEvent` row per `incomingFromPackageEvent`) →
`object` (`NcDispatcherDeps.getMediaForOwner`, `rule-engine.ts`'s three
kind-preference ladders, all narrowed from `'event' | 'track'` to `'object' |
'track'`); the multi-camera digest mosaic (`buildSummaryPorts.storeMosaic`,
index.ts) → `object`, though its `ownerId` is a synthetic window id and it is
not itself an object-event row — see Consequences.

**`StationarySection.tsx`'s positional `keyFrameMediaKey.split(':')[1]`
becomes `parseMediaOwnerKey(...)?.ownerId`.** Measured: every stationary key
in the field is `track:`-prefixed today, so the old code's un-prefixed
fallback (which used the WHOLE key, unparsed, as an owner id) was latent, not
broken. Fixed anyway, per instruction, and the codec is now also correct for
a key it was never observed to receive.

**`RecordingTimeline.tsx:400` / `EventBucketStrip.tsx:96` are NOT media
keys.** Both build `` `event:${clip.id}` `` but the string is consumed only
as a React `key` / a UI "which clip is loading" busy-key comparison —
`EventThumb`'s `mediaUrl` is a separate, server-stamped field, never parsed
from this string. `BucketClip.kind` (`ClipKind = 'motion' | 'object' |
'audio'`) IS available at both sites, so both were changed to
`` `${clip.kind}:${clip.id}` `` anyway: not because the grammar requires it,
but because a bare numeric id colliding across kinds could otherwise
mismatch two different clips' busy-spinners or React keys under the same
label.

**`videoclips-shared.ts`'s `MediaOwnerKind` and
`event-thumbnail-resolver.ts`'s `CropForcedOwnerKind`** — two more
hand-spelled owner unions — drop `'event'`. `MediaOwnerKind` becomes
`EventOwnerType | 'track'` (imported from `@camstack/types`, not
re-declared), and `videoclips-provider.ts`'s `resolveVouchedEvents` now
queries the media-presence probe once PER EVENT KIND that has any ids
(motion/object/audio, each only when non-empty) instead of one combined
`'event'` call for a flat cross-table id list — which is what its own
docblock already claimed ("batched once per owner kind") without actually
doing. `CropForcedOwnerKind` narrows to `'track' | 'face' | 'plate'`;
`collectCropForcedMedia` no longer lists by owner kind `'event'` itself —
`eventFiles` (the event's own media) is now fetched by the CALLER (which
knows which owner types to probe for a bare id) and handed in as a third
parameter, the same shape `collectDefaultEventMedia` already used.

## Consequences

- **`RETIRED_OWNER_KINDS` was not touched.** `'group'` remains the only
  retired-owner-kind case the read side still recognises; `'event'` is not
  added there because the migration REWRITES resolvable rows rather than
  leaving them for a read-time compatibility shim, and the 676 orphans are
  meant to stay unreadable (see D474's ADR and this record's Context).
- **The orphan audit's `OwnerRef` union keeps ONE generic `{ kind: 'event' }`
  variant for all three tables**, not three. `resolveMediaOwner` maps
  `motion`/`object`/`audio` to it identically, and the liveness probe behind
  it (`EventStore.existingEventIds`, wired as `liveEventIds`) still unions
  across all three tables — UNCHANGED behaviour from before this record, not
  a new guarantee. Post-D474 that union can answer "live" for an id that
  exists in a DIFFERENT table than the row's own, which can only make a
  truly-orphaned row look live and skip its reclaim (a storage leak), never
  the reverse (it can never cause a live row to be deleted, because a row
  whose own table entry is alive is unioned into "live" regardless of what
  else the union finds). Disambiguating this properly — a per-table liveness
  probe, `OwnerRef` split three ways — is real follow-up work, deliberately
  not done here: it touches `questionsFor`, `OrphanAuditDeps.liveEventIds`'s
  signature and its one production wiring site, for a bound that is already
  safe in direction if not in degree.
- **`disk-reconcile.ts`'s trackless-event "still has media" check** had the
  same shape: `row.ownerKind === 'event'` would now silently never match
  anything (motion/audio media is `'motion'`/`'audio'` post-migration),
  making every trackless event look like it owns no media and widening
  `doomedEvents` to all of them. Fixed to check membership in
  `EVENT_OWNER_TYPES`; the residual motion/audio id-collision risk in the
  flat `tracklessIds` list this feeds is pre-existing (that list was already
  a merge of two kinds before this record) and out of scope for the same
  reason as the orphan audit.
- **The digest mosaic's owner kind (`object`) is a pragmatic choice among
  equals, not a structural fact.** The mosaic is not an object-event row —
  its `ownerId` is a synthetic per-window string that will never collide with
  a real id in any of the three tables, so `resolveMediaOwner` → generic
  `{kind:'event'}` → `existingEventIds` finding nothing → reclaimed as an
  orphan past the grace window is the same effective lifecycle it had before
  this record, regardless of which of the three kinds it is filed under. A
  future session may find it deserves its own owner kind rather than
  borrowing one of the three real event tables' names.
- **`EventOwnedMediaIds` widens `MediaStore.deleteForEvents`'s call sites
  from one `deleteForOwner` call to up to three** (one per non-empty kind),
  each independently gated through `writeGate` — a behavioural change from
  the prior single-call shape, accepted because the alternative (guessing a
  kind) is the bug this record exists to remove.
- Every touched test file that constructed a media row with `ownerKind:
  'event'` needed its fixture kind changed to a real table (`motion` /
  `object` / `audio`, chosen to match what the surrounding scenario actually
  represents) — a synthetic fixture using the retired kind now exercises a
  branch (or no branch) different from what it did before D474, and two
  integration tests (`wipe-all-analytics.spec.ts`,
  `delete-track-cascade.spec.ts`) demonstrated exactly that: a media row
  seeded `ownerKind: 'event'` stopped being deleted by the real cascade,
  because `deleteForOwner('object', ids)` never matches a row whose stored
  `ownerKind` is the string `'event'`.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/store/__tests__/owner-kinds-authority.spec.ts` —
  asserts `OWNER_KINDS ⊆ MEDIA_OWNER_TYPES` and that neither list re-admits
  `'event'`. Disarmed by removing `'vehicle'` from `MEDIA_OWNER_TYPES`: fails
  immediately (`expected [ 'vehicle' ] to deeply equal []`).
- `media-store.spec.ts`'s `deleteForEvents` tests, specifically "deletes only
  the named kind, never a same-numbered row in another table" and "deletes
  across multiple kinds in one call" — disarmed by reverting
  `deleteForEvents` to collapse every kind into one flat list under a single
  guessed owner kind (the pre-fix shape): both fail, one showing the wrong
  row untouched, the other showing a missed delete.
- `npm run typecheck` (53 projects, green) and a from-scratch `tsc --noEmit`
  over `packages/addon-post-analysis` WITH `__tests__` included (its
  `tsconfig.json` normally excludes them) — 547 pre-existing, unrelated
  errors before and after this change, zero new ones; diffed by normalized
  error text (file + code, line numbers stripped) against a `git stash`
  baseline, not eyeballed.
- `npx vitest run packages/types/src/media` — 16/16.
- `npx vitest run packages/addon-post-analysis/src/pipeline-analytics` —
  3735/3735 (one flaky, timer-dependent failure in
  `closed-row-best-media.spec.ts` reproduced only inside the full-suite run,
  not in isolation, and not touching media ownership; pre-existing per its
  own docblock, which already names this exact flake shape).
- `npm run codegen:check` — no drift (no `*.cap.ts` touched).

Nothing checks that a NEW caller of `MediaStore.put` chooses the right owner
kind for what it is writing — that is review only, same as D474 left the
"a reference keeps its own type" half of its rule to review.
