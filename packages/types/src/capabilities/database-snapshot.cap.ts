import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { DataStoreDatabaseSchema } from './settings-store.cap.js'

/**
 * The suffix of a verified snapshot, written next to the live database it
 * copies: `<db>.backup-snapshot`. A restore promotes it back over `<db>`
 * (`server/backend/src/sqlite-restore.ts` spells the same string — the
 * launcher stays free of `@camstack/*` runtime imports — and a spec pins the
 * two together).
 */
export const DATABASE_SNAPSHOT_SUFFIX = '.backup-snapshot'

/**
 * The suffix of a copy still being written or verified. A file under this name
 * is never archived and never promoted: only a copy that passed every check is
 * renamed to {@link DATABASE_SNAPSHOT_SUFFIX}.
 */
export const DATABASE_SNAPSHOT_PARTIAL_SUFFIX = '.backup-snapshot-partial'

/**
 * How long one snapshot may take end to end: the pinned copy of the whole
 * database plus `PRAGMA integrity_check` over the copy, on the hub's slowest
 * disk. ~800 MB at a pessimistic 10 MB/s is under 3 minutes; the bound is
 * generous because a timeout fails the whole backup run.
 */
export const DATABASE_SNAPSHOT_TIMEOUT_MS = 30 * 60_000

/**
 * The databases an owner snapshots — declared by the OWNER, so a caller never
 * guesses which file is live from what sits beside it (a cleanly closed
 * database has no sidecars and is just as owned). Paths are absolute on the
 * owner's host.
 */
export const DatabaseSnapshotTargetsSchema = z.object({
  databases: z.array(
    z.object({
      /** Which owned file this is — the handle `writeSnapshot` takes. */
      databaseId: DataStoreDatabaseSchema,
      livePath: z.string(),
    }),
  ),
})
export type DatabaseSnapshotTargets = z.infer<typeof DatabaseSnapshotTargetsSchema>

/** One b-tree table of the snapshot and the rows it holds. */
export const DatabaseSnapshotTableSchema = z.object({
  name: z.string(),
  rows: z.number().int().nonnegative(),
})
export type DatabaseSnapshotTable = z.infer<typeof DatabaseSnapshotTableSchema>

/**
 * What the owner wrote. Every path is ABSOLUTE on the owner's host — the
 * caller pins the call to its own node, so it can read the file; a caller
 * that finds the path outside its own data root refuses it rather than
 * archiving something it cannot place.
 */
export const DatabaseSnapshotResultSchema = z.object({
  /** The live database the snapshot copies. Never to be copied as a file. */
  livePath: z.string(),
  /** The verified copy: `<livePath>` + {@link DATABASE_SNAPSHOT_SUFFIX}. */
  snapshotPath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  /**
   * Every b-tree table with its row count. Read inside the SAME read
   * transaction the copy was taken from, and found EQUAL on the copy — so
   * this is the content of the snapshot, not an estimate of the source.
   */
  tables: z.array(DatabaseSnapshotTableSchema),
  /** Wall time of the pinned copy (row counts included). */
  copyMs: z.number().nonnegative(),
  /** Wall time of the checks on the copy (`integrity_check`, row counts). */
  verifyMs: z.number().nonnegative(),
  /** When the pinned read transaction began (ms epoch) — the snapshot's instant. */
  takenAt: z.number(),
})
export type DatabaseSnapshotResult = z.infer<typeof DatabaseSnapshotResultSchema>

/** A snapshot the owner wrote, with the file it belongs to. */
export const DatabaseSnapshotWrittenSchema = DatabaseSnapshotResultSchema.extend({
  databaseId: DataStoreDatabaseSchema,
})
export type DatabaseSnapshotWritten = z.infer<typeof DatabaseSnapshotWrittenSchema>

/** Which database `writeSnapshot` copies. Required: an unstated ask is not guessed. */
export const DatabaseSnapshotRequestSchema = z.object({ databaseId: DataStoreDatabaseSchema })
export type DatabaseSnapshotRequest = z.infer<typeof DatabaseSnapshotRequestSchema>

/**
 * A snapshot as an ARCHIVE records it (`ArchiveManifest.sqliteSnapshots`):
 * the same facts, with both paths relative to the archive root (the node's
 * data dir), because an archive outlives the host that made it.
 */
export const ArchiveSqliteSnapshotSchema = DatabaseSnapshotResultSchema.extend({
  /** Archive-relative path of the live database the archive does NOT carry. */
  livePath: z.string(),
  /** Archive-relative path of the verified copy it carries in its place. */
  snapshotPath: z.string(),
  /** Absent on an archive made before several files were owned: that was `settings`. */
  databaseId: DataStoreDatabaseSchema.optional(),
})
export type ArchiveSqliteSnapshot = z.infer<typeof ArchiveSqliteSnapshotSchema>

/**
 * database-snapshot — the OWNER of a live SQLite database writes a consistent,
 * verified copy of it (D693).
 *
 * A live database cannot be copied as files: three files written by a live
 * process cannot be read at one instant from outside it, and a tar of the
 * `.db` / `-wal` / `-shm` trio was measured torn in 6/6 archives (D679). Nor may
 * another process open it (D679 rule 2). So the process that owns the
 * connection writes the copy — through its own connection, on a thread,
 * pinned to one read transaction — and checks it before handing it out.
 *
 * Hub-only and internal: `sqlite-settings` is the registrant, and its consumer
 * is `backup-orchestrator`, which calls it pinned to its own node so the path
 * it gets back is on its own host. `auth: 'admin'` explicitly — `internal`
 * does not gate the mount (see `data-store-provider`).
 */
export const databaseSnapshotCapability = {
  name: 'database-snapshot',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /**
     * EVERY database file this owner has open, with its id. Answered from
     * memory — no file is touched — so a backup can ask it before deciding
     * anything. A file created at runtime is listed from the moment it opens,
     * so no backup can leave it out (D693).
     */
    listDatabases: method(z.object({}), DatabaseSnapshotTargetsSchema, { auth: 'admin' }),
    /**
     * Write `<db>.backup-snapshot` for ONE database and return what it holds.
     * Throws — and leaves no file under the final name — when the copy fails
     * `integrity_check` or its row counts differ from the pinned source's, or
     * when the database is not open. A second call for the SAME database while
     * one is running joins it; different databases run one after the other
     * (the disk reserve check is per copy).
     */
    writeSnapshot: method(DatabaseSnapshotRequestSchema, DatabaseSnapshotWrittenSchema, {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: DATABASE_SNAPSHOT_TIMEOUT_MS,
    }),
  },
} as const satisfies CapabilityDefinition

export type IDatabaseSnapshotProvider = InferProvider<typeof databaseSnapshotCapability>
