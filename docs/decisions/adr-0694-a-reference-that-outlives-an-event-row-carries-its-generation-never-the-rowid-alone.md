---
id: D694
title: A reference that outlives an event row carries the row's generation, never the rowid alone
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/outbox-key.ts
  - packages/addon-post-analysis/src/pipeline-analytics/nc-owner-media-reader.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-file-url.ts
  - packages/addon-post-analysis/src/pipeline-analytics/event-media-handler.ts
covers:
  - packages/addon-post-analysis/src/notification-center/outbox.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/analytics-query-facade.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/object-embedding-selection.ts
  - scripts/check-event-media-generation-url.ts
---

## Context

[D474](adr-0474-an-event-id-is-the-rowid-and-a-reference-to-it-keeps-its-own-type.md)
made an event id the SQLite rowid of its table, `INTEGER PRIMARY KEY` with no
`AUTOINCREMENT`. SQLite then assigns `max(rowid) + 1`, so an id is handed out
AGAIN as soon as the rows holding the current maximum are deleted. That is not a
corner case here: a subject that never moved is disposed (D547) — track, rows
and media — seconds to minutes after its birth, while its rows are still the
newest in the table. On 2026-09-30 a deleted vehicle event on one camera and a
new package pick-up on another got the same id, 292786, within 90 s.

D474's second half — "a reference to an event keeps the type it had" — was
written for the TYPE of a reference and said nothing about its LIFETIME. Several
references outlive the row they name, and two of them used the bare id as an
identity:

- **The notification outbox id** `${ruleId}:${dedupRef}:${targetId}` falls back
  to the record id for a package event, a classified audio event and a
  track-less object event. It IS the exactly-once guarantee, held for the 7-day
  outbox horizon, so a reused id made a different record's notification a
  dedup hit: SUPPRESSED, with no line anywhere. The combined alarm's
  `supersede` matched the same bare id and could drop another record's pending
  row.
- **The delivery-time media read** resolved `object:<eventId>` through
  `getMediaForOwner` with no camera, so a row still pending for a deleted record
  would attach the NEW record's crops — another camera's picture — or the
  leftovers of a failed lockstep delete on its own camera.

What was checked and found SAFE (verified 2026-10-01): the recorded-cut memo
(its key carries the camera and the moment), cooldown keys (no record id), track
ids (random, `track-id.ts`), sensor event ids (producer-minted TEXT), every
synthetic record id (audio window, occupancy, timelapse, summary, alert episode,
system event), the recognition-upgrade and burst-revision refs, the track alias
store, the package detector's idempotency key, and `Track.bestEventId` /
`KeyEvent.id` (an event is TRACK-OWNED, so the pointer dies with its holder).
Two log-once memos keyed on an event id can suppress one INFO line on a reuse
and nothing else: the dispatcher's `reportedAnnotatedFallbacks` and
`event-media-dispatcher.ts`'s `${eventId}:${kind}` display-fallback memo.

**AUTOINCREMENT was considered first and not taken.** It removes the cause, for
every consumer at once. It also needs a framework change (`@camstack/system`'s
declared-schema path cannot express it, and a framework fix is not live until a
`@camstack/server` carrying it is installed), and SQLite cannot add it to an
existing table: every event table — millions of rows — would have to be rebuilt,
on the settings store's synchronous thread that D447 already measured blocking
the whole cluster's configuration reads. D474 decided against an in-process
migration of exactly these tables. A producer-allocated id (a persisted
high-water mark) needs the same framework change, for the insert to accept an id
on an auto-keyed collection. Both remain the way to remove the residuals below.

## Decision

**A reference to an event row that outlives the row, and is used as an
identity, carries the row's GENERATION — its camera and its own timestamp —
never the rowid alone.**

- The outbox dedup ref of a rowid record (`object-event` without a track,
  `package-event`, `audio-event`) is `<recordId>@<deviceId>:<recordAt>`, where
  `recordAt` is the record's stored timestamp (`payload.subject.timestamp`).
  Built ONLY in `notification-center/outbox-key.ts` (`outboxEntryId`); every
  other ref — a track id, an explicit `dedupRef`, a synthetic record id that
  already spells its device and instant — is unchanged.
- "Same record" is one predicate, `isSameOutboxRecord` (id + camera + record
  timestamp), and `supersede` uses it.
- The notification's `object:<id>` media read carries the event's generation
  (`NcEventMediaScope`, from `eventMediaScopeOf` — the alarm SOURCE's for a
  combined alarm row), and the production reader (`nc-owner-media-reader.ts`)
  keeps only rows on that camera stamped with that timestamp. That is exact
  because the only `object` media writer (`event-media-dispatcher.ts`
  `writeEventMedia`) stamps every row with the event's camera and the event's
  own timestamp — verified over every `MediaStore.put`/`putReplacing`/`reown`/
  `moveOwner` caller on 2026-10-01. A refused row is logged.

**Rows written before this keep working, and keep their ids.** A stored row is
re-identified from its own columns (`deviceId`, `payload.subject.timestamp`):
the boot hydrate adds the id it would have today beside its stored id
(`translatedLegacyEntryId`), and while the horizon is still cold the store probe
looks for the old spelling and accepts it ONLY when the row found is the same
record. A pending old row is delivered under its stored id. A stored row with
no record timestamp is loaded but dedups nothing, and says so.

