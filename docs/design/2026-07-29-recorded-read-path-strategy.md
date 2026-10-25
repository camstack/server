# Recorded read path — strategy

> Status: proposed, 2026-07-29 (rev 2). The plan to make
> [D31](../decisions/adr-0031.md) actually deliver. Read with
> `packages/addon-pipeline/src/recorder/` and
> `camstack/embed/src/{playback,scrub}/`.
>
> **Superseded in part, 2026-08-03.** Everything this document says about the
> thumbnail STRIP — the `HH.strip` files, the writer, and the velocity rule that
> chose them — describes code that no longer exists. The rung was removed after
> production served zero frames from it; see the amendment in
> [D41](../decisions/adr-0041.md). The byte-range keyframe half of this plan
> stands and is what runs.

## What this is for

Recorded playback and timeline scrub were rebuilt on byte ranges on 2026-07-28.
Playback works. Scrub does not, and the operator's verdict was that the result is
not comparable to what it replaced. This says why, and what to build instead.

## The mistake at the root

**Scrub and playback ask different questions, and both were built on machinery
designed for neither.**

- Playback asks *give me a continuous stream from here forward*. It wants whole
  GOPs, in order, buffered ahead.
- Scrub asks *what did this instant look like, and the thousand instants I am
  crossing*. It wants many small, scattered stills and does not care about
  continuity at all.

Today scrub fetches a ~45 KB keyframe per cursor position under latest-wins,
which DISCARDS all in-flight work on every move. Against the operator's
requirement — drag an hour in 2 s at a 10 fps cap — that is 20 frames 180 s
apart, in 20 different segments: **40 round trips and ~940 KB in two seconds**,
with latest-wins guaranteeing almost none of them paint. It is not slow, it is
structurally incapable of being fluid.

## The read path has three layers

| Layer | Question | State |
| --- | --- | --- |
| **Discovery** | which file holds instant T? | **broken** |
| **Location** | which bytes inside that file? | **solved** — `mfra`, exact, ~200 ms cold |
| **Delivery** | bytes → picture | works |

Every failure of the last day was in DISCOVERY. The byte-range work solved
Location, measured it, and reported that measurement as the cost of a seek —
which is how a solved layer masked a broken one.

## Discovery, as it stands

`RecordingIndex` (`src/recorder/recording-index.ts`) already holds every segment
in RAM — `(deviceId, profile, startMs, durMs, bytes, path, locationId)` — kept
write-through by `SegmentStore` on finalize and on evict, and derived entirely
from paths, so it cannot drift. `getAvailability` answers from it with no disk
I/O.

Three things sat between it and the client:

1. **A stat per segment.** ~2,700 syscalls for a camera-day, ~4 s on a contended
   array, on the critical path of the first scrub. **Fixed 2026-07-29** — 206 ms
   measured. Export keeps the verification; ffmpeg dies on the first missing file.
2. **HLS playlists as the wire format.** Measured after that fix: 206 ms to
   synthesise, **1,745 ms to transfer and parse** for a 3,049-segment day. Now
   the dominant cost.
3. **The index is EMPTY for ~9 minutes after any restart.** `hydrateDeviceFromStorage`
   is a recursive `readdir` over the whole device subtree; the code's own comment
   says ">1M files and takes minutes". Measured: 1 min after a deploy a day held
   **7** segments, growing by 2 per 20 s — the rate of NEW writes, not of the
   archive.

Item 3 is not only a testing problem. **An unhydrated index is indistinguishable
from an empty archive**: the server says "no footage" when it means "I have not
looked yet", and the operator concludes their recordings are gone.

## The design

### One artifact per depth

The path convention already encodes time. Give each depth an index that answers
at its own granularity, each a small ranged read:

```
<profile>/YYYY/MM/DD/            → coarse availability (timeline bars)
<profile>/YYYY/MM/DD/HH/         → hour index: segment rows + their mfra tables  (~4 KB)
<profile>/YYYY/MM/DD/HH/*.m4s    → media, unchanged
scrub/YYYY/MM/DD/HH.strip        → thumbnail strip for the hour        (~2.7 MB, est.)
```

