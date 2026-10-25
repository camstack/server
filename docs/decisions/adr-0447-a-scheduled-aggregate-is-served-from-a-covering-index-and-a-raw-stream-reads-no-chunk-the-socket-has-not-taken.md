---
id: D447
title: A scheduled aggregate on the settings thread is served from a covering index, a raw HTTP stream reads no chunk the socket has not taken, and a link between two instruments is claimed from their timestamps
status: accepted
date: 2026-09-11
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - server/backend/src/api/backup-download.ts
  - server/backend/src/api/backup-download-pump.ts
  - server/backend/src/main.ts
last-verified: 2026-10-02
---

## Context

Two defects were handed to this session with the same shape — "a branch that
holds or blocks without saying so" — and the first thing the measurement did
was correct the hand-over.

**`hub/sqlite-settings` held its loop 4–7 s, but it was never silent.** The
profiler (`query-profiler.ts`) had been printing the WARN, with the plan, every
five minutes for at least 48 h (Loki, 2026-09-09 08:53 onward, 11–13 per hour):

    op=aggregate collection=pipeline-analytics:media
    shape="SELECT … FROM <t> WHERE \"locationId\" = ?" durationMs=4128…6962 rows=1
    plan=["SEARCH pipeline-analytics:media USING INDEX idx_media_location (locationId=?)"]

That is `MediaStore.footprintByLocation` (D388), the occupancy refresh. The
index finds the range and then fetches the table row behind every entry to
read `sizeBytes` — the exact cost the comment on `idx_media_device_size`
already described for the per-device read. Every row is on some location,
so the range is the table.

**And it was only half of the stall.** In the same ten hours of docker log
(22:22 CEST 09-10 → 08:20 09-11) the slow-call WARN fired 109 times on
`media` and **174 times on `recorder:segment-hours`** —
`WHERE "locationId" IN (?×1)`, 1 001–2 902 ms, once a minute from 22:50,
`plan=["… USING INDEX idx_recorder_segment_hours_loc_hour (locationId=?)"]`.
That is `SegmentHourLedger.accountingForLocations`, the placement service's
`usedOnLocation`. The table is ~19 k rows, but each row carries `paths`
(up to 360 segment paths of ~80 characters), so the eviction index served a
four-integer aggregate at ~30 KB of table page per row. The "3–16 times per
10 minutes on `aggregate pipeline-analytics:media`" of the hand-over was the
two collections added together.

**There is no causal link to hub-main's `starved` windows, and the measure
says so twice.** Loki holds every `pipeline-analytics frame lag` line for
24 h: **zero** with `busLagMaxMs ≥ 5000` (5 430 of 5 430 in the docker
window are `delivered-on-time`), while the media aggregate held the settings
thread 250+ times in the same day. hub-main's own `loopMax ≥ 1000` fired 12
times in ten hours; one of the twelve (23:36:54, 1 005 ms) is within 10 s of
an aggregate, the other eleven are not. hub-main never waits on
sqlite-settings — the call is async — so its loop cannot be held by it. The
"39 of 191 starved" figure is a ~8-minute sample (191 windows at 24/min)
that neither Loki nor the docker log contains; the 20:32–21:52 device-settings
storm D446 already named is the only candidate for it, and it ended two hours
before these stalls.

**The victims are the settings thread's CLIENTS, and they are named by the
clock.** The orchestrator's `session motion → attach latency` line carried
`configMs=6640` at 23:26:11 while the media aggregate ran 6 002 ms at
23:26:10; `configMs=3830` at 01:03:43 against 3 708 ms at 01:03:43;
`configMs=2190` at 01:19:22 against 6 010 ms at 01:19:20. The "orchestrator
stalls" the operator saw at 23:21/26/31/36 are the aggregates at 23:21:08,
23:26:10, 23:31:39 and 23:36:44 — a configuration read queued behind a
statement on one synchronous thread.

**The backup download route was exactly as described, and worse.**
`server/backend/src/main.ts` read 8 MiB chunks off the storage cap and called
`reply.raw.write(chunk)` in a loop that ignored the return value and never
waited for `drain`: on a fast disk the whole archive (464 MB on this hub) is
queued in hub-main's heap in seconds, per download, per slow client, released
only when the socket closes; a client that closed mid-transfer was not noticed
and every remaining chunk was still read and written into a dead socket;
success logged nothing and failure was a `console.error`. And the headers it
set through `reply.header(…)` were never sent — Fastify applies those on
`reply.send()`, which a raw write never reaches — so no download ever carried
a `content-length` or a `content-disposition`.

