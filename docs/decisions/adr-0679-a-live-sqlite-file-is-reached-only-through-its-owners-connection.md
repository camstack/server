---
id: D679
title: A live SQLite file is reached only through its owner's connection — never an fs descriptor in the owner, never a second connection from another process
status: accepted (the archive half of rule 2 — "it tars the `.db`, `-wal` and `-shm` as they are" — and the six statements marked inline are superseded by D693; both rules re-verified 2026-10-01)
date: 2026-09-29
supersedes: D468 (its diagnosis only — "TRUNCATE zeroes the WAL under the mmap" — and its claim that PASSIVE fixed the trigger; the persisted declarations stand). Amends D452 (how the checkpoint worker learns what is pending).
applies-to:
  - packages/system/src/builtins/sqlite-storage/wal-checkpoint-worker.ts
  - packages/system/src/builtins/sqlite-storage/wal-checkpoint-policy.ts
  - packages/system/src/builtins/sqlite-storage/wal-checkpointer.ts
  - packages/system/src/builtins/sqlite-storage/shm-lock-canary.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts
  - packages/system/src/builtins/system-backup/system-backup.service.ts
  - scripts/check-sqlite-files-not-opened-by-fs.ts
last-verified: 2026-10-15
---

## Context

**`hub/sqlite-settings` died with SIGBUS, most nights, for 17 days.** Loki has
a runner exit on 09-12 (three), 09-13 (two), 09-14, 09-15, 09-16, 09-18, 09-19,
09-20, 09-21, 09-22, 09-23, 09-24, 09-25, 09-26 (two), 09-27, 09-28 and 09-29.
Only `docker logs` records the signal, and it had rotated. The signal is proven
SIGBUS for 09-29 (`signal=SIGBUS`) and for 09-28 (the earlier investigation).
Each death costs about a second of refused writes cluster-wide. D468's
persisted declarations made that survivable, so nothing paged.

**The crashes follow an open of the live database by ANOTHER process.** That
process is hub-main, running `createArchive: checkpointed DB`:

| external open (Z) | runner gone (Z) | delay |
| --- | --- | --- |
| 09-21 01:00:09 | 09-21 01:44:06 | 44 min |
| 09-25 01:00:24 | 09-25 02:30:11 | 90 min |
| 09-26 12:07:33 (manual backup) | 09-26 12:13:58 | 6 min |
| 09-28 01:00:36 | 09-28 02:32:29 | 92 min |
| 09-29 ~01:00 (nightly, `0 3 * * *` CEST) | 09-29 02:24:43 | ~84 min |
| 09-12, D468's hand-triggered backup | within 2 min | — |

The delay is a **write burst**, not the clock. On 09-28 the Unraid appdata
backup restarted a Home Assistant container at 02:31:38Z. A flood of `HA→device
online transition` writes followed, and the runner died 51 s later. On 09-29 a
recorder/aggregate burst came just before the crash.

**The runner had lost its lock on the wal-index, and it could not know.**
Here is `/proc/locks` on the hub on 2026-09-29, runner pid 3490531, the only
process with the database open:

- the database inode 3760032966 carries the WAL-mode shared lock;
- the `-shm` inode 3769403373 carries **nothing**, in 6 of 6 samples.

A healthy WAL connection holds a shared lock on `-shm` byte 128 (SQLite's "DMS"
lock) for its whole life. The runner mapped the `-shm` as three 32 KiB regions.

**The cause was one line from D452.** The checkpoint worker is a thread of the
runner. It read the wal-index header straight out of `-shm` once a second:
`openSync` / `readSync` / `closeSync` (`readWalIndex`, removed here). On POSIX,
`close()` of ANY descriptor of a file releases EVERY fcntl lock the process
holds on that file, including the DMS lock. This is the trap sqlite.org
documents in `howtocorrupt.html` §2.2.

The chain:

1. The runner loses its DMS lock within a second of every spawn.
2. The 03:00 backup opens a second connection from hub-main. It can take byte
   128 exclusively, so it concludes it is the FIRST connection. It truncates
   `-shm` to 3 bytes and rebuilds only the regions the current (small) WAL
   needs.
