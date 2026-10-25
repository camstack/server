---
title: Event media — what to stop keeping, and the per-camera debug flag that gates the rest
last-verified: 2026-08-30
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/periodic-media-plan.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/motion-event-snapshot.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
---

# Event media — what to stop keeping, and the per-camera debug flag that gates the rest

> **The operator's position.** *"Abbiamo una quantità inaudita di eventi.
> Idealmente voglio tenere primo, secondo, keyframe ed eventuali facce/plates."* [We have an unheard-of amount of events. Ideally I want to keep the first, the second, the keyframe and any faces/plates.]
> Wanted: a per-camera flag, default **false**, that turns everything else into
> debug-only output. `pipeline-analytics:media` measured 1 254 576 rows /
> 152.2 GB on the live hub — the second-largest thing on a disk at 95 %.
>
> **The headline this analysis produced, before any proposal: the operator's
> mental model of the 152 GB is wrong, and so was mine.** Track media — the
> firstFrame/lastFrame/keyFrame/thumbnail set his sentence is about — is
> **41.3 GB (27 %)**. **111.1 GB (73 %) is motion-visit stills**: one ≤960 px
> JPEG per motion off→on transition, `kind: 'snapshot'` on
> `ownerKind: 'event'`, written by `motion-event-snapshot.ts` with **no
> per-camera gate, no size bound and no consumer beyond the recording-clip
> tile**. The flag he asked for is still right — but the first 111 GB comes
> from gating a kind he did not name, and his keep-set is already 75 % of what
> would survive.

Everything below was measured on the live hub on 2026-08-30 via read-only
`settingsStore.aggregate` / `settingsStore.count` calls (each with a
`filter.where` — the bare-`filter` trap was avoided), and traced in the code at
the commits present in the working tree today. Companion pages:
[post-analysis.md](../architecture/post-analysis.md) (media capture, retention),
[2026-08-29-non-blocking-storage-migration.md](./2026-08-29-non-blocking-storage-migration.md)
(the pending `eventMedia` move this reorders).

---

## 1 · Inventory — what the collection actually holds

Read from the collection, not the type definitions. The 12 kinds of
`MediaFileKindEnum` (`packages/types/src/capabilities/pipeline-analytics.cap.ts:740`)
account for every row: per-kind counts sum to 1 257 140, equal to the
collection total at measurement time (the operator's 1 254 576 was the same
number a few hours earlier — the collection grows ~2.5 k rows per hour of
daytime). No unknown kind exists in the data.

| kind | rows | bytes | avg | what it is |
| --- | ---: | ---: | ---: | --- |
| `snapshot` (ownerKind **event**) | **1 136 601** | **111.08 GB** | 95 KiB | one still per **motion off→on transition** (`services/motion-event-snapshot.ts:119`) — the recording-clip tile for motion-only visits |
| `keyFrame` | 16 132 | 25.36 GB | 1.50 MiB | the native-resolution best frame, one per track (cap 4096 px) |
| `thumbnail` | 17 204 | 5.68 GB | 322 KiB | best-shot subject crop (track) + gallery display tiles |
| `snapshot` (ownerKind **track**) | 23 159 | 3.42 GB | 148 KiB | the periodic per-track filmstrip |
| `keyFrameSmall` | 17 800 | 2.31 GB | 127 KiB | 960 px clean variant of the keyFrame; also the synthetic-track still |
| `firstFrame` | 14 654 | 2.15 GB | 143 KiB | boxed full frame at confirmed birth |
| `lastFrame` | 14 710 | 2.06 GB | 137 KiB | boxed full frame near close (rolling, promoted at close) |
| `thumbnailSmall` | 14 986 | 0.33 GB | 21 KiB | ~480 px fast-load variant of the thumbnail; the reel/list representative |
| `fullFrame` | 320 | 0.18 GB | 564 KiB | original-resolution clean detail frame, per event |
| `crop` | 1 558 | 0.007 GB | 4 KiB | tight object crop per new-best CLIP track (search-hit thumbnail) |
| `fullFrameBoxed` | 4 | 0.006 GB | 1.5 MiB | boxed variant of `fullFrame` |
| `faceCrop` | 12 | ~0 | 7 KiB | (as a media *kind* — the face/plate buffers live under owner kinds below) |
| `plateCrop` | 0 | 0 | — | none stored |
| **total** | **1 257 140** | **152.59 GB** | | |

