---
id: D523
title: The DIRECTORY says which segments exist; the table says HOW MUCH
status: accepted
date: 2026-09-17
applies-to:
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/ghost-location-sweep.ts
  - packages/addon-pipeline/src/recorder/addon/ledger-walk-reconcile.ts
  - packages/addon-pipeline/src/recorder/addon/location-discard-job.ts
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-pipeline/src/recorder/segment-store.ts
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - packages/addon-pipeline/src/__tests__/guards/hour-ledger-names-no-file.guard.ts
covers:
  - packages/addon-pipeline/src/recorder/evict-select.ts
last-verified: 2026-09-29
---

## Context

[D521](adr-0521-a-seal-is-a-claim-of-completeness-and-only-a-party-that-can-know-may-write-one.md)
traced camera 101 losing two hours off the timeline on 2026-09-17 while all 355
and 358 segment files stayed on the disk, and it GATED the party that could
write a false seal. It also said, explicitly, that the column underneath was
staying:

> **`paths` was NOT dropped in this change** … The column IS the union's input:
> `adoptWalkedHour` diffs what the directory holds against what the row names,
> and a row that carried only `segments: 175` could say an hour is short but
> never WHICH segments the readers are missing.

That argument is wrong in one place, and the place is load-bearing. It assumes
the reader must be TOLD which segments it is missing. The reader is standing in
front of the directory. Every fact about a segment is in its NAME —
`<startMs>-<durMs>-<bytes>.m4s` under `<deviceId>/<profile>/Y/M/D/H/` — so a
`readdir` of one hour is a complete, self-describing answer, and no file is ever
opened to get it (`segment-path.ts`, `calendar-scan.ts`).

The whole failure class exists only because a second, WRITE-BEHIND copy of that
answer was allowed to be authoritative. The chain, every time:

1. a writer is torn down mid-hour, so the row is short by whatever it never
   persisted;
2. something seals the row — the rollover (D521), or a walk, or nothing at all
   and a `sealed` default that happened to read complete;
3. `hydrateWindowFromStorage` seeds `RecordingIndex` from `hour.paths`;
4. `hourSegmentsFromIndex` returns a short array — **non-null means COMPLETE** —
   so `getAvailability` never readdirs either;
5. the closed-hour skip fires forever after. Nothing looks again for the life of
   the footage.

Camera 4374 lost 10 246 of the 10 734 `low` segments of the night of
2026-09-10→11 through the same chain, and its timelapse was rendered from a
fifth of a night that was entirely on the disk.

**The cost that justified the column is not there any more.** Five docblocks in
this tree quoted `~650 ms per hour directory` as the reason a reader must not
`readdir`. That number traces to a FUSE mount (`shfs`) that has been retired.
Measured on 2026-09-17 on 101's own location, `/recordings-2` — SATA SSD, XFS —
an hour directory of 345–349 files lists in **~1 ms**, including a directory
five days old. D451's own independent measurement on another camera was 3.6 ms
cold after `drop_caches`. Even at 3.6 ms, a 20-day single-camera availability
query is ~1.7 s of syscalls. Contention, not latency, is the real ceiling: a
startup warm of ~66 back-to-back reads once turned a 0.2 s query into 38 s.

And the column is expensive where it sits: `paths` is **99.2 % of the 66 MB
`recorder:segment-hours` table** — 15 643 bytes per row over 4 036 rows. D287's
two-tier mirror, D471's gzip codec and half of D447's index work all exist to
carry it.

## Decision

**The directory tree is the authority for WHICH segments exist. The table is the
authority for HOW MUCH exists. `paths` is removed from the code entirely.**

- A `SegmentHourRow` is ten scalars: the identity, `sealed`, and the four
  aggregates. It names no file, so no consumer can be handed a short list and
  believe it is the hour.