3. The runner still has its three old regions mapped.
4. The next write burst pushes the WAL past a 4096-frame region boundary. The
   runner writes a hash entry into a mapped page that is now beyond end of
   file, and the kernel sends SIGBUS.

**Reproduced off the hub** (macOS, better-sqlite3, SQLite 3.53.2). The steps
match production: 12 000 frames so three regions are mapped, a PASSIVE
checkpoint so the WAL restarts small, ONE open by another process, then a
burst.

- control: `-shm` stays at 131 072 bytes, and the process survives;
- one `open/read/close` of `-shm` in the holder: at the second open `-shm`
  goes 131 072 → 32 768, and the holder dies with **SIGBUS** 3–4 k frames into
  the burst;
- the same with `mmap_size = 0`: still SIGBUS. The `-shm` is always mapped,
  so `mmap_size` is not a lever;
- the same poll through a descriptor opened ONCE and never closed: survives.
  This isolates the `close()`.

**What was tried first, and why it could not work.** D468 blamed
`wal_checkpoint(TRUNCATE)` "zeroing the WAL under the mmap". But the WAL is
read with `pread` and is never mapped. It switched the backup to PASSIVE on
2026-09-12. The crashes continued unchanged for 17 days, because the trigger
was the backup's **open**, not its checkpoint mode. A PASSIVE checkpoint is
the "safe" one, and that is exactly why the second connection looked harmless.

## Decision

**A live SQLite database is reached only through the connection of the
process that owns it.** Two rules, one per side of the failure:

1. **Inside the owner, no filesystem call touches the `.db`, `-wal` or `-shm`.**
   That means no `open`, `read`, `close`, `truncate`, copy, rename or delete.
   `stat` is allowed: a path lookup takes no descriptor and drops no lock.
   Anything the owner needs to know about its WAL it asks its connection.
   The checkpoint worker now runs `wal_checkpoint(PASSIVE)` on a schedule
   derived from the checkpoints' own answers (`log`, `checkpointed`).
   Frames appended between two answers give a rate. The next checkpoint lands
   when 1000 more frames will be pending (D452's rule), clamped to
   [1 s, 8 s].
   - A PASSIVE with nothing pending performs no fsync: the copy and both syncs
     sit behind `nBackfill < mxFrame` in `wal.c`. So a quiet database pays
     nothing for the clamp.
   - An idle WAL (the same complete `log == checkpointed` answer twice) counts
     as 0 appended and backs off to the max gap. The WAL restarts only at the
     next write, so without this rule an idle node was scheduled at 1 Hz
     forever and every pass re-counted the whole WAL (review M1).
   - A pass that answered `busy` measured nothing: the previous observation
     is kept and the worker looks again at the poll interval.
   - **Why 8 s, and what it costs against D452.** The max gap bounds how late
     a burst is seen. The engine's fallback (10 000 frames) folds inside a
     settings-thread commit, which is the stall D452 moved off that thread.
     No burst rate has been measured on the hub (54 frames/s is D452's
     steady rate), so the design point is 1 000 frames/s, ~18× steady:
     8 s of it is 8 000 frames, under the fallback. The cost: at the steady
     54 frames/s the threshold would fold every ~18.5 s, and the clamp folds
     every 8 s instead, about **2.3× D452's fsync pairs** (≈ 432 frames per
     fold). They are paid on the worker, a thread nobody waits on; the
     settings thread's commits stay appends.
   - A scheduled pass that found more than 5 000 appended frames is a WARN
     (`WAL checkpoint pass found a large backlog`, the first of each 10-min
     window) and is counted as `large` / `maxAppended` in the summary. That
     is the field measurement the 8 s is tuned from. Before the first such
     WARN is seen, 8 s is a design point, not a measurement.
2. **No other process opens a live database, not even for a PASSIVE
   checkpoint.** `SystemBackupService.createArchive` no longer opens a
   connection. It tars the `.db`, `-wal` and `-shm` as they are, and SQLite
   recovers the WAL on the first open after a restore.