By owner kind: `event` 1 136 862 / 111.21 GB · `track` 118 666 / 41.27 GB ·
`face` 1 402 / 6.0 MB · `identity` 140 / 50.2 MB · `group` 45 / 54.0 MB ·
`plate` 43 / 0.13 MB · `vehicle` 0 · `scene` 0. The enrolled gallery
(`identity`/`vehicle`/`scene`) is retention-exempt and on `galleryMedia`, not
part of this problem.

### Per camera

`total` = all media rows/bytes for the device; `motion stills` = the
event-owned snapshot share.

| camera | total rows | total GB | motion stills rows | motion stills GB | stills share |
| --- | ---: | ---: | ---: | ---: | ---: |
| 104 hall | 227 053 | 30.81 | 197 896 | 20.25 | 66 % |
| 1443 sala da pranzo | 235 311 | 23.45 | 215 643 | 18.10 | 77 % |
| 103 porch | 216 767 | 23.36 | 212 388 | 21.56 | **92 %** |
| 3835 capanno garden | 82 576 | 12.89 | 80 160 | 11.45 | 89 % |
| 637 cortile | 88 700 | 9.21 | 86 503 | 8.17 | 89 % |
| 587 kitchen | 63 246 | 8.82 | 50 574 | 5.30 | 60 % |
| 3829 esterno garage | 97 042 | 8.40 | 95 027 | 7.54 | 90 % |
| 3839 hallway piano terra | 75 282 | 8.11 | 69 338 | 6.03 | 74 % |
| 102 parking | 38 880 | 8.04 | 28 503 | 3.23 | 40 % |
| 101 front door | 37 351 | 6.65 | 32 319 | 3.90 | 59 % |
| (remaining 20 cameras) | | ~12.9 | | | |

### Rates, and where the window comes from

The oldest rows date to **2026-08-17** — the recordings-volume wipe — so the
whole 152.6 GB accumulated in **≈12–12.75 days**:

- whole collection: **≈12.4 GB/day**;
- motion stills alone: **≈92 400 rows/day ≈ 9.0 GB/day** fleet-wide;
- camera 103: 212 388 stills over 12.75 days = **16 656/day = one motion
  off→on every 5.2 s, around the clock**, at 92 % of everything the camera
  stores.

Retention (D61/D64: one age sweep, per-device window, default
`follow-recordings` = the oldest segment still on disk) has not yet deleted a
single one of these rows, because the oldest segment IS the wipe day. The
window therefore grows with the archive's age span — and moving `recordingsLow`
onto the SSD (the drain running now) will *lengthen* it further. **Event media
has no bound of its own** (no quota, no per-family window — D61 removed those
deliberately, routing everything through the track cascade and the device
window); at the current production rate that is the actual root cause of "una
quantità inaudita" [an unheard-of amount]. What I could not determine: the steady-state follow window
once quota eviction starts moving the oldest segment forward — today it is
"since the wipe, growing".

---

## 2 · Who consumes each kind

Verified 2026-08-30 by walking every reader (server, viewer app, admin UI,
notification dispatcher, rebuild passes). D58's lesson frames the whole
section: media a later pass depends on is not decoration, whatever it looks
like.

