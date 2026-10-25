---
id: D565
title: The FILE list is the clip catalog on every topology — a clip IS a file — and the class is JOINED onto it where the file carries none
status: accepted
date: 2026-09-20
supersedes: D549-19
applies-to:
  - packages/addon-provider-reolink/src/clips/reolink-videoclips-provider.ts
  - packages/addon-provider-reolink/src/clips/clip-alarm-labels.ts
  - packages/addon-provider-reolink/src/clips/clip-catalog.ts
  - packages/addon-provider-reolink/src/clips/clip-event-catalog.ts
  - packages/types/src/capabilities/videoclips.cap.ts
---

## Context

[D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
decision 10 made `FileInfoList` "the ONE catalog primitive" and then decision
19 carved a topology out of it: **on a hub child the catalog is the EVENT
view**, because that view measured faster (29 events in 293 ms against 20 files
in 503 ms) and because it carried `alarmType` where a hub child's own files
come back `recordType: none`.
[D555](adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md)
then collapsed `onboard` and `hub` into ONE source that "picks the best API for
what the camera IS" and REPORTS the pick on `ClipSource.via`.

The operator looked at that and said *"questa vista eventi mi puzza un po', non
conviene fare fetch dei files così da avere esattamente le clips senza fare
incrocio?"* [this events view smells a bit to me, wouldn't it be better to fetch the files so as to have exactly the clips without cross-matching?], then *"sì, percorso solo."* [yes, path only.]

**Every number D549 19 rested on was re-measured on 2026-09-20, read-only, one
session per device, closed at the end. None of them survived.**

- **The speed argument is not deflated — it is REVERSED.** 3628 ch 0, through
  the parent's one socket: `searchEventLog` **950 ms** for 29 rows on day 16
  and **678 ms** for 38 rows on day 9, against `FileInfoList` sub **137 ms** /
  **514 ms** (plus main 218 / 242 ms). The 293 ms in D549 19 is not
  reproducible today and the 503 ms is 3.7× slower than what the same command
  answers now.
- **The class has a cheaper home.** `searchAlarmVideos` (272/273/274) answered
  the same child in **247–306 ms**, with `people 19 / other 9 / dog_cat 1`
  (day 16) and `people 23 / other 10 / dog_cat 6` (day 9).
- **A hub child's files really do carry no class** — confirmed, `{"none": 20}`
  on day 16 and `{"none": 28}` on day 9. D549 19 was right about that and only
  that.
- **The join is not free and not total.** On 3628 day 16, 28 of 29 alarm
  windows fell inside a listed file; the 29th needed a
  `playable: false, no-file-for-window` row that exists only because an event
  window is not a playable thing. On the standalone the same containment was
  **1 271 of 1 271** — the operator's number, confirmed exactly.

One of the operator's premises did NOT hold as stated, and it matters:

- *"`fileName` is exactly the `FileInfoList` `<name>`"* — **not as the library
  hands it over.** `RecordingFile.fileName` is the full `<Id>` path
  (`/mnt/sda/Mp4Record/2026-09-19/RecS03_DST20260919_000145_000348_….mp4`);
  `AlarmVideoWindow.fileName` is the short XML `<name>`, `01` +
  `YYYYMMDDHHMMSS`. A literal string join scores **0 of 539**. The 14-digit
  tail is the file's START in the camera's wall clock, and that IS the key:
  measured, distinct names matching a file's start stamp —

  | camera / day | `streamType` | names | a SUB start | a MAIN start |
  | --- | --- | --- | --- | --- |
  | 592 / 09-19 | 0 | 539 | 205 | **539** |
  | 592 / 09-19 | 1 | 539 | **539** | 205 |
  | 3628 / 09-16 | 0 | 22 | 10 | 20 |
  | 3628 / 09-16 | 1 | 21 | **20** | 10 |

  So `searchAlarmVideos`'s NUMERIC `streamType` really does select the file set
  the names come from — `0` the main set, `1` the sub set, as nodelink-js
  documents it. D555 read it off the hub as "both returned the same 28 file
  names": the two sets overlap heavily on a hub child, they are not the same
  set, and on the standalone they differ on 334 of 539.

Also measured, and the reason the labels are not simply asked for everywhere:
on 592 the alarm search costs **8.2 s / 9.5 s for 930 / 1 271 windows** — more
than the whole day's listing (2.1 s) — to restate labels the files already
carry (`md 498 / dog_cat 118 / people 108 / sched 40`, agreeing with the alarm
union on 164 of 167 files per D549 20).

## Decision

**`FileInfoList` (cmd 14/15/16) is the clip catalog on EVERY topology. A clip
IS a file.** A file has a start, an end, bytes and a still addressed from it,
and it plays. An event window has none of that on its own: it must be joined to
the file that contains it before anything can be downloaded, and a grain that
needs a join to become playable is the wrong grain. There is no per-camera API
choice left, so there is nothing for `ClipSource.via` to report and **the field
is removed** rather than left reporting one constant — a constant field reads
as a choice that still exists.

**The class is JOINED onto the file, and only where the file carries none.**
The gate is `dayNeedsAlarmLabels`: what the DAY's files actually said, never
what the camera IS. A standalone's files carry `recordType` and pay nothing; a
hub child's say `none` and get one `searchAlarmVideos` per camera-local day,
for the SUB file set, joined by the file's start stamp against the row's own
sub start or its main twin's. A window that names no listed file contributes
nothing and is COUNTED — it is never attached to the nearest neighbour. A row
the camera already classed is never overwritten by a per-window answer. **A
refusal costs the labels and nothing else**: the day still lists, honestly
unlabelled (`nativeTypes: ['none']`, no `labels`), with the refusal on a
`tags: { deviceId }` line — the same rule the MAIN search already lived by.

`searchAlarmVideos`'s `streamType` is a NUMBER selecting a file set;
`getVideoclips`'s is the string `subStream | mainStream`. Two different things
wearing one name: they are never unified and never passed through one another.
The one-local-day clamp is the firmware's on BOTH, and the caller owns the day
loop.

**The event path is KEPT and NOT WIRED, and that is enforced rather than
described.** `clip-event-catalog.ts` stays, with its 14 tests, because the
hub's cross-child event feed is a genuinely different question from a camera's
clip catalog — "what happened across these children", multi-day, newest first,
where `bHasRecFile` is the honest "no clip for this one" (the use D549 10
reserved it for). Deleting it and re-deriving it from git history would cost
more than keeping it, and an unexercised copy would rot. But this repo's rule
is that **a leftover which describes the right design is worse than nothing,
because it reads as verification**, so:

- its docblock's FIRST line says `NOT WIRED`, what it was for, and which
  measurement retired it — not a TODO and not a hopeful "future use";
- `EventLogApi` is off `ReolinkClipApi`, so a call cannot be typed without
  widening the type;
- `clip-event-path-is-not-wired.spec.ts` asserts, from COLD, that the catalog
  path never calls `searchEventLog` on either topology in any of its four
  shapes, and that the provider does not import the module at all.

Re-wiring it is therefore a deliberate act with five red tests in the way.

## Consequences

- **A hub child's rows are per FILE, not per EVENT.** 20 rows where the event
  view listed 29 on day 16, because a recording holds 1–13 windows. The
  operator LOSES the per-window split in the list; the per-window upgrade is
  `findAlarmVideo`'s own surface and belongs to a clip's DETAIL (D549 20), not
  to the list.
- **He GAINS the main twin on a hub child.** The events view carried no
  `streams` at all, so a hub child had no `high` copy to play; measured after,
  18 of 20 rows on day 16 carry one.
- **`playable: false` disappears from the Reolink catalog.** `no-rec-file` and
  `no-file-for-window` were properties of the event grain; a listed file always
  plays. The two reasons and `ClipSchema.playable` stay in the cap for other
  sources and for the event feed when it opens — they are not removed, and
  nothing else emits them today.
- **`index-empty` now applies to a hub child too**, because it has an index of
  its own that can contradict its own calendar. The cold `listSources` probe
  therefore lists the newest claimed day on a hub child as well (137–514 ms
  through the parent's existing socket, cache-backed for the `listClips`
  behind it). D561's probe is otherwise unchanged; the storage question stays
  skipped on a hub child, because that disk is the parent's.
- **`ClipSourceSchema.via` is gone.** Nothing consumed it outside the provider
  and its spec; no UI read it. `@camstack/types` changes, so this is a
  framework train.
- One alarm window per hub-child day matched no listed file (1 of 21 on day
  16). It is counted on the log line (`unmatchedWindows`) and contributes no
  label. It is NOT a row.

## Enforcement

- `packages/addon-provider-reolink/src/__tests__/clip-event-path-is-not-wired.spec.ts`
  (9): the catalog reads no event log, cold, on both topologies, across
  `listSources` / `listClips` / playback; the provider does not import the
  module; the module still works; its docblock's first line says `NOT WIRED`.
  **Proven red** by re-wiring `listEventRows` into `listClips` for a hub child
  the D549 19 way — 5 fail, including the import assertion.
- `…/__tests__/clip-alarm-labels.spec.ts` (14): the join key is the camera
  wall-clock start stamp and not a UTC one; the gate is what the day said; the
  SUB file set is asked for NUMERICALLY; one camera-local day; windows union
  per file; a classed row is left alone; an unmatched window is counted and
  attaches to nothing; the input is never mutated. **Proven red** by making
  `dayNeedsAlarmLabels` return `false` (5 fail across two files) and by
  flipping `ALARM_SEARCH_SUB_FILE_SET` to the main set (2 fail).
- The provider spec's `ONE catalog path` block (9): a hub child lists from its
  FILE list; a standalone does too; a hub child gets one row per recording with
  both twins; it is classed from its alarm windows; a camera whose files carry
  a class never pays for the search; the search is one per day for the sub set;
  a refusal keeps the day and names itself; nothing names an API on the row or
  the log line. **Proven red** by putting `via: 'files'` back on both (2 fail).
- Nothing checks that the alarm search is not quietly widened to a camera that
  does not need it — review only. `dayNeedsAlarmLabels` is the one gate and it
  is pure.
