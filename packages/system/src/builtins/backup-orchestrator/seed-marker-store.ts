/**
 * "This seed has run, once, ever" (D728, D852).
 *
 * A seed that decides from the data alone re-creates what the operator deleted
 * on the next boot. The marker is the orchestrator's own records row (D62: no
 * new authority), one per seed id, written AFTER the seeded row landed. A read that fails THROWS: "could not read the
 * marker" must never look like "never seeded".
 */
import type { RecordKindHandle } from '@camstack/types'
import { backupOrchestratorRecordKinds, type BackupSeedMarkerBody } from './record-kinds.js'

/** The slice of the marker store a seed needs. */
export interface SeedMarkers {
  has(seedId: string): Promise<boolean>
  mark(seedId: string): Promise<void>
}

/**
 * One `seed-markers` row per seed id (D902: no `backup_seed_markers` table).
 * Written once, never updated; deleting one lets that seed run once more.
 */
export class BackupSeedMarkerStore implements SeedMarkers {
  constructor(
    private readonly markersKind: RecordKindHandle<BackupSeedMarkerBody>,
    private readonly now: () => number = Date.now,
  ) {}

  async has(seedId: string): Promise<boolean> {
    return (await this.markersKind.get(seedId)) !== null
  }

  async mark(seedId: string): Promise<void> {
    if (await this.has(seedId)) return
    const body: BackupSeedMarkerBody = { seededAt: this.now() }
    const data = backupOrchestratorRecordKinds['seed-markers'].schema.parse(body)
    await this.markersKind.put({ id: seedId, data })
  }
}
