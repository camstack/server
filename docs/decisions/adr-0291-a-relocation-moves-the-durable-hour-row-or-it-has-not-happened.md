---
id: D291
title: "A relocation moves the DURABLE hour row, or it has not happened — and the target row is written first"
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
---

## Context

`RelocateEngine` re-pointed `RecordingIndex` — RAM — and nothing else. That was
correct, and *documented as correct*, right up until three days ago:

> *"Il percorso **è** il dato. Non c'è tabella da riscrivere, e un crash a metà
> si risana da solo perché l'indice si ricostruisce dal disco al prossimo
> hydrate."* [The path **is** the data. There is no table to rewrite, and a crash halfway
> heals itself because the index is rebuilt from disk at the next hydrate.] — `docs/design/2026-08-26-low-events-storage-migration-to-ssd.md`

D287 (2026-08-29) made that false. A CLOSED hour is now hydrated from
`SegmentHourLedger` **first**, and when the ledger covered the window
`hydrateWindowFromStorage` returns without reading the disk at all
(`packages/addon-pipeline/src/recorder/addon/roots.ts:430`). The hour row is
keyed by `(deviceId, profile, locationId, hour)`
(`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:388`), so a
relocated hour comes back **at its old location** on the next boot: paths under
a root that no longer holds the file. Playback does not stat — that syscall per
segment was removed deliberately
(`packages/addon-pipeline/src/recorder/addon/recording-provider.ts:425`) — so
the operator sees a silent black window, not an error. And once the drained
location is deleted (the point of a migration), `collectRangeSegments` drops
those rows entirely (`recording-provider.ts:404`). That is exactly the shape of
the 2 131 `recordings:high` ghost segments already on the hub.

The window is not academic. The recorder restarts on every addon deploy — seven
boots in under two hours on 2026-08-29 — and `getStorageUsage`'s per-volume
figures come from the ledger (`recording-provider.ts:886`), so a drain also
reported zero bytes arriving on the destination for its whole duration.

**What was tried first and was wrong.** The obvious repair — re-point the
ledger per file, cheapest order, source first — has a window in which the path
is listed in **no** hour row. Because a ledger-known hour marks the index
`hydrated`, nothing would ever walk that hour again: the segment sits on disk,
permanently unreachable. The cheap order is the one that loses footage.

A second attempt added an ENOENT branch that adopted an already-copied
destination. The disarm run passed with it reverted: `copyVerified`'s
copy-if-absent already adopts an equal-sized destination before it can ever
touch the source, so the branch was dead code describing an invariant it did
not enforce. It was deleted rather than shipped.

## Decision

A footage relocation re-points the **durable** hour row, and the ordering is the
invariant, not an implementation detail:

1. Work is batched by hour — the durable index's own bucket.
2. Every file of the hour is **copied and verified**; no source byte is deleted
   yet, so both locations hold the hour.
3. `SegmentHourLedger.repointSegments` writes the **target** hour row, then
   shrinks or forgets the source row.
4. Only then are the source files deleted and `RecordingIndex` re-pointed.

At no instant may the durable index name a location that does not hold the
bytes. A ledger that cannot read a source or target hour **refuses** the whole
hour and returns `false`; the caller then deletes nothing, the hour stays wholly
readable where it is, and the verified copies at the target are adopted by the
next run (D49/D148: a read that fails changes nothing).

## Consequences

- **Cancel and crash both degrade to "readable from both", never to "invisible
  on one".** A cancel inside an hour leaves that hour entirely at the source
  plus adoptable copies at the target. A crash between the two ledger writes
  leaves the hour listed at both locations — and both hold every file.
- **Two durable writes per hour, not per file.** ~360 segments per hour amortise
  to one target `put` and one source `put`/`forget`.
- **The destination needs one hour of extra headroom**, because an hour is
  duplicated between step 2 and step 4.
- **A node with no ledger still drains**, RAM-only exactly as before, and says
  so once per hour with `tags: { deviceId }` — silence would read as "the
  durable index was updated".
- `moveFile` survives as `copyVerified` + `rm`. New callers should use
  `copyVerified`; a mover that deletes before the durable re-point re-opens this
  bug.

## Enforcement

`packages/addon-pipeline/src/recorder/__tests__/relocate-durable-repoint.spec.ts`.
The ordering assertion is not an end-state check — both orderings end
identically. It replays the store's write log and asserts that after **every**
durable write the moved path is listed by at least one hour row. Disarmed in
both directions: reversing the two writes fails it; removing the ledger
re-point fails three of five; deleting per file instead of after the re-point
fails the cancel and refusal guarantees.