A canary makes the invariant observable where it broke. The runner reads
`/proc/locks` on Linux (never the `-shm`), finds the `-shm` inode by `stat`,
and logs on transitions only:

- INFO `SQLite shm DMS lock held` the first time it sees the lock;
- WARN `SQLite shm DMS lock LOST` when the lock goes missing.

It checks at boot and then every 10 minutes.

## Consequences

- **The nightly archive of the settings database is torn, before this change
  and after it — measured, not possible.** The reviewer simulated the service
  exactly (node-tar `create({gzip, follow, portable})` as `createArchive`
  calls it, a 312 MB WAL database, a child process writing inserts and
  deletes on an indexed table, the REAL worker thread at its default policy)
  and ran `PRAGMA integrity_check` on every extracted archive:

  | variant | torn archives |
  | --- | --- |
  | this change (no connection) | **6/6** |
  | `origin/main` (a second connection runs PASSIVE first) | **9/9** |

  The corruption was page double-references, rowid order, and missing index
  rows. The mechanism: tar reads `.db` first (the directory order on the hub
  is `.db`, `-wal`, `-shm`) and `-wal` after it. A worker fold during the
  `.db` read rewrites pages behind tar's cursor, and the next write restarts
  the WAL, so the frames that would repair those pages are gone by the time
  tar reaches it. At a fold every ~8 s and a gzip of an ~800 MB file that
  takes tens of seconds on the N100, **most nightly archives of `camstack.db`
  should be assumed not restorable to an intact database.** This change does
  not make that worse: the removed pre-checkpoint never covered the tar
  (9/9), and it was the trigger of a nightly SIGBUS.

  **HIGH-priority follow-up (not done here):** the **owning runner** writes
  the snapshot, with the online backup API (`db.backup()`) or `VACUUM INTO`
  into staging. That needs:
  - a capability method on the sqlite-settings runner, pinned to the hub;
  - the archive to carry that snapshot in place of the live trio;
  - the restore to drop the target's stale `-wal`/`-shm`. Otherwise SQLite
    replays a WAL from the wrong database onto the restored file.

  It is a framework change with its own review. Until it ships, a restore of
  the settings database from a nightly archive must be followed by
  `PRAGMA integrity_check` before it is trusted.
  *(Superseded by D693, 2026-10-01: the follow-up has shipped as D693 — the
  owner's verified snapshot, carried in place of the live trio, promoted on
  restore after the stale sidecars are dropped. The `integrity_check` advice
  now holds only for archives made before it.)*