| kind | consumers | later-pass dependency | verdict |
| --- | --- | --- | --- |
| `keyFrame` | **`rebuildObjectEmbeddings` loads exactly this blob** (`rebuild-source-loader.ts:82` — a track without one is outside semantic search forever, D58/D60); close-time thumbnail derive (`pipeline/track-close.ts:690`); late preview upgrade (`pipeline/preview-upgrade.ts:202`); durable plate-crop recovery; group anchor; NC clean-scene ladder head (`rule-engine.ts:1760`); retrain auto-pick head; viewer clean-frame head (`camstack/src/data/track-events.ts:479`) | **YES — the most depended-on kind** | **never gated** |
| `keyFrameSmall` | short-track `lastFrame` copy-promotion source (`pipeline/last-frame-promotion.ts:66`); synthetic-track still (`services/synthetic-track.ts:295`); NC clean-scene rung 2; viewer clean-frame rung 2; NC digest ladder | yes (close-time promotion reads it) | **never gated** |
| `thumbnail` / `thumbnailSmall` | Events list/reel tiles (`event-thumbnail-resolver.ts:34` — `thumbnailSmall` is the first fallback rung, and the embed URL builder pins it: `camstack/embed/src/embed/events-media-url.ts:44`); **also a re-embed source crop** (`rebuild-source-loader.ts:83` — the embedding row's `mediaKey` binds to it); NC `best` ladder head; NC digest (with a 20 KiB floor); close-derive and late-upgrade **targets** | **YES** | **never gated** |
| `firstFrame` | viewer trajectory-replay base (`camstack/src/data/track-trajectory.ts:244`); NC annotated-scene rung 4; retrain candidate; **track-audit `MISSING_FIRSTFRAME`** (`track-audit.mjs:144`) | no | **kept — the operator's "primo"** |
| `lastFrame` | trajectory-replay end; NC annotated-scene rung 3; **track-audit `MISSING_LASTFRAME` / `LASTFRAME_STALE` / `FF_EQ_LF`** | **target** of the close-time promotion (which reads the newest `snapshot` or `keyFrameSmall`) | **kept — the "secondo"** |
| `snapshot` (track) | trajectory-replay filmstrip; **consumed-and-deleted by the close-time lastFrame promotion** (`pipeline/last-frame-promotion.ts:58`, `media-store.ts:512`); NC annotated-scene rung 2; retrain candidate | yes — the promotion, at close only | **debug-gate** |
| `snapshot` (event) | **one named consumer**: the videoclips thumbnail licence (`videoclips-provider.ts:173` via `ownersWithMedia`, stamped at `:96`; clip-visit main event `videoclip-visits.ts:140`; viewer tile `camstack/src/clips/clip-mapping.ts:111`). Every byte-serving ladder reaches it only as the unnamed `files[0]` catch-all (`event-thumbnail-resolver.ts:24`); no NC ladder names it | no | **debug-gate — the 111 GB** |
| `fullFrame` (event) | event detail full-res view; NC `full` frame-preference head. **The per-track writer was RETIRED 2026-07-21** (`event-media-dispatcher.ts:1054`); the remaining writers are the NC digest mosaic (`index.ts:4041`) and photo enrolment (under `identity`) | no | leave alone — already retired at the source; the 320 rows age out with their owners |
| `fullFrameBoxed` | event population: **no live writer** (retired 2026-07-21), legacy rows only, yet still heads three NC ladders (`rule-engine.ts:1745`). ~~Group population: live write, NO reader~~ — **gone 2026-09-01**: the group entity and its sealer were deleted outright ([D330](../decisions/adr-0330-a-kill-switched-feature-is-deleted-or-it-is-re-opened.md)) | no | the dead group write is removed; the legacy event rows age out with their owners |
| `crop` (track) | semantic-search hit tile — **the object-embedding row's `mediaKey` names it** (`pipeline/object-embedding-selection.ts:47`); NC `best` rung; training export | yes — the search surface re-resolves it | keep ungated (6.7 MB total) |
| `crop` under `face-<trackId>` / `plate-<trackId>` owners (published as `faceCrop`/`plateCrop` — the rename is `track-media-scope.ts:130`; a grep for `kind: 'faceCrop'` misses them) | face/plate review buffers, capped newest-N (`pruneCapOverflow`); **the face re-embed pass reads them** (`index.ts:12015`); reowned to `identity`/`vehicle` on enrolment | **YES — re-embed + enrolment** | **never gated — the "facce/plates"** |
| `faceCrop`/`plateCrop` (event child crops, `pipeline/event-child-crops.ts:104`) | NC face/plate-signal ladder head (`rule-engine.ts:1853`); viewer media strip | no | keep (tiny) |
| `identity`/`vehicle`/`scene` owners | enrolled gallery | exempt (D197/D207) | untouchable |

One kind has **no reader at all**: `fullFrameBoxed` under `ownerKind: 'group'`
— a live write into a feature that is gated off, publishing nothing. Everything
else divides between kinds a **later pass or a primary surface** depends on
(keyFrame, thumbnail, the face/plate buffers) and kinds whose only reader is a
**secondary, degradable view** (filmstrip density, motion-clip tiles).
`getTrackMedia`'s audit contract is mirrored server-side in
`debug/debug-track-analysis.ts:178` (which additionally requires `keyFrame`).
Every NC still is re-resolved **at send time** (`dispatcher.ts:1738`), so a
ladder kind is a live dependency of the outbox, not just of the enqueue — but
ladders are preference orders: an absent rung falls through, it does not fail.

## 3 · Is the operator's keep-set sufficient?

His four words map onto seven kinds, and the honest minimum set is:

**`firstFrame` + `lastFrame` + `keyFrame` + `keyFrameSmall` + `thumbnail` +
`thumbnailSmall` + the face/plate buffers** (+ the exempt gallery).

That set is **38.0 GB of today's 152.6 GB**, and with it:

- **re-embedding still works** — the rebuild loads only `keyFrame` (D58);
- **the Events list, reel and timeline tiles still render** — the D230 ladder
  never reaches below this set;
- **notifications still attach a still** — the dispatcher's ladder resolves
  from thumbnail/keyFrame/lastFrame, all kept; gif/mp4 come from the clip
  ring, not from this collection;
- **face/plate review and enrolment still work** — the buffers and galleries
  are kept;
- **track-audit still works**, with one rule adjusted (below).

What breaks, named:

- **trajectory replay loses its filmstrip** — first and last frame only, no
  intermediate positions rendered over stored pixels. This is exactly the
  "debug" the operator described.
- **motion-only clip tiles go empty** on cameras with the flag off. The clips
  list falls back to no-thumbnail (the licence already reports absence
  honestly); object-backed clips keep their track tile. If this proves too
  ugly to live with, the fallback is a *coalesced* still (one per camera per
  N minutes instead of one per transition, ~50× fewer) — but ship the gate
  first and let the operator look at the result before building that.
- **`lastFrame` gets staler**: the close-time promotion absorbs the newest
  filmstrip snapshot; without one it keeps the rolling `lastFrame`, whose
  staleness bound is its own cadence. The audit's `LASTFRAME_STALE` (>2 s)
  will fire more often *by policy*; the rule must learn to read the policy
  stamp (§4) before it may call that a defect.
- nothing else: event full-res detail (`fullFrame`) was already retired at the
  source on 2026-07-21, and the NC digest mosaic keeps its own writer.

## 4 · The flag — `debugMediaEnabled`, and the authority that owns it

**The authority already exists.** Per-camera media production is owned by
`MediaSettingsSchema` (`media-settings.ts:9`) — the **Snapshots & media** form
(`settings-schema.ts:295`), stored in the `<addonId>:addon-devices` store,
written through `applyDeviceSettingsPatch`, which also rebuilds the frame
processors. Per D62/D113 the flag is a field of **that** schema and appears on
**that** form. No new store, no aggregate switch surface, no second panel.

```
debugMediaEnabled: z.boolean().default(false)
```

When **false** (the default), the camera does not produce:

| output | today's gate | where the new gate goes |
| --- | --- | --- |
| track filmstrip `snapshot` | `saveThumbnails` (`periodic-media-plan.ts:94`, `index.ts:8633`) | same sites, renamed input |
| motion-visit still | **none** | around `motionEventSnapshots?.capture` (`index.ts:9342`, `index.ts:9431`) — resolved from the same per-device media settings the frame path already holds |

The flag gates exactly those two outputs — the two populations with only
degradable readers (§2). Never gated, at any flag value: `firstFrame`, the
rolling `lastFrame`, `thumbnail`/`thumbnailSmall`, `keyFrame`/`keyFrameSmall`,
the face/plate buffers and event child crops, gallery media, the CLIP search
`crop`. The `fullFrame`/`fullFrameBoxed` event writes need no gate — they were
retired at the source on 2026-07-21.

**`saveThumbnails` is retired, not kept beside the flag.** It gates the
filmstrip *and* the rolling `lastFrame` today; the new flag gates the filmstrip
while `lastFrame` moves out from under it (the keep-set needs it). Two knobs
overlapping on one function is the exact D62 failure — one must absorb the
other. Retirement follows D268's shape: the schema key is deleted, the stored
per-device values retired, and `scripts/check-settings-key-has-reader.ts`
enforces that the new key has a reader. A camera where the operator had
explicitly set `saveThumbnails: false` maps to `debugMediaEnabled: false` —
the same behaviour it had, plus the motion-still gate. Note the deliberate
default flip: `saveThumbnails` defaulted true, `debugMediaEnabled` defaults
false — that flip IS the operator's request, and it takes effect fleet-wide on
deploy with no per-camera migration.

**Off is REPORTED off, and "off" must be readable per track, not only per
camera.** The distinction the track-audit workflow needs is retroactive: a
track closed last week under minimal policy must not read as a capture defect
after the operator flips the flag. So the policy is **stamped on the track row
at close** — `mediaPolicy: 'minimal' | 'debug'`, written from the same
resolved settings the processor already holds (no extra read, no second
authority: it is provenance of a decision already taken, the same shape as the
media row's `provenance` column and the label slots' `…Meta`). Consumers:

- the track-audit invariants (`missing filmstrip`, `LASTFRAME_STALE`) read the
  stamp and report `policy: minimal` instead of a defect;
- the admin/viewer track detail can say "debug media off for this camera"
  instead of showing an inexplicably sparse filmstrip;
- `CameraStatus.switchedOff` is deliberately **not** extended: that badge
  means "a function the operator turned off", and minimal media is the
  *default healthy state* of every camera — putting 30 cameras permanently in
  `switchedOff` would bury the one that is genuinely disabled.
- the motion-still gate logs on **transition only** (the `packageDropEnabled`
  precedent) — a per-event skip line at 92 k/day would be the flood the
  logging rules exist to prevent; a branch that drops work must say so, and
  the transition line plus the stamp say it without the flood.

## 5 · Retroactive: the 152 GB already on disk

The flag changes production. Three further steps, in order of bytes:

1. **Reclaim motion-visit stills — −111.1 GB.** An operator-armed, bounded
   pass in the `MediaRelocateEngine` mould (timestamp cursor, throttled,
   resumable), selecting `{ ownerKind: 'event', kind: 'snapshot' }` and
   deleting **through the store's own path** (blob + index row together —
   never an `rm` over the tree, and never the index alone: D148's rule, read
   for this store, is that the filesystem and the index must be walked
   together or the survivor lies). `deleteForOwnerUnchecked` as it stands is
   one query per owner id — 1.14 M round-trips — so the pass needs the bulk
   selection, not a loop over owners. Safety checks before it may run:
   per-page, every selected row's `ownerId` must resolve to a **motion**
   event — the check is the guarantee, not the selection shape: the
   synthetic-track/doorbell stills live on `ownerKind: 'track'` as
   `keyFrameSmall`, but nothing structurally prevents another writer from
   landing an event-owned `snapshot` for a row that is not a motion event,
   and a per-page indexed lookup is cheap where the mistake is not. The pass
   reports rows/bytes per device to the ops log, which is the trusted
   confirmation the operator reads. Consequence to accept
   explicitly: the affected motion rows keep their timeline presence but a
   later disk-reconcile pass treats a trackless motion event with no
   remaining snapshot as evictable — their history rows may follow. That is
   the policy working, not a leak.