- **Every caller that needs segment NAMES lists the hour directory.** One
  injected `HourLister` — `(locationId, deviceId, profile, hourStartMs) =>
  Promise<readonly string[] | null>` — with three answers, and the difference
  between the last two is the point: `null` is *undecided* (the location does
  not resolve, may not be read, or the read failed), `[]` is *the hour holds
  nothing and the volume confirmed it* (an ENOENT on the hour directory is
  reported as empty only after the location ROOT has answered a read), and
  otherwise the paths. A `null` skips the hour and is SAID, tagged with the
  camera (D391, D393).
- **The four aggregate columns stay.** "The oldest segments across this location
  domain" is a global ordered aggregate no directory read can answer without
  reading everything — a recursive walk over 258 449 files for ONE device
  measured 68 s — and the quota evictor, the retention prune,
  `accountingForLocations`, `census`, `usageByDevice` and placement all read
  only those.
- **A listing of a CLOSED hour REPLACES that hour's account and seals it**
  (`adoptWalkedHour`), rather than unioning into it. That is what makes an hour
  that was over-counted or under-counted self-correcting.
- **The window hydrate always lists.** `hydrateWindowFromStorage` asks the
  ledger nothing; it reads every hour of the window that this PROCESS has not
  already read, and always re-reads the live hour.

## Consequences

**What is now impossible that was possible before.** A durable row cannot make a
reader believe an hour is complete, because a row carries no claim about which
segments exist. The 2026-09-17 chain has no step 3. A directory cannot be SHORT
about itself.

**What it costs.** A cold read of an N-hour window is N×3 `readdir`s instead of
one point read — ~1 ms each here, and the in-process skip means each hour is
listed once per process. The eviction and drain paths pay one listing per hour
they touch, which is bounded by the hours the probe chose, not by the archive.
The database loses 99.2 % of a 66 MB table.

**"Once per process" became "once per residency" the same day**
([D524](adr-0524-the-ram-index-holds-a-declared-budget-and-a-dropped-row-costs-a-readdir.md)).
The skip rests on a walked marker in `RecordingIndex`, and that index had no
bound: every hour a reader caused to be walked stayed for the life of the
process, so a timeline dragged across a retention window made the archive
resident permanently — 1 039 MB at the production shape, measured. The index now
declares a budget and drops the least-recently-asked-about `(device, hour)`
buckets, rows and walked marker **together**, so the reader answers `unknown` and
lists again rather than believing an emptiness. That trade is only payable
because of this record: **a dropped row costs a `readdir`, never a segment.** The
two changes hold each other up. The one exception it had to close is the mirror
image — `reconcileFromIndex` PRUNES on the index's silence, and an evicted hour
looks exactly like a deleted one, so a walk announces itself and the reconcile
refuses to prune a camera whose index was trimmed.

**This supersedes part of three records.**

- **D287** — the two-tier mirror (`pathsResident`, `materialize`, the boot
  projection, the live-tail materialise) existed solely to keep `paths` out of
  the boot load. Its PRINCIPLE stands and is stronger than ever: nothing at boot
  may be proportional to the segment count. Its MECHANISM is gone, because the
  row is now ten scalars and there is no fat tier to defer. Boot issues one
  query with no projection.
- **D471** — the record itself is about `pipeline-analytics`' `positions` and is
  untouched. What is gone is the recorder's LOCAL COPY of the same idea,
  `paths-codec.ts`, which existed only to make this column smaller and is
  deleted with it.
- **D451/D521** — the seal survives whole, and both guards still pass. What
  changes is what a seal BUYS: it no longer spares a reader a directory read
  (nothing does), it records that the row's account came from a complete
  listing, and it is what lets the adoption sweep skip an hour.
- **D148 gives up its one-directional arm here, deliberately.** A closed hour's
  listing may now SHRINK its row. The guard that replaced "never remove" is
  `HOUR_LISTING_MAX_SHRINK_SHARE = 0.5`: a listing that would erase more than
  half of what a row accounts for is refused and named, because a root that has
  gone away and a bucket a dead round half-deleted both answer short. Under the
  bar the directory decides; over it the row stands and the hour stays unsealed.

**Three passes were redesigned rather than adapted.**