The depth you ask for is the granularity you get.

### Playback start becomes ONE round trip

Today: init, `mfra` tail, fragment — three round trips before the first frame.

`mfra` tables are tiny (2–4 sync samples per segment, a handful of bytes each).
Carried inside the HOUR index, the client knows every GOP's byte offset for that
hour without asking. A seek is then one request for the fragment. Init is once
per profile per session.

### Scrub becomes a pipeline, and reads by depth

**One rule decides where to read from: the time step between consecutive
frames.** From drag velocity and the fps cap, `step = velocity ÷ fps`.

- **step > keyframe interval (~4 s)** → read the thumbnail STRIP. The 20 frames
  for that hour live in one file: one ranged read, ~60 KB, instead of 940 KB and
  40 round trips.
- **step ≤ keyframe interval** → the positions are inside one or two segments;
  fetch those once and **decode forward** locally for the intermediate frames. No
  per-frame request at all.

This is not a fallback and it never tries one then the other: velocity
*determines* the depth, deterministically. That distinction is what keeps it
inside [D31](../decisions/adr-0031.md), and it must be stated in the record.

The engine changes shape with it: from point-query-with-latest-wins to a
**pipeline along the predicted trajectory**. Reads for the next k positions are
issued together, painted at the capped cadence, and only work that has left the
trajectory is aborted — not everything on every move. That is the difference
between "jerky" and "a flow".

### Where the thumbnails come from

The recorder runs `-c:v copy` and decodes nothing; a full extra rendition would
cost CPU per camera. `-skip_frame nokey` decodes ONLY keyframes — one per ~4 s —
scales them to 160×90 and appends to the hour's strip: ~900 thumbnails/hour at
~3 KB, **~2.7 MB per camera-hour (estimate, to be measured)**. One more output on
the ffmpeg already running.

Tapping the detection pipeline's decode was considered and rejected: it detaches
when idle, so it is absent exactly when a scrub needs it.

## Phases

**Phase 0 — the hydration ladder.** Every question answered at its own depth,
never forcing a lower one. Measured on the live archive (device 104, `low`):

| rung | question | entries | cost |
| --- | --- | --- | --- |
| **L0** `<profile>/YYYY/MM/` | which DAYS have footage | 28 | **1 ms** |
| **L1** `<profile>/YYYY/MM/DD/` | which HOURS of a day | 8 | **1 ms** |
| **L2** `<profile>/YYYY/MM/DD/HH/` | the SEGMENTS of an hour | 360 | **2 ms** |
| — | full device walk | **258,449** | **68,457 ms** |

68 seconds for ONE camera on ONE profile tree; with ~20 cameras that is the
"minutes" the code comment means, and it explains the ~9 minutes measured after
a deploy.

The structural defect this exposes: `getDaysWithRecordings` and
`getAvailability` both call `index.segments(deviceId)` — **the cheapest question
demands the most expensive data.** The date selector, the first thing an
operator sees, cannot answer until 258,449 files have been walked.

So: cold start needs NO walk at all. The date selector is ~6 readdirs (~6 ms)
across a 30-day retention; the current day's coarse timeline is one more; segment
rows are hydrated only for hours actually entered. The full walk stays, in the
background, for retention and footprint — consumers that need the whole picture
and are not on a screen.

Two things the measurement forced into the design:

- **Directory existence is NOT footage.** 15 of 28 day directories on the real
  archive are EMPTY: retention deletes files and leaves the tree behind. A naive
  L0 would show 15 phantom days. The fix is to make the invariant true rather
  than work around it — eviction removes directories it empties — plus a
  one-time sweep for the ones already there. Until that lands, L0 confirms a
  candidate day by finding one non-empty hour inside it.
