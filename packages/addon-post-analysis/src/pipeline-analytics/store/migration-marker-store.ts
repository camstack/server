/**
 * Where a boot migration remembers it COMPLETED — the `migrations` record kind.
 *
 * One row per migration (id = the migration's marker key), `{ completedAt }`.
 * A marker's PRESENCE is the fact: it stops a pass re-scanning the whole
 * analytics store on every boot, so a write that fails is logged by the caller
 * and costs a re-scan, never correctness (every pass is idempotent).
 */
import type { RecordKindHandle, RecordsAccess } from '@camstack/types'
import { type MigrationMarkerBody, pipelineAnalyticsRecordKinds } from '../record-kinds.js'

/** The seam the migration passes read and write through, so their specs need no engine. */
export interface MigrationMarkerPort {
  /** THROWS when the read fails — the caller treats that as "no marker yet". */
  readonly has: (key: string) => Promise<boolean>
  /** THROWS when the write fails — the caller logs it. */
  readonly set: (key: string, body: MigrationMarkerBody) => Promise<void>
}

export class MigrationMarkerStore implements MigrationMarkerPort {
  constructor(private readonly kind: RecordKindHandle<MigrationMarkerBody>) {}

  static of(records: Pick<RecordsAccess, 'kind'>): MigrationMarkerStore {
    return new MigrationMarkerStore(records.kind(pipelineAnalyticsRecordKinds.migrations))
  }

  readonly has = async (key: string): Promise<boolean> => (await this.kind.get(key)) !== null

  readonly set = async (key: string, body: MigrationMarkerBody): Promise<void> => {
    await this.kind.put({ id: key, data: body })
  }
}