## Consequences

- A record that shares a rowid with a deleted record on ANOTHER camera, or at a
  different instant on the same camera, is notified, and its picture is its
  own. Two records sharing id, camera AND timestamp to the millisecond still
  collapse — that needs the newest row deleted and a new row of the same camera
  stamped with the deleted row's own timestamp; accepted.
- The outbox ids of rowid records change shape. Nothing parses an outbox id;
  history, last-run and cooldown seeding read columns.
- **Residual reads, not scoped here** (each takes `object:<id>` with no
  generation): ~~the event-media plane's owner ladder `/o/object/<id>`
  (`readOwnerThumbnail` — its address carries no camera; the share check runs
  on the resolved row's camera, so access control holds, but a reused id can
  serve another record's crop), and the training export's `listMediaInfo`
  (archive contents of a curated export).~~ **Closed 2026-10-02 (D694
  follow-ups):** `readOwnerThumbnail` looks up the live event's generation and
  keeps only matching media; the training export scopes object media by camera
  and the event's own timestamp. ~~The bare URL still means "current holder of
  this id", not a historical generation — putting generation in the address is
  a separate product change.~~ **Closed 2026-10-02 (generation in plane URL):**
  the owner ladder accepts `/o/<eventType>/<id>/g/<deviceId>/<recordAt>`;
  `mediaOwnerUrl` / slim stamps / search thumbnails mint that form. Bare
  `/o/<eventType>/<id>` remains "current holder" for already-minted clients.
  Guarded by `scripts/check-event-media-generation-url.ts`. The cap reads
  `getEventMedia` / `listEventMedia` require a `deviceId` and were already
  camera-scoped. The debug bundle reads no `object` owner.
- **Residual, named follow-up — the orphan audit.** ~~Event-owned media rows whose
  lockstep delete FAILED stay behind; the orphan audit resolves ownership by
  `(table, id)`, sees the next holder of the id as a live owner and never
  reclaims them (a blob leak).~~ **Partial close 2026-10-02:** the audit now
  asks `eventGenerations` and reclaims media whose `deviceId` disagrees with
  the live holder (cross-camera reuse leftovers). **Still deferred:** reclaim
  on timestamp mismatch alone — D476 migrated rows are unproven to carry the
  event's own timestamp, so a stamp-only check would destroy live media. Same
  follow-up as AUTOINCREMENT / proven migrated stamps.
- **Residual — `idx_media_slot` has no camera.** The media uniqueness index is
  `(ownerKind, ownerId, kind, slotTs)` (`MEDIA_SLOT_COLUMNS`), so two records
  sharing an event id that write the same kind at the same instant UPSERT one
  row: the second re-homes it (`deviceId`, `path`) and the first blob is orphaned
  on disk. It needs the reuse plus an identical millisecond; adding `deviceId`
  to the slot is a **schema change** (rebuild `idx_media_slot` over the live
  media table on the settings store's synchronous thread — D447) and remains
  deferred with AUTOINCREMENT / a producer-allocated id.
- **Closed 2026-10-02 — unscoped `object` read refused.** The production
  reader (`nc-owner-media-reader.ts`) ERROR-logs and returns `[]` when an
  `'object'` read arrives without `NcEventMediaScope`; the unscoped
  `listByOwner('object', id)` path is gone. Guarded by
  `scripts/check-object-media-scope-required.ts`. The plane ladder and training
  export already scoped; ~~generation in the plane URL remains a product
  change.~~ **Closed same day — generation in the plane URL** (see residual
  reads above).
- **Closed 2026-10-02 — id-only raw delete race.** The orphan audit's raw
  delete for `object-events` re-asserts `{ id, trackId }` from the row it
  judged; a reused rowid with a different live track matches zero rows.
  Guarded by `scripts/check-orphan-reclaimers.ts`.
- A new consumer that keys anything on an event id beyond the row's life
  (a cache, a memo, a dedup set) must carry the generation too.

## Enforcement

- `notification-center/__tests__/outbox-rowid-reuse.spec.ts` reproduces the
  reuse through the real `EventStore` over the fake store (which assigns
  `max + 1`, as SQLite does), then pins: both records reach the outbox; a
  replay stays exactly-once; a pre-D694 row dedups its own record hydrated AND
  cold and never a different one; a row with no record timestamp cannot cold
  the whole horizon; `supersede` spares the other record. Verified by reverting
  `outbox.ts` to the bare-id key: 6 tests fail.
- `pipeline-analytics/__tests__/nc-owner-media-reader.spec.ts` drives the
  production reader against a real `MediaStore` holding three records' rows
  under one `object` id; dropping the camera or the timestamp filter fails it.
- `notification-center/__tests__/dispatcher-object-media-device-scope.spec.ts`
  fails if the dispatcher or the centre's wrapper stops passing the scope, or
  if a combined alarm row is scoped to its transition instead of its source.
- That the key is built in one place is review only; the tell is a
  `${ruleId}:` template anywhere but `outbox-key.ts`.
