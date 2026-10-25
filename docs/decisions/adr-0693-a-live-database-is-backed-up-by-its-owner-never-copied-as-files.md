---
id: D693
title: A live SQLite database is backed up by its owner, as a verified snapshot — never copied as files
status: accepted
date: 2026-10-01
last-verified: 2026-10-15
supersedes: D679 (only its rule-2 sentence "the `.db`, `-wal` and `-shm` are tarred as they are"; both of D679's rules stand)
applies-to:
  - packages/types/src/capabilities/database-snapshot.cap.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-snapshotter.ts
  - packages/system/src/builtins/system-backup/system-backup.service.ts
  - server/backend/src/sqlite-restore.ts
  - server/backend/src/pending-restore.ts
  - scripts/check-sqlite-files-not-opened-by-fs.ts
covers:
  - packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts
  - packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts
  - server/backend/src/launcher.ts
---

## Context

**Most nightly archives of the settings database could not be restored to an
intact database.** The 03:00 backup is a tar of the data directory, and it
carried `addons-data/sqlite-settings/camstack.db`, `-wal` and `-shm` as plain
files while `hub/sqlite-settings` kept writing. D679's reviewer reproduced it
with the service's own tar call, a writer process and the real checkpoint
worker, then ran `PRAGMA integrity_check` on each extracted archive: torn in
**6/6** archives after D679, and in **9/9** with the pre-D679 code. The damage
was page double-references, rowid order and missing index rows.

The mechanism is in the file order. Tar reads the `.db` first and the `-wal`
after it. A checkpoint fold during the `.db` read rewrites pages behind tar's
cursor. The next write then restarts the WAL, so the frames that would repair
those pages are gone before tar reaches the `-wal`. No file-level copy can fix
this. Three files written by a live process cannot be read at one instant from
outside it.

**What was tried, and why it could not work:**

- **A checkpoint from hub-main before the tar** (until 2026-09-29). It ran
  before the copy, so it never covered it (9/9 torn). It was also a second
  connection to a live database, the SIGBUS trigger of D679.
- **Tarring the files as they are** (D679). This is torn by construction.
  D679 says so and files this record's change as its HIGH follow-up.

**Alternatives rejected here:**

- **Hub-main opens a read-only connection and calls the backup API.** That is
  a second connection from another process, so it breaks D679 rule 2. A
  read-only open still takes part in the wal-index protocol that SIGBUSed the
  runner.
- **`VACUUM INTO` or `db.backup()` on the settings connection itself.**
  `VACUUM INTO` is one synchronous statement. Run on the settings thread, it
  stalls every configuration read in the cluster for as long as an
  ~800 MB rebuild takes (the D447 failure). `db.backup()` steps in 100-page
  slices on the event loop, but the integrity check of the copy is again one
  synchronous call of tens of seconds. So the work runs on a thread.
- **A worker connection that copies in many steps without a pinned read.**
  Every write by the settings connection between two steps restarts the copy
  from page 1. On a hub that writes every second, it would never finish.
- **A separate snapshot store with its own rotation.** That makes a second
  retention authority next to the destination policy's `retentionCount`, and a
  second place to look on restore. The snapshot travels inside the archive
  instead, and the archive's existing retention rotates it.
- **Fall back to the file copy when the snapshot fails.** A run that
  "succeeded" with a torn database pushes the oldest GOOD archive out of
  retention. A failed snapshot fails the run before anything is uploaded, so
  retention never runs on that night.

## Decision

**A live SQLite database leaves its host only as a snapshot written by the
process that owns it. The snapshot is taken through the owner's own
connection, pinned to one read transaction, verified, and carried in the
archive in place of the live files. Nothing else ever copies the live
files.**

1. **The owner declares it, and writes it.** `hub/sqlite-settings` serves the
   `database-snapshot` capability (admin, internal): `listDatabases` names the
   files it owns (from memory), and `writeSnapshot` writes the copy. A worker
   thread of the runner opens its own read-only connection; D679 allows this,
   the same as the checkpoint worker. It runs `BEGIN`, counts the rows of every
   b-tree table, and then runs the online backup API
   (`better-sqlite3 db.backup()`) inside that SAME read transaction. Every step
   reads the one pinned WAL snapshot. Writes on the settings connection go on
   (WAL readers block no writer), and the copy does not restart. The row
   counts and the copy describe the same instant.
2. **It is verified before it exists, and it may not endanger the live
   database.** Before anything is copied, the free space on the database's
   disk must cover the copy (database + WAL) plus a reserve the size of the
   database (at least 256 MiB); otherwise the call is refused as `no-space`.
   A free space that could not be measured is `null`, never 0 (D393), and is
   refused too: the backup does not gamble the disk the live settings write
   to. The copy is written in the work directory
   `<db>.backup-snapshot-partial/`. It is switched to `journal_mode = DELETE`,
   and the pragma's answer must be `delete` (one self-contained file, no
   sidecars). Then `PRAGMA integrity_check` must answer exactly `ok`, and every
   table's row count must EQUAL the count read in the pinned transaction. Only
   then is the copy renamed to `<db>.backup-snapshot` (directory fsynced). A
   failed check deletes the work directory, and the call throws with the
   reason (`integrity`, `row-count`, `no-space` or `failed`). A file under the
   final name is always a verified copy. A thread that has not answered at its
   deadline (a minute under the capability's 30-minute timeout) gets the call
   refused AT ONCE, with a WARN, and is terminated in the background. A native
   SQLite call cannot be interrupted, so the termination may take as long as
   that call; until it settles, a new snapshot is refused immediately ("the
   previous snapshot thread is still terminating") — never joined to the stuck
   one, never started beside it — and the work directory is removed only
   after it settles. A snapshot
   nobody collected — the caller timed out, the hub died mid-run — is removed
   when the runner boots and before its next snapshot.
3. **The archive carries the snapshot, not the database.**
   `SystemBackupService.createArchive` walks the requested locations. When
   the walk finds a SQLite file, it asks the `owner` which databases it owns —
   the owner's word, not a guess from what sits beside a file: a cleanly
   closed database has no sidecar and is just as owned. For the owned
   databases in scope it asks for the snapshot once. `backup-orchestrator`
   answers both with `database-snapshot`, pinned to its own node
   (`nodePin(localNodeId)`), so the paths it gets back are on its own host.
   The archive then:
   - leaves out the live `.db`, `-wal`, `-shm` and `-journal`, from the tar
     and from the manifest alike;
   - carries the snapshot at its own path;
   - records it in the manifest (`sqliteSnapshots`: live path, snapshot path,
     pages, tables, rows, timings).

   A snapshot that is not on the archive's data root, not beside an owned
   database, or not covering EVERY owned database in scope, is refused and
   deleted. A `.backup-snapshot*` file the run did not ask for is never
   archived. `createArchive` deletes the snapshot once the archive is built,
   on every path out. Retention is the destination's own `retentionCount`,
   unchanged.
4. **An archive that would lack a live database is not built.**
   `createArchive` throws `BackupSnapshotRefusedError` before anything is
   built — so nothing is uploaded and no retention prune runs — when the owner
   cannot say what it owns, when its snapshot fails, and when a database with
   a sidecar beside it (live, or left mid-write) has no owner. The
   orchestrator records the reason on every selected destination
   (`last_error`, D384). Neither a torn archive nor one without the database
   is ever the fallback: either would prune an older archive that has it.
   A sidecar counts only beside a name that is a database (`.db`, `.sqlite`,
   `.sqlite3`): a `build-journal` stops nothing.

   **Hub-main deletes only paths it derives itself:** `<owned database>` +
   `.backup-snapshot` under its own data root. A path the owner ANSWERS is
   validated, never deleted on its word — an answer naming the live database
   as the snapshot would otherwise delete the live database from another
   process. When the snapshot call fails, or its answer is refused, the
   derived names are removed; anything elsewhere is left to the owner's sweep
   (WARN). A cancel is honoured while the owner is still copying: the call is
   abandoned, the run stops at once, and the copy the owner finishes later is
   removed by its derived name when that call settles.
5. **A restore puts the consistent copy back, and drops what would corrupt
   it.** The boot-time restore (`server/backend/src/pending-restore.ts`,
   called by the launcher before any runner starts) extracts the archive and
   hands what it wrote to `server/backend/src/sqlite-restore.ts`, which handles
   two cases:
   - for every `<db>.backup-snapshot` it extracted, it deletes the target's
     `<db>-wal`, `-shm` and `-journal`, then renames the snapshot over `<db>`;
   - for a LEGACY archive's `<db>` that came without its `-wal`, it deletes
     the target's stale `-wal` and `-shm`.

   Left in place, a stale `-wal` from the database being replaced would be
   replayed onto the restored file. Each touched directory is fsynced before
   the marker is cleared. The restore also reads the archive's manifest (its
   first entry) and, before "Restore complete", logs a `WARNING` for every
   snapshot the manifest promised inside the chosen locations that the
   extraction did not write: that database was NOT restored.

## Consequences

- The snapshot costs a second copy of the database on the same disk while the
  archive is built: about 800 MB on the hub, on the `sqlite-settings` bind —
  the disk the live settings write to. Run full, it would fail every settings
  write in the cluster (`SQLITE_FULL`) until the copy is removed; that is why
  the `no-space` check runs first and keeps a database-sized reserve. The cost
  of the check: a hub with less than about 2× the database free (≈ 1.6 GB on
  the hub) gets no settings backup at all, loudly, until space is freed.
  `createArchive` deletes the snapshot once the archive is built; a leftover
  is swept by the runner at boot and before its next snapshot, and no archive
  carries it unannounced.
- A terminated snapshot thread: `worker.terminate()` settles once the thread
  is gone, and better-sqlite3 closes the thread's connections on its teardown,
  which releases the pinned read. A thread stuck inside one synchronous SQLite
  call is stopped only when that call returns — until then its pinned read
  holds back checkpoints and the runner refuses new snapshots. A call that
  never returns is a runner that needs a respawn; the refusals say so every
  night.
- **Known limitation: a termination that never settles.** If the timed-out
  thread is stuck in a native call that never returns, the snapshotter stays
  draining until the runner restarts. Every later backup is refused, loudly
  ("the previous snapshot thread is still terminating"). The work directory, a
  partial copy, stays on the disk until the boot sweep. This is intended: a
  thread that may still hold a pinned read must not get a second one beside
  it. A periodic WARN while draining would help the operator, and is not
  built.
- **Known limitation: a cancel followed at once by a re-run.** The re-run can
  JOIN the runner's snapshot still in flight. The cancelled run's late cleanup
  then removes the derived `<db>.backup-snapshot` that the re-run is about to
  archive. The re-run fails loudly (ENOENT) and records it on its
  destinations. Nothing is corrupted, and the window is narrow. A fix would be
  to let the abandoned cleanup skip a name that a newer run holds; it is not
  built.
- A failed directory fsync (snapshot or restore) is a WARN, never fatal: the
  restore runs at boot, and a throw there would abort every boot while the
  marker stays.
- The pinned read transaction holds back checkpoints for as long as the copy
  takes. The WAL grows by the writes of that window. PASSIVE folds resume
  where they stopped, and the window is seconds to tens of seconds.
- The snapshot is defragmented by nothing. It is a page copy, the same size
  as the database.
- `SystemBackupService.extractArchive` is deleted. No production code called
  it. Its docblock said "used at boot by the restore hook", but the launcher
  never called it. Kept, it would have restored a new archive WITHOUT
  promoting its snapshot: a restore with no settings database. The launcher's
  restore is the only one. It moved out of `launcher.ts` (which runs itself on
  import, so no spec could load it) into `pending-restore.ts`, unchanged
  except for the SQLite step.
- A live database that no owner declares STOPS every backup that covers it,
  by name. On the hub there is one, `sqlite-settings`'s, and it is declared.
  A second one would show up as failed nightly runs naming it — loud by
  design, because the alternatives (a torn copy, or an archive without it
  that prunes one with it) are both silent losses.
- The `database-snapshot` capability is hub-only. An agent boots no
  `sqlite-settings` (it forwards to the hub's door) and runs no backup.
- A change to `@camstack/types` and `@camstack/system` is live only after a
  `@camstack/server` that contains it is installed (D16).
- Archives made before this change still contain the torn trio. Restoring one
  is still a gamble: follow it with `PRAGMA integrity_check`, as D679 says.

## Enforcement

- `scripts/check-sqlite-files-not-opened-by-fs.ts` (D679's guard). The
  snapshot worker is the third file allowed a SQLite driver import. The
  launcher-side restore (`sqlite-restore.ts`) is the first
  `SQLITE_GUARD_ALLOWLIST` entry, for `fs-on-sqlite-file`, with its reason:
  it runs before any runner exists, on a database nobody has open.
- `packages/system/src/builtins/sqlite-storage/__tests__/sqlite-snapshot-copy.spec.ts`
  covers the copy and its checks, in-process, over real SQLite:
  - the pinned copy excludes a write committed by another connection
    between two steps (red with the `BEGIN` removed: 4001 rows ≠ 4000);
  - the copy ends as one file, rollback journal, no sidecars (red without
    the `journal_mode` switch);
  - an `integrity_check` failure is refused as `integrity`, and a count or
    table mismatch as `row-count` (each red with its gate removed).
- `…/__tests__/sqlite-snapshot-under-concurrent-writes.spec.ts` runs the REAL
  snapshot worker and the REAL checkpoint worker while a writer commits
  transfers the whole time: once on another connection in the owning
  process, once from a child process (`support/transfer-writer.mjs`). Every
  transfer keeps two invariants: the sum of balances is constant, and
  `ledger` equals `audit`. The snapshot must hold both, pass
  `integrity_check`, report exactly its own row counts, and overlap a
  non-zero number of commits. With the read pin removed, both cases are
  refused as `row-count`.
  The same spec covers the refusals before any copy: `no-space` with one
  byte short of the need, and with a `statfs` that fails (red with the check
  removed, and red with unknown read as plenty); the deadline terminating a
  thread that never answers, with the next snapshot a fresh run (red without
  the deadline: the test times out); and the sweep of a snapshot nobody
  collected, at boot and before the next snapshot (red without it). The
  copy spec pins the journal-mode answer (red without the check). The stalled
  thread writes a heartbeat; after the deadline the heartbeat must STOP (red
  when `terminate()` is replaced by a no-op), and a thread whose `terminate()`
  never settles still gets an immediate refusal, and the next snapshot is
  refused at once (red when the refusal awaits the termination, and red
  without the draining refusal). A failing directory fsync leaves a verified
  snapshot and a WARN (red when it throws).
- `…/system-backup/__tests__/system-backup.service.spec.ts` checks the
  archive:
  - it carries `<db>.backup-snapshot` and none of the live trio, records the
    snapshot, and deletes it afterwards;
  - an owned database closed cleanly (no sidecar) is still snapshotted, never
    tarred (red when "owned" is read from the sidecar);
  - an owned database's `-journal` is never archived (red without it);
  - a live database with no owner builds nothing (red when it is let through);
  - an owner that cannot say what it owns, or whose snapshot fails, builds
    nothing, and the snapshot it may still finish is removed (red without
    the removal); a cancel during the copy deletes the copy;
  - the owner is not asked when no SQLite file is in scope;
  - an off-root snapshot is refused and the file the owner named is KEPT;
    an answer naming the live database as its own snapshot is refused and
    the live database is untouched (both red when the answered path is
    deleted);
  - a file that merely ends in `-journal` / `-wal` does not stop the
    archive (red without the database-name check);
  - a cancel while the owner copies rejects at once, and the late copy is
    removed when it lands (red without the race);
  - unannounced snapshots and work directories are never archived.

  A cancel check after the snapshot was removed because no test could tell
  it apart: the tar pipeline aborts on the signal anyway.
- `…/backup-orchestrator/__tests__/settings-db-enters-a-backup-only-as-its-owners-snapshot.spec.ts`
  drives the real addon with a typed context and a real `CapabilityRegistry`:
  - a refused snapshot uploads nothing, fails the run, and puts the reason in
    the destination's `lastError`;
  - a good run calls `listDatabases` and `writeSnapshot` with
    `nodePin('hub')` and deletes the snapshot.

  It is red without the owner, and red without the refusal record.
- `server/backend/src/__tests__/pending-restore-sqlite.spec.ts` runs the real
  `applyPendingRestore` over a real archive and a crashed target database
  whose rows live only in its `-wal`. It checks four cases:
  - a promoted snapshot comes up intact with exactly its own rows. With the
    sidecar drop removed, the first open replays the replaced database's
    300 rows instead of the snapshot's 40;
  - a legacy `.db` with no `-wal` has the stale one dropped;
  - a legacy `-wal` that came in the archive is kept;
  - a partial restore touches nothing.

  It also pins the launcher's suffix to `DATABASE_SNAPSHOT_SUFFIX`, and
  checks the manifest cross-check: a promised snapshot the archive did not
  carry is a `WARNING … NOT restored` before "Restore complete" (red with the
  manifest unread, and red with the report removed), and one a partial
  restore left out is named without the warning. A directory fsync that
  fails is a WARNING and the restore completes (red when it throws). That an
  fsync happens at all has no test: nothing observable short of a power cut
  distinguishes it.
- Not covered by a test: a cap call that really crosses the UDS to the
  runner (the orchestrator spec fakes `ctx.api`). Also untested: the
  snapshot's duration on the hub's ~800 MB database. The `SQLite snapshot
  written and verified` INFO line (`copyMs`, `verifyMs`) is the field
  measurement after deploy.
