/**
 * The SQLite half of the boot-time restore (D693). Runs in the launcher,
 * BEFORE any runner exists — on databases nobody has open, which is the one
 * place a filesystem call may touch a `.db` / `-wal` / `-shm` (the D679 guard
 * names this file in its allowlist, with that reason).
 *
 * Two jobs, both about the sidecars SQLite pairs a database with on its first
 * open:
 *
 * 1. **Promote an owner snapshot.** An archive made since D693 carries
 *    `<db>.backup-snapshot` in place of the live database. It is a verified,
 *    self-contained copy (rollback journal, no sidecars). Restoring it means:
 *    delete the target's `<db>-wal`, `-shm` and `-journal`, then rename the
 *    snapshot over `<db>`.
 * 2. **Guard a legacy archive.** An archive from before D693 carries `<db>`
 *    as a file, sometimes without its `-wal`. Whatever sidecar the archive did
 *    NOT bring is deleted from the target.
 *
 * Why the sidecars must go: a `-wal` left by the database being replaced (a
 * crash, a kill, a runner that never checkpointed) has valid frames, and
 * SQLite replays them onto whatever file sits beside it. The restored copy
 * would come up as a mix of two databases.
 *
 * Zero `@camstack/*` runtime imports, like the launcher that calls it. The
 * suffix is spelled here and pinned to `DATABASE_SNAPSHOT_SUFFIX` by
 * `pending-restore-sqlite.spec.ts`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Mirrors `DATABASE_SNAPSHOT_SUFFIX` in `@camstack/types` (spec-pinned). */
export const SQLITE_SNAPSHOT_SUFFIX = '.backup-snapshot'

const SIDECARS = ['-wal', '-shm', '-journal'] as const
const DATABASE_SUFFIXES = ['.db', '.sqlite', '.sqlite3'] as const

/** What one extraction calls for, as archive-relative paths. */
export interface SqliteRestorePlan {
  /** Snapshots to rename over the database they copy. */
  readonly promote: readonly string[]
  /** Database → the sidecars to delete beside it (those the archive did not bring). */
  readonly dropSidecars: ReadonlyMap<string, readonly string[]>
}

/** Decide, from the paths an extraction wrote, what the target needs. */
export function planSqliteRestore(extracted: readonly string[]): SqliteRestorePlan {
  const written = new Set(extracted)
  const promote: string[] = []
  const dropSidecars = new Map<string, readonly string[]>()
  for (const rel of written) {
    if (rel.endsWith(SQLITE_SNAPSHOT_SUFFIX)) {
      const database = rel.slice(0, -SQLITE_SNAPSHOT_SUFFIX.length)
      promote.push(rel)
      // Whatever sits beside the target belongs to the database being replaced.
      dropSidecars.set(database, [...SIDECARS])
    } else if (DATABASE_SUFFIXES.some((suffix) => rel.endsWith(suffix))) {
      const missing = SIDECARS.filter((sidecar) => !written.has(rel + sidecar))
      if (missing.length > 0 && !dropSidecars.has(rel)) dropSidecars.set(rel, missing)
    }
  }
  return { promote: promote.sort(), dropSidecars }
}

/** Make the entries just removed or renamed in `dir` durable. */
function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Apply a plan under `dataDir`. Each deletion and promotion is one log line,
 * and each touched directory is fsynced before the caller clears its marker —
 * a power cut after "Restore complete" must not bring the stale WAL back.
 */
export function applySqliteRestore(
  dataDir: string,
  plan: SqliteRestorePlan,
  log: (line: string) => void,
  syncDirectory: (dir: string) => void = fsyncDirectory,
): void {
  const touched = new Set<string>()
  for (const [database, sidecars] of plan.dropSidecars) {
    for (const sidecar of sidecars) {
      const stale = path.join(dataDir, database + sidecar)
      if (!fs.existsSync(stale)) continue
      fs.rmSync(stale, { force: true })
      touched.add(path.dirname(stale))
      log(
        `[launcher] Restore: dropped stale ${database}${sidecar} — it belonged to the database being replaced`,
      )
    }
  }
  for (const snapshot of plan.promote) {
    const database = snapshot.slice(0, -SQLITE_SNAPSHOT_SUFFIX.length)
    fs.renameSync(path.join(dataDir, snapshot), path.join(dataDir, database))
    touched.add(path.dirname(path.join(dataDir, database)))
    log(`[launcher] Restore: promoted the owner snapshot ${snapshot} → ${database}`)
  }
  for (const dir of touched) {
    // A durability nicety, never a reason to abort boot — a launcher that
    // threw here would fail every boot while the marker stays.
    try {
      syncDirectory(dir)
    } catch (err) {
      log(`[launcher] WARNING Restore: could not fsync ${dir} (${String(err)}) — continuing`)
    }
  }
}

/**
 * The snapshots an archive's manifest PROMISES (archive-relative) that the
 * extraction did not write. One the caller's location filter left out is a
 * choice; one inside the chosen locations is a database that was not restored.
 */
/** Promised snapshots the extraction did not write, split by why. */
export interface PromisedSnapshotCheck {
  /** Inside the chosen locations: those databases were NOT restored. */
  readonly missing: readonly string[]
  /** Left out by the operator's location choice. */
  readonly outOfScope: readonly string[]
}

export function missingPromisedSnapshots(
  promised: readonly string[],
  extracted: readonly string[],
  inScope: (rel: string) => boolean,
): PromisedSnapshotCheck {
  const written = new Set(extracted)
  const missing: string[] = []
  const outOfScope: string[] = []
  for (const rel of promised) {
    if (written.has(rel)) continue
    if (inScope(rel)) missing.push(rel)
    else outOfScope.push(rel)
  }
  return { missing, outOfScope }
}