**Rejected, for the aggregates:** caching the answer in the reader (D224 —
the figure would be stale by design on the one write that matters, and the
statement still runs); widening `idx_media_location` or the eviction index
in place (`CREATE INDEX IF NOT EXISTS` is keyed on the NAME, so the
declaration would read as done and the query would still hit the table —
the same trap `idx_media_device_size` documents); a partial index
(`CollectionIndexSchema` has no predicate). **Rejected, for the download:**
dropping chunks (a truncated archive that extracts as corrupt); `close()`
on a stalled peer (the FIN queues behind the backlog); no cut at all (a
half-open peer holds the chunk, the storage handle and the request for the
kernel's whole retransmit budget, and `drain` never comes).

## Decision

1. **An aggregate the system asks on a schedule of `hub/sqlite-settings` is
   served from an index that carries every column it reads**, and the claim
   is proved on the real engine from the statement the store really
   prepares — `better-sqlite3`'s `prepare` observed, the captured SQL
   `EXPLAIN`ed on the same connection, `USING COVERING INDEX` asserted. A
   fake store cannot fail that test and a hand-spelled statement would assert
   a plan nobody runs. `idx_media_location_size (locationId, sizeBytes)` and
   `idx_recorder_segment_hours_loc_accounting (locationId, bytes, segments,
   minStartMs, maxStartMs)` are new NAMES, next to the narrower indexes they
   do not replace.

2. **A raw HTTP stream reads the next chunk only after the socket has taken
   the previous one.** `pumpDownload` honours `write()`'s return and awaits
   `drain`; the most a response holds is one chunk plus the socket buffer,
   whatever the client's speed. The bounding is the `drain` itself — this is
   a long, legitimate flow, not a subscription. The grace
   (`BACKUP_DOWNLOAD_DRAIN_GRACE_MS`, 60 s) exists only for the peer that
   stops reading altogether: a `ServerResponse` drains at 16 KiB, so a
   client that cannot take 16 KiB in a minute is under 0.3 KB/s — gone, in
   the restreamer's and D444's vocabulary, and it is destroyed with a `warn`
   naming the queue and the hold. A peer that closes is noticed at the next
   write and nothing more is read. Every exit is ONE line with the numbers
   (bytes, waits, longest wait, duration, ip, archive). The response is
   hijacked and its headers written on the raw response.

3. **A link between two instruments is claimed from their timestamps, not
   from their coexistence.** "sqlite-settings holds for 6 s" and "hub-main
   shows starved windows" were both true of the same evening and had nothing
   to do with each other; the pairing that IS causal (aggregate → a client's
   `configMs`) was found only by putting the two series side by side to the
   second. A causal claim in this repo's records carries the two timestamps.

## Consequences

- The two indexes ship with the addons: `camstack deploy post-analysis` and a
  deploy of `addon-pipeline` (the large bundle — its hot deploy has wedged
  the listener before; the operator decides when). The first
  `declareCollection` after each builds the index over every existing row:
  ~1.25 M rows for `media` (tens of seconds of the settings thread, ONCE —
  not beside a running drain or seal, per the sibling notes), ~19 k rows for
  `segment-hours` (well under a second).
- The route and the pump are `server/backend` and ride the next published
  `@camstack/server` (D16). Until then the download queues without bound and
  says nothing; the hub is on 1.2.269 and the change is ready.
- `footprintByLocation` and `accountingForLocations` keep their SQL; the
  profiler's WARN for these two shapes should stop appearing after the
  deploys, and its reappearance is the regression signal.
- A backup download now carries `content-length`, so a browser shows
  progress and a truncated transfer is a visible error instead of a short
  file.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/store/__tests__/media-footprint-plan-over-real-sqlite.spec.ts`:
  both statements (`= ?` and `IS NULL`) plan as `USING COVERING INDEX
  idx_media_location_size`, values still right. Disarmed by removing the
  index: both red with `USING INDEX idx_media_location`.
- `packages/addon-pipeline/src/recorder/addon/__tests__/segment-hour-ledger-accounting-plan-over-real-sqlite.spec.ts`:
  the domain total plans as covering. Disarmed by narrowing the index to
  `(locationId, bytes)`: red with `USING INDEX … (locationId=?)` — a partial
  cover is no cover.
- `server/backend/src/api/__tests__/backup-download-pump.spec.ts`: the next
  chunk is not read until `drain`; a closed peer stops the read; a peer that
  never drains is cut at the grace; a short read is a failure, never
  completion. Disarmed by dropping the `await` on the drain wait: three red;
  by dropping the grace timer: one red.
- `server/backend/src/api/__tests__/backup-download.spec.ts`: auth (401/403),
  404/503, the bytes and headers, the handle closed on every exit, one line
  per download.

## Update 2026-09-23 — the column that made the row expensive is gone

[D523](adr-0523-the-directory-says-which-segments-exist-and-the-table-says-how-much.md)
dropped `paths` from `recorder:segment-hours`. The row is ten scalars now, so
the ~30 KB of table page per hour row this record measured is not paid by
anybody any more.

Decision 1 does not move. `idx_recorder_segment_hours_loc_accounting` is still
there, still covering, and still proved on the real engine — it saves the row
FETCH on the one aggregate this hub asks on a schedule, which is the rule. What
died is a MEASUREMENT, not a rule: re-run the arithmetic today and the saving is
smaller and the same sign. The `media` index, the download pump and the rule
about claiming a link from two timestamps are untouched.