- The backup spec's round-trip test uses a writer that is quiet during the
  tar. It proves WAL replay on restore, not archive consistency; its comment
  says so. *(Superseded by D693, 2026-10-01: that test is gone. The archive no
  longer carries the live `-wal`; it carries the owner's verified snapshot.)*
- The worker's `CheckpointReport` changed shape: `reason` is `first |
  scheduled`, `appendedFrames` replaces `pendingFrames`, and `nextDelayMs` is
  new. The summary line's `frames` now sums frames appended between passes.
  It used to sum the WAL cycle's running backfill total, which counted a frame
  once for every pass that saw it. The summary also carries `large` and
  `maxAppended`.
- Everything here is `@camstack/system`, a framework package. It is live only
  after a `@camstack/server` containing it is installed (D16). `camstack deploy`
  of an addon does not carry it.
- The canary is Linux-only. On macOS it logs once (INFO) that it cannot look.
  On Linux a failed look (the `-shm` missing, procfs unreadable) is a WARN,
  `could not look`, with the error: a different fact from "not Linux".
  `/proc/locks` inside a container reports pids in the reader's own namespace
  (Linux ≥ 4.9), so `process.pid` matches.
- `pipeline-analytics` and every other addon that wants SQLite go through the
  settings door. A SQLite driver (`better-sqlite3` or `node:sqlite`) is
  value-imported only by the two files that construct the owner's
  connections, `sqlite-settings-backend.ts` and `wal-checkpoint-worker.ts`,
  and the guard keeps it that way. *(Superseded by D693, 2026-10-01: a third
  owner file, `sqlite-snapshot-worker.ts`, the snapshot thread of the same
  runner.)* Not the whole `sqlite-storage/`
  directory: `@camstack/system`'s index exports modules from it that hub-main
  loads.
- The guard has a named allowlist (`SQLITE_GUARD_ALLOWLIST`: file, rule,
  reason) for code that handles a database nobody has open, such as the
  follow-up's restore dropping stale sidecars before any runner starts. It is
  empty today. *(Superseded by D693, 2026-10-01: it holds exactly that restore,
  `server/backend/src/sqlite-restore.ts`.)*

## Enforcement

- `scripts/check-sqlite-files-not-opened-by-fs.ts`, in the CI repository-guard
  list, has two rules:
  - `fs-on-sqlite-file` refuses a filesystem call whose argument names a SQLite
    file in production code;
  - `sqlite-connection-outside-owner` refuses a value import of
    `better-sqlite3` or `node:sqlite` outside the two connection files.
    *(Superseded by D693, 2026-10-01: three — `sqlite-snapshot-worker.ts` is the
    third.)*

  Its spec (`scripts/__tests__/check-sqlite-files-not-opened-by-fs.spec.ts`)
  proves each rule red on the exact shapes that caused this, and covers the
  exact-suffix match, `node:sqlite`, a sibling module in the owner's
  directory and the allowlist; each of those four went red with its change
  reverted. It does not walk the real tree: the CI guard step does, and a
  4 000-file walk under vitest's 10 s timeout was flaky. Run against the
  `origin/main` sources, the guard flags `openSync(shmPath, 'r')` in the
  worker and `await import('better-sqlite3')` in the backup.
- `packages/system/src/builtins/sqlite-storage/__tests__/shm-lock-survives-a-second-open.spec.ts`
  uses real processes. A child shaped like the runner runs the REAL worker
  thread over an idle database, the test process opens it once, and the child
  writes a burst. The test asserts that the `-shm` did not shrink and the child
  exited 0. Disarmed by putting the `-shm` open/read/close back into the
  worker's tick, it fails on the size (131 072 → 32 768) and, with that
  assertion removed, on `signal: 'SIGBUS'`.
- `wal-checkpoint-policy.spec.ts` pins the schedule: the idle-WAL rule (red
  with the rule removed), the 8 s bound against the 10 000-frame fallback at
  1 000 frames/s, and the 2.3× fsync cost at the steady rate.
  `wal-checkpointer.spec.ts` pins the sampled large-backlog WARN (red with it
  removed) and that the first pass is not judged. The busy-pass path in the
  worker has no dedicated test: a PASSIVE that answers busy needs a second
  checkpointer holding the lock mid-pass, and was not reproduced.
- `system-backup.service.spec.ts` checks that the database file's size is
  unchanged across `createArchive`: any checkpoint by another connection grows
  it. Disarmed with the `origin/main` service, it fails. It detects a
  checkpoint, not a read-only open; the guard covers the open statically. A
  second test checks that every committed row round-trips through the
  archived `-wal`, with a quiet writer: WAL replay, not consistency.
  *(Superseded by D693, 2026-10-01: the second test is gone. The first now
  expects the archive to REFUSE a live database with no owner, and still
  checks the file size across that walk.)*
- `shm-lock-canary.spec.ts` covers:
  - the `/proc/locks` parse, including the live 09-29 sample (database locked,
    `-shm` not);
  - the transition logging.

  On Linux (CI) it also runs the real kernel: the lock is seen held, then seen
  missing after one `closeSync` on the `-shm`. That block cannot run on a
  developer Mac and was not run before this record was written.
- Post-deploy, a passive check with no writes:
  - `/proc/locks` on the hub shows the runner's pid with a lock on the `-shm`
    inode covering byte 128;
  - the runner's log carries `SQLite shm DMS lock held`;
  - no `signal=SIGBUS` for `sqlite-settings` in `docker logs CamStack` after
    the next 03:00 backup.