- `ghost-location-sweep` probed each of a row's paths at each candidate root —
  up to ~1 000 `storage.exists` calls to prove one hour absent. The unit is now
  the hour DIRECTORY: one listing per physical root, every root must answer, a
  non-empty listing at exactly one root repoints the hour **with the segments
  that listing names** — never with what the ghost row claimed.
- `ledger-walk-reconcile` compared path sets. It compares COUNTS and BYTES now;
  the repair is `adoptWalkedHour` with the listing, or `forgetHour` for a
  directory confirmed empty, both still behind the volume anchor's second read.
  Its per-file orphan list becomes a bounded LEAD drawn from the hour's listing.
- `location-discard-job` walked the segments to forget them. It wipes the
  filesystem FIRST, so by the time the ledger is touched every hour directory is
  gone and nothing can name a segment — it now forgets by SCOPE. A pass that had
  not been changed would have forgotten nothing and left the whole location
  accounted for on every storage page, forever.

**The drain stops being a ghost-row cleaner, and that has to be said.** Its work
list used to be the durable rows' own `paths`, so a row naming a file that had
been gone for weeks was handed to the mover, `stat`ed, found absent and forgotten
under `GHOST_FORGET_SHARE` — that is how the 11 074 ghost rows on
`recordingsLow:default` were found at all (D318). The work list is a LISTING now,
so a file that is not there is never in it and `forgetGhosts` is unreachable for
that shape. Two consequences: the ENOENT branch now fires only on a file that
vanished BETWEEN the listing and the copy, and a source file already gone whose
copy is stranded at the target is no longer adopted by the mover. Both are now
`ledger-walk-reconcile`'s job — `adoptWalkedHour` for an hour that shrank,
`forgetHour` for one that emptied — which is the pass built for exactly this
question, under an anchor the mover never had. The `GHOST_FORGET_*` prose still
describes the wider trigger and is now about a narrower one.

**Two refusals disappeared because their failure has.** `repointSegments` and
`dropSegments` used to refuse an hour whose detail they could not read: a write
derived from a non-resident row would have rewritten the hour as the one path
that just arrived. There is no point read on those paths any more, so
`repointSegments` returns `void` and the relocate mover's "the durable ledger
refused" branch is gone.

**Two things got weaker and are written down rather than hidden.**

- `recordSegment`'s dedup is now an in-process `Set` per live hour, not a
  membership test against the stored column. A duplicate finalize that survives a
  process RESTART double-counts that hour's bytes and segments. The row is
  unsealed, and the first listing of the closed hour re-derives the account
  exactly — which is the loop closing, not an excuse.
- `dropSegments` and `repointSegments` shrink an account arithmetically and do
  not re-derive `minStartMs`/`maxStartMs`. The error is bounded by the hour
  itself: both values always lie inside `[hourStartMs, hourStartMs + 1h)`, and
  both rows come out UNSEALED so the next listing fixes them.

**`repairAggregates` is gone.** It backfilled rows written before the aggregate
columns existed by re-deriving them from `paths`; there is nothing inside the
database left to derive from. Such a row now under-reports its disk (prunes
less, never more) until a listing of that hour adopts it — the adoption sweep
reaches every closed hour daily.

**`RecordingIndex` gained `resetHour`.** `hydrateHour` merges, which is right for
a reader whose listing of a live hour is a lower bound. The two operator-armed
passes that hold TRUSTED evidence — the ledger walk under its anchor, the ghost
sweep after every root answered — need the other direction, and they get a named
method rather than a flag on the merging one.

**The database column may stay where it is.** Nothing reads it. See below.

## The operator's side — the exact statements

Nothing in the code cares whether the column is still there: `rowToValue` stops
writing it and `recordToRow` stops reading it, so an unread `paths` column is
inert. **Deploy first, drop at your leisure** — there is no lockstep.

`CLAUDE.md`: **never `sqlite3` while CamStack runs**, and the live file is the
`sqlite-settings` bind identified by `docker inspect`, never a sibling
`camstack.db` (D328, D147). On this hub that is
`/mnt/mixed/camstack/addons-data/sqlite-settings/camstack.db`.

