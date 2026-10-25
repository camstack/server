/**
 * The `database-snapshot` provider of the SQLite engine: every owned database
 * file it has open is listed, and each is snapshotted through its OWN
 * connection (D679, D693) — never by copying files.
 *
 * The list is read from the router at CALL time, not at boot: a file created at
 * runtime (the first declaration that names `events` or `history`) is listed
 * from the moment it opens, so no backup can leave it out.
 */
import path from 'node:path'
import type {
  DatabaseSnapshotRequest,
  DatabaseSnapshotTargets,
  DatabaseSnapshotWritten,
  DataStoreDatabase,
  IDatabaseSnapshotProvider,
} from '@camstack/types'
import type { OwnedSqliteFile } from './owned-sqlite-file.js'

/** What the provider needs from an owned file. */
export type SnapshotableFile = Pick<OwnedSqliteFile, 'databaseId' | 'livePath' | 'snapshot'>

/** What the provider needs from the placement router. */
export interface OpenFileSource {
  openFiles(): readonly SnapshotableFile[]
}

export class DatabaseSnapshotProvider implements IDatabaseSnapshotProvider {
  /** Same database asked twice: the second call joins the first. */
  private readonly inFlight = new Map<DataStoreDatabase, Promise<DatabaseSnapshotWritten>>()
  /** Different databases run one after the other: the disk reserve check is per copy. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly source: OpenFileSource) {}

  async listDatabases(): Promise<DatabaseSnapshotTargets> {
    return {
      databases: this.source.openFiles().map((file) => ({
        databaseId: file.databaseId,
        livePath: path.resolve(file.livePath),
      })),
    }
  }

  writeSnapshot(input: DatabaseSnapshotRequest): Promise<DatabaseSnapshotWritten> {
    const running = this.inFlight.get(input.databaseId)
    if (running !== undefined) return running
    const file = this.source.openFiles().find((f) => f.databaseId === input.databaseId)
    if (file === undefined) {
      return Promise.reject(
        new Error(`database snapshot refused: database "${input.databaseId}" is not open`),
      )
    }
    const run = this.tail
      .catch(() => undefined)
      .then(async (): Promise<DatabaseSnapshotWritten> => {
        const result = await file.snapshot()
        return { ...result, databaseId: file.databaseId }
      })
    this.tail = run
    const tracked = run.finally(() => {
      this.inFlight.delete(input.databaseId)
    })
    this.inFlight.set(input.databaseId, tracked)
    return tracked
  }
}