2. **Reclaim track filmstrips for closed tracks — −3.4 GB.** Same pass, second
   selection (`ownerKind: 'track', kind: 'snapshot'`), skipping active tracks
   and every pinned one (`retrainStatus: 'staging'`, `favourited` — the pins
   are against the age sweep, but a reclaim that deletes a starred track's
   filmstrip violates the pin's intent).
3. **Retention policy, not a second one-off.** No new clock: D61's one-window
   design stands, and with the flag at false the steady state is the keep-set
   (~3.4 GB/day at current track rates) — the device window can bound that
   without a quota. What must NOT be done: a per-kind age sweep (a second
   retention clock, D61's explicit prohibition) or a quota that deletes by
   size (deciding pressure and deleting are separate powers —
   `media-store.ts:339`). If after the flag the operator still wants a
   bound, the lever that already exists is `retentionMode: 'custom'` with a
   smaller `trackRetentionDays`, per camera.

## 6 · Ordering against the pending `eventMedia` migration

The SSD move was blocked on this until 2026-08-30. The plan gate calls
`countUnstampedEventMedia`, which paged the ENTIRE collection at 200 rows per
RPC ordered by `timestamp` — a column that is **not the leading column of any
index** — so every one of ~6 300 pages paid its own scan-and-sort. It timed out
at 60 s by construction, on exactly the collection size it exists to protect.

**Fixed, and the diagnosis above was wrong in the way that mattered** (D312).
The paragraph this replaces said a null test "compiles to no predicate and is
silently skipped, returning the count of the whole collection". It did not.
`where: { locationId: null }` compiled to `"locationId" = ?` with NULL bound,
which under SQL three-valued logic matches **nothing** — so the count would have
answered **`0`**, the one value the gate reads as "safe to cut over". The
filter layer now compiles a null value to `IS NULL` (and `whereNot` to
`IS NOT NULL`, which was the same defect mirrored), `count`/`aggregate`/
`histogram` REFUSE a predicate they cannot apply instead of dropping it, and
both collections declare an index on `locationId`. The count is now one
existence probe plus one indexed `COUNT(*)` per collection — and `null` means
"not measurable", never zero.

The order, with the arithmetic at the migration doc's own 4–14 MB/s
destination figures:

| plan | bytes moved | drain time @4 MB/s | @7 | @14 |
| --- | ---: | ---: | ---: | ---: |
| migrate first, clean later | 152.6 GB | 10.6 h | 6.1 h | 3.0 h |
| **clean first, migrate 38 GB** | 37.9 GB | **2.6 h** | 1.5 h | 0.8 h |
| avoided | 114.7 GB | 8.0 h | 4.6 h | 2.3 h |

Cleaning first still stops
writing 9 GB/day of stills onto whichever volume is current mid-drain. So:
**(1) ship the flag → (2) reclaim (§5) → (3) fix the seal count → (4) seal →
(5) migrate the remaining ~38 GB.** Nothing here touches the `recordingsLow`
drain currently running; the media reclaim is index+unlink work on the source
volume and must still be scheduled after that drain completes rather than
beside it — the disk is the contended resource.

## 7 · Ranked summary

| # | action | saves now | saves ongoing | costs |
| --- | --- | ---: | ---: | --- |
| 1 | gate + reclaim motion-visit stills | **111.1 GB** | ~9.0 GB/day | motion-only clip tiles empty (the licence reports absence honestly; a coalesced one-per-N-minutes variant is the fallback if the operator rejects the empty tile) |
| 2 | gate + reclaim track filmstrip | 3.4 GB | ~0.3 GB/day | replay density; staler lastFrame; audit reads the policy stamp |
| 3 | migrate only the remainder | — | saves 8.0 h of drain I/O @4 MB/s | ordering discipline |
| 4 | delete the reader-less `fullFrameBoxed` group write; let the 0.19 GB of retired event fullFrame/boxed rows age out with their owners | ~0 | ~0 | none — leftover hygiene |
| — | do NOT touch `keyFrame` (25.4 GB) | — | — | it is the re-embed input (D58) and the one-index-one-derivation anchor (D52); shrinking it is a model-scope decision, not a storage tweak |

Keep-set steady state: **≈38 GB** at today's window — a 75 % reduction, with
the operator's four words kept in full.

## What I could not determine

- The **steady-state follow-recordings window** once quota eviction starts
  advancing the oldest segment — today the window is "since the 08-17 wipe"
  and still growing, so every per-day rate above divides by ~12.3 observed
  days, not by a settled window.
- Whether the **motion-transition rate on 103/1443/104** (one per ~5 s) is
  scene reality or a motion-debounce defect — 16 k transitions/day smells like
  flapping, and fixing THAT would shrink motion rows (1.29 M, non-media) too;
  it is out of scope here but worth its own look.
- Whether any **external consumer** (HomeKit/HA export, third-party webhook)
  reads motion-visit stills through the data plane; nothing in this repo does
  beyond the clip tile, but the artifact-plane URLs are HMAC-public once
  minted.
- Whether the operator will accept the **empty motion-clip tile**; the
  coalesced-still fallback is designed but deliberately not proposed for the
  first slice — look at the result of the gate before building it.
