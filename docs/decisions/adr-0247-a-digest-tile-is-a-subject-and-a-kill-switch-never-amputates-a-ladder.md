---
id: D247
title: A digest tile is a SUBJECT, and a kill switch never silently amputates a ladder
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/summary/summary-selection.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-producer.ts
  - scripts/check-summary-ladder-reachable.ts
---

> **Amended 2026-09-01.** The kill switch this record is half about
> (`GROUPS_PROCESS_ENABLED`) no longer exists: the group entity was deleted
> outright on operator decision, and `groupCrop` / `nativeFrame` left
> `SUMMARY_MEDIA_LADDER` with it
> ([D330](adr-0330-a-kill-switched-feature-is-deleted-or-it-is-re-opened.md)).
> The RULE stands and the guard stands — the head of the ladder must be a
> picture of the subject — but it is now a statement about the ladder alone,
> with no second file to contradict it.

## Context

 (2026-08-24 14:51) did two correct things and they cancelled
each other.

It rewrote `SUMMARY_MEDIA_LADDER` to `groupCrop → nativeFrame → keyFrame →
keyFrameSmall → fullFrame`, removing `thumbnail` / `thumbnailSmall` / `snapshot`.
The reason was real and had been observed: a digest tile had shown a **number
plate**, because `captureSemanticBestShot` rewrites `kind: 'thumbnail'` with the
plate's bbox and the group's member scan passed every kind through.

In the same commit it set `GROUPS_PROCESS_ENABLED = false`, because duplicate
sealed rows had made Library → Gruppi unusable.

With the group process off, `buildSummaryPorts.listTracks` returns **tracks**,
not groups — so no row on the wire can carry `groupCrop` or `nativeFrame`. The
first live rung became `keyFrame`. Every summary notification shipped a whole
frame instead of the subjects, for three days, and nothing said a word: each
half reviewed as correct on its own, both packages' suites stayed green, and no
test owned the pair.

Two further things hid it. The plate collision that justified the removal
belongs to the **group** entity — `group-sealer.ts` is what writes
`ownerKind: 'group', kind: 'thumbnail'`; on a TRACK, plates live under
`ownerKind: 'plate'` / `kind: 'plateCrop'` and never touch `thumbnail`. And
`droppedNoMedia` was `max(0, rule.maxTiles - tiles.length)` — the count of
unfilled CELLS, not of tracks — so a real line read
`matched: 5, tiles: 5, droppedNoMedia: 7` with nothing dropped, while the three
lines that did explain a drop sat at `debug` and reached no log pipeline.

Measured on 60 real tracks (101/102, 24 h): 43/60 carried a rung of the shipped
ladder, 52/60 carried a crop, and **11/60 carried a crop and no rung at all** —
dropped outright. Two carried a rung and no crop, which is why simply deleting
the whole-frame rungs is also wrong.

## Decision

The best rung a digest tile can **actually reach** must be a picture of the
subject. `SUMMARY_MEDIA_LADDER` leads with the crops — `groupCrop → nativeFrame
→ thumbnail → thumbnailSmall` — and keeps `keyFrame → keyFrameSmall → fullFrame`
below them as the fallback for the track that has a frame and no crop. A track
with neither is dropped, never drawn as an empty cell.

A rung is not "present": it is **reachable**, and a feature flag that makes the
leading rungs unproducible is exactly as breaking as deleting them. Kinds that
only one entity can produce are declared (`SUMMARY_GROUP_ONLY_RUNGS`), so
reachability is computed rather than assumed.

Because `thumbnail` is a shared kind, admitting it needs a defence rather than
trust: `copyFaceCropIfTrackHasNoThumbnail` stores the ArcFace **112×112**
alignment template under `kind: 'thumbnail'` (measured: 3 of 52, 5.8%, at
3–10 KB). A `thumbnail` under `SUMMARY_THUMBNAIL_MIN_BYTES` (20 KiB) **descends
to the next rung** instead of being drawn. The floor reads
`MediaFileInfo.sizeBytes`, which the index already carries — no fetch, no
decode — so the row is refused before a single byte is read.

And a counter counts what it names. `droppedNoMedia` is the number of TRACKS
whose media the ladder could not serve, reported by the loop that did the
refusing; deduped duplicate frames are counted separately as
`droppedDuplicateFrame`; the line explaining a media drop is `info`, with
`tags: { deviceId }`.

Replayed over the same 60 tracks: the shipped ladder resolved **43/60 (72%)**,
every one of them a `keyFrame` at a median of **2.25 MB**. The new ladder with
the floor resolves **53/60 (88%)** — 49 `thumbnail`, 1 `thumbnailSmall`,
3 `keyFrame` — at a median of **197 KB**, and the three sub-floor thumbnails
(4.0 KB, 4.8 KB, 10.4 KB) descend instead of being drawn as faces.

## Consequences

`thumbnail` is back on a ladder it was removed from for a real reason, so the
plate collision is now held off by ONE thing: the group process being the only
writer of `ownerKind: 'group', kind: 'thumbnail'`. Re-enabling
`GROUPS_PROCESS_ENABLED` restores `groupCrop` above `thumbnail` and the
collision stays covered — but any future path that writes a plate-derived
`thumbnail` onto a TRACK would put a plate in a digest, and the size floor would
not catch it (a plate crop is not small). That path does not exist today; it
must not be created without revisiting this record.

The size floor is a heuristic on bytes, so a genuine subject crop of a very
distant subject can be demoted. That is accepted deliberately: a subject a few
dozen pixels across is a smear in a mosaic cell, and the whole-scene rung below
it is the better picture either way.

`SummaryMediaRow.sizeBytes` is REQUIRED (`number | null`, where `null` means
"the index reported none" and never demotes). Every producer of the row must
carry it, which makes a port that stops carrying it a type error rather than a
silently inert floor.

## Enforcement

`scripts/check-summary-ladder-reachable.ts`, wired into the Repository guards
loop in `.github/workflows/ci.yml`. It reads the real `SUMMARY_MEDIA_LADDER`,
the real `GROUPS_PROCESS_ENABLED` and the two exported rung classifications — no
copies — computes the reachable rungs, and fails if the first one is not a
subject crop. Replayed against the ladder it goes red; it is the
only thing in the repo that reads the ladder and the kill switch at once.

The `sizeBytes` passthrough is enforced by the type, not by a guard: dropping it
from `buildSummaryPorts.listMediaInfo` fails `tsc`.