- **Adjacent days are warmed with the one being indexed.** Changing day is a
  single click and the operator expects the scrub and the summary to be there,
  not to wait for a walk. Indexing day D also indexes D−1 and D+1 in the
  background when they are not already known — at ~1 ms per rung that is free,
  and it converts the most common navigation into a cache hit.

Past rungs are immutable and cache forever: a day that has footage keeps it
until retention removes it, and retention already goes through the index. So L0
and L1 invalidate on eviction, not on a timer; only "today" is refreshed.

An answer also carries whether the index had actually LOOKED — an empty window
under `unknown` means "retry", never "no footage". A correctness fix in its own
right: today a hub restart shows an empty timeline and lets the operator
conclude their recordings are gone.

**Phase 1 — the hour index.** Segment rows + `mfra` tables, served from RAM as a
compact binary, replacing playlist synthesis on the playback path. Removes the
1.7 s and makes playback start one round trip. Playlists stay for export only,
moved beside `export-source-playlist.ts`.

**Phase 2 — the client's coverage cache.** Both playlist parsers
(`playback/segment-index.ts`, `scrub/low-index.ts`) collapse into one directory
client. `locate` becomes a binary search in memory; a drag inside covered ranges
makes zero discovery requests. `INDEX_WINDOW_HALF_MS` and the whole
rebuild-per-drag-position problem disappear — that windowing only ever existed to
make an expensive call cheaper.

**Phase 3 — the strip and the scrub pipeline.** Last, because it changes the
recording, and only worth doing once the rest is verifiable.

**Phase 4 — delete what was replaced.** `ScrubPackService`, its disk cache and
its retention sweep are already unreachable.

## Budget

| Scenario | today | after |
| --- | --- | --- |
| first scrub | never arrives | one hour read, then zero requests inside the hour |
| fast drag over an hour | 940 KB, 40 RTT, almost nothing painted | ~60 KB, 1–2 RTT, fps at the cap |
| slow drag | a keyframe per position | one segment, then local decode |
| playback start | 3 RTT + 1.7 s of playlist | 1 RTT |

## Guards, chosen for the failures that actually happened

- **A fetch that checks its receiver.** `this.fetchImpl = fetch` detaches the
  global; WebKit rejects it, Node does not. This killed every byte-range read
  while an end-to-end harness over the real archive passed. Node tests must
  reproduce browser CONSTRAINTS, not just browser APIs.
- **Fixtures must not be normalised by the script that captured them.** The
  decoder-init fixture had been trimmed to end-of-`moov` by its capture script,
  so it encoded the fix rather than the bug and no fixture test could fail.
- **Every outcome logs.** Silent supersede/null paths cost three rounds: a drag
  that always loses the race painted nothing and said nothing, which reads
  exactly like a component that is never called.
- **Measure the whole path.** The seek bench read its segment list from a local
  file, so it measured Location and was reported as end-to-end.
- **No `.m3u8` on the playback path**, asserted.

## Testing protocol (part of the design)

A deploy respawns the recorder and blinds discovery for minutes. Until Phase 0
lands, **no on-device test within ~10 minutes of a deploy carries information** —
every negative result of the last day was collected inside that window, which is
why the diagnosis kept moving. Assert index readiness before asking anyone to
test, and report that state alongside any result.

## Rejected

- **Per-segment manifest sidecars.** A write+rename per finalize on a contended
  array, crash repair for the partial hour, a rewrite on every evict — to
  duplicate an index the same process already maintains drift-free.
- **Client directory listings over HTTP.** The same endpoint backed by `readdir`
  per request instead of RAM, and racier against eviction.
- **Keep m3u8, just drop the stats.** Fixes 4 s, keeps 1.7 s, two document
  shapes, two parsers, per-request disk writes, no incremental tail.
- **A persisted/SQLite index.** A second source of truth that retention and
  crashes can desynchronise, against an index that currently cannot drift.
- **Restoring the keyframe packs.** Their builds could not be cancelled, so fast
  scrubbing queued them until the picture stopped moving. Available if the phases
  stall, at the cost of a second mechanism.