```bash
# 1. Stop the hub. A dropped column under a live writer is a corrupt table.
docker stop camstack-hub

# 2. Confirm the file, from the container's own bind — never a sibling copy.
docker inspect camstack-hub \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' \
  | grep sqlite-settings

# 3. Back it up. This is 66 MB; the copy is seconds.
cp -a /mnt/mixed/camstack/addons-data/sqlite-settings/camstack.db \
      /mnt/mixed/camstack/addons-data/sqlite-settings/camstack.db.pre-d523

# 4. Drop the column and reclaim the pages.
sqlite3 /mnt/mixed/camstack/addons-data/sqlite-settings/camstack.db <<'SQL'
PRAGMA foreign_keys=OFF;
SELECT COUNT(*) AS rows_before FROM "recorder:segment-hours";
ALTER TABLE "recorder:segment-hours" DROP COLUMN paths;
VACUUM;
SELECT COUNT(*) AS rows_after FROM "recorder:segment-hours";
PRAGMA integrity_check;
SQL

# 5. Start the hub.
docker start camstack-hub
```

`ALTER TABLE … DROP COLUMN` needs SQLite ≥ 3.35 (2021); on anything older, or if
step 4 refuses because the column is indexed, recreate instead:

```sql
BEGIN;
CREATE TABLE "recorder:segment-hours__new" (
  key TEXT PRIMARY KEY NOT NULL,
  deviceId INTEGER NOT NULL,
  profile TEXT NOT NULL,
  locationId TEXT NOT NULL,
  hourStartMs INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  segments INTEGER NOT NULL DEFAULT 0,
  minStartMs INTEGER NOT NULL DEFAULT 0,
  maxStartMs INTEGER NOT NULL DEFAULT 0,
  sealed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "recorder:segment-hours__new"
  SELECT key, deviceId, profile, locationId, hourStartMs,
         bytes, segments, minStartMs, maxStartMs, sealed
  FROM "recorder:segment-hours";
DROP TABLE "recorder:segment-hours";
ALTER TABLE "recorder:segment-hours__new" RENAME TO "recorder:segment-hours";
COMMIT;
VACUUM;
```

The indexes are re-declared by the addon on its next boot
(`SegmentHourLedger.declare`), so they do not need recreating by hand; the
recreate path above drops them with the table and the first declare after
restart rebuilds all four in well under a second (D447).

**Do not run this to "fix" a row that looks wrong.** A row whose aggregate
disagrees with its directory is repaired by a listing — leave it to the adoption
sweep, or force it with a window read of that camera.

## Enforcement

`packages/addon-pipeline/src/__tests__/guards/hour-ledger-names-no-file.guard.ts`, wired into
`.github/workflows/ci.yml`. It fails if the persisted column list declares
`paths` (or `segmentPaths` / `files` / `fileNames`), if `SegmentHourRow` gains
`paths` or `pathsResident`, if anything under `recorder/` outside the tests
calls `hourPaths(` / reads `pathsResident` / calls `detailForWindow(`, or if
`hydrateWindowFromStorage` stops calling `fs.readdir`. Bringing the column back
is cheap and every reason to want it back is the reason it was there, so the
guard exists to make it a decision instead of a convenience.

`hydrate-window-lists-the-directory.spec.ts` is the record's own test: an hour
whose row is SEALED and SHORT hydrates to the full directory. It is the inverse
of the case the file used to open with, which was titled "a SEALED short row is
still short when nobody asks to verify — the trade, pinned".
`hydrate-window-walks-every-hour.spec.ts` pins the cost shape: seven directories
on the first walk of a seven-hour window, two on the next (the one hour never
listed, plus the hour that can still grow).

`scripts/check-seal-authority.ts` and `scripts/check-recorder-index-residency.ts`
both still pass unchanged, which is the point: this record removes a
possibility, it does not move a gate. Note that the seal guard matches a literal
`sealed: true`, so `hourRowOf` takes `sealed` as a NAMED field — a seal
smuggled in as a positional boolean is a seal the guard cannot see.

What is still review-only: whether a FUTURE column under another name holds the
same thing. The guard catches the obvious spellings and nothing more.
