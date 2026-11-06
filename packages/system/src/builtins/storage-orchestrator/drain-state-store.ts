/**
 * Durable home for the drain ratchet (D386).
 *
 * The cap MUST survive a restart. Recomputing it from today's usage would
 * restart the ratchet at the top of the disk and silently undo every byte of
 * progress — the operator would see a drain that never finishes and no line
 * saying why. So the cap, the drain start and the observed growth are persisted
 * on every sweep, as `drain-state` records.
 */
import type { RecordKindHandle, RecordsAccess } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import type { DrainState } from './drain-ratchet.js'
import { storageOrchestratorRecordKinds, type StorageDrainStateBody } from './record-kinds.js'
import type { DrainStateStore } from './storage-pressure-manager.js'

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

/** {@link DrainStateStore} over the `drain-state` record kind. */
export class SqliteDrainStateStore implements DrainStateStore {
  constructor(private readonly drainKind: RecordKindHandle<StorageDrainStateBody>) {}

  static recordStoresOf(
    records: Pick<RecordsAccess, 'kind'>,
  ): RecordKindHandle<StorageDrainStateBody> {
    return records.kind(storageOrchestratorRecordKinds['drain-state'])
  }

  async load(): Promise<readonly DrainState[]> {
    const out: DrainState[] = []
    for (const row of await readAllRows(this.drainKind)) {
      const mapped = bodyToDrainState(row.data)
      if (mapped) out.push(mapped)
    }
    return out
  }

  async save(state: DrainState): Promise<void> {
    const data = storageOrchestratorRecordKinds['drain-state'].schema.parse(drainStateToBody(state))
    await this.drainKind.put({ id: state.locationId, data })
  }

  async clear(locationId: string): Promise<void> {
    await this.drainKind.delete(locationId)
  }
}
