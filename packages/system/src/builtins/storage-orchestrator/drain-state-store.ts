/**
 * Durable home for the drain ratchet (D386).
 *
 * The cap MUST survive a restart. Recomputing it from today's usage would
 * restart the ratchet at the top of the disk and silently undo every byte of
 * progress — the operator would see a drain that never finishes and no line
 * saying why. So the cap, the drain start and the observed growth are persisted
 * on every sweep, through the same `settings-store` door the location table
 * uses.
 */
import type {
  CollectionColumn,
  ISettingsStoreProvider,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import type { DrainState } from './drain-ratchet.js'
import { storageOrchestratorRecordKinds, type StorageDrainStateBody } from './record-kinds.js'
import type { DrainStateStore } from './storage-pressure-manager.js'

/**
 * @durable class=config owner=storage-orchestrator
 *   write="one row per location the operator has switched to `drain`, rewritten on every pressure sweep (60 s) while it drains"
 *   retention="the row is deleted the moment the location leaves `drain` mode. Bounded by the number of disks a human is retiring at once."
 */
const STORAGE_DRAIN_STATE = 'storage_drain_state'

const STORAGE_DRAIN_STATE_COLUMNS: readonly CollectionColumn[] = [
  { name: 'location_id', type: 'TEXT', primaryKey: true },
  { name: 'started_at_ms', type: 'INTEGER', notNull: true },
  { name: 'start_bytes', type: 'INTEGER', notNull: true },
  { name: 'cap_bytes', type: 'INTEGER', notNull: true },
  // Nullable on purpose: `null` means "never measured", which is a different
  // answer from zero and must not be allowed to look like no growth.
  { name: 'last_peer_bytes', type: 'INTEGER' },
  { name: 'last_sweep_ms', type: 'INTEGER', notNull: true },
  { name: 'observed_growth_bytes', type: 'INTEGER', notNull: true, defaultValue: 0 },
  { name: 'observed_elapsed_ms', type: 'INTEGER', notNull: true, defaultValue: 0 },
]

/** A finite number off a persisted row, or the documented fallback. A row
 *  written by a hand-edit must never become a cap. */
function num(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function mapRow(row: Record<string, unknown>): DrainState | null {
  const locationId = String(row['location_id'] ?? '')
  if (!locationId) return null
  const lastPeerRaw = row['last_peer_bytes']
  return {
    locationId,
    startedAtMs: num(row['started_at_ms'], 0),
    startBytes: num(row['start_bytes'], 0),
    capBytes: num(row['cap_bytes'], 0),
    lastPeerBytes:
      typeof lastPeerRaw === 'number' && Number.isFinite(lastPeerRaw) ? lastPeerRaw : null,
    lastSweepMs: num(row['last_sweep_ms'], 0),
    observedGrowthBytes: num(row['observed_growth_bytes'], 0),
    observedElapsedMs: num(row['observed_elapsed_ms'], 0),
  }
}

function mapState(state: DrainState): Record<string, unknown> {
  return {
    location_id: state.locationId,
    started_at_ms: state.startedAtMs,
    start_bytes: state.startBytes,
    cap_bytes: state.capBytes,
    last_peer_bytes: state.lastPeerBytes,
    last_sweep_ms: state.lastSweepMs,
    observed_growth_bytes: state.observedGrowthBytes,
    observed_elapsed_ms: state.observedElapsedMs,
  }
}

function drainStateToBody(state: DrainState): StorageDrainStateBody {
  return {
    locationId: state.locationId,
    startedAtMs: state.startedAtMs,
    startBytes: state.startBytes,
    capBytes: state.capBytes,
    lastPeerBytes: state.lastPeerBytes,
    lastSweepMs: state.lastSweepMs,
    observedGrowthBytes: state.observedGrowthBytes,
    observedElapsedMs: state.observedElapsedMs,
  }
}

function bodyToDrainState(body: StorageDrainStateBody): DrainState | null {
  if (!body.locationId) return null
  return {
    locationId: body.locationId,
    startedAtMs: body.startedAtMs,
    startBytes: body.startBytes,
    capBytes: body.capBytes,
    lastPeerBytes: body.lastPeerBytes,
    lastSweepMs: body.lastSweepMs,
    observedGrowthBytes: body.observedGrowthBytes,
    observedElapsedMs: body.observedElapsedMs,
  }
}

/** {@link DrainStateStore} on the `settings-store` collection surface. */
export class SqliteDrainStateStore implements DrainStateStore {
  private declared = false
  private readonly drainKind: RecordKindHandle<StorageDrainStateBody> | null

  constructor(
    private readonly store: ISettingsStoreProvider,
    drainKind: RecordKindHandle<StorageDrainStateBody> | null = null,
  ) {
    this.drainKind = drainKind
  }

  static recordStoresOf(
    records: Pick<RecordsAccess, 'kind'>,
  ): RecordKindHandle<StorageDrainStateBody> {
    return records.kind(storageOrchestratorRecordKinds['drain-state'])
  }

  private async ensureDeclared(): Promise<void> {
    if (this.drainKind !== null) return
    if (this.declared) return
    await this.store.declareCollection({
      collection: STORAGE_DRAIN_STATE,
      columns: STORAGE_DRAIN_STATE_COLUMNS,
    })
    this.declared = true
  }

  async load(): Promise<readonly DrainState[]> {
    await this.ensureDeclared()
    const kind = this.drainKind
    if (kind !== null) {
      const out: DrainState[] = []
      for (const row of await readAllRows(kind)) {
        const mapped = bodyToDrainState(row.data)
        if (mapped) out.push(mapped)
      }
      return out
    }
    const rows = await this.store.query({ collection: STORAGE_DRAIN_STATE })
    const out: DrainState[] = []
    for (const row of rows) {
      const mapped = mapRow(row.data)
      if (mapped) out.push(mapped)
    }
    return out
  }

  async save(state: DrainState): Promise<void> {
    await this.ensureDeclared()
    const kind = this.drainKind
    if (kind !== null) {
      const body = drainStateToBody(state)
      const data = storageOrchestratorRecordKinds['drain-state'].schema.parse(body)
      await kind.put({ id: state.locationId, data })
      return
    }
    await this.store.deleteWhere({
      collection: STORAGE_DRAIN_STATE,
      filter: { where: { location_id: state.locationId } },
    })
    await this.store.insert({
      collection: STORAGE_DRAIN_STATE,
      record: { id: state.locationId, data: mapState(state) },
    })
  }

  async clear(locationId: string): Promise<void> {
    await this.ensureDeclared()
    const kind = this.drainKind
    if (kind !== null) {
      await kind.delete(locationId)
      return
    }
    await this.store.deleteWhere({
      collection: STORAGE_DRAIN_STATE,
      filter: { where: { location_id: locationId } },
    })
  }
}
