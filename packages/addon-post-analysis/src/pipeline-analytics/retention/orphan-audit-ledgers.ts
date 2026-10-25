/**
 * The orphan audit's records-backed scopes: which auditable collections are
 * walked through their records kind, and the ports that do it.
 *
 * Three of the audited collections — faces, plates, track aliases — were
 * adopted by records kinds, and their legacy tables are DROPPED on a migrated
 * hub. The audit used to page, count and (for plates) delete them through the
 * settings store BY NAME, so on such a hub every one of those scopes failed on
 * every pass. Here each name maps to its kind's ledger, the same handle its
 * store uses: pages are KEYSET pages (`pageById`, the engine's opaque cursor),
 * the size is the kind's count, and a plate is deleted through its ledger.
 */
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import {
  type EventLedgerWiringDeps,
  wireFaceLedger,
  wirePlateLedger,
  wireTrackAliasLedger,
} from '../store/event-ledger-wiring.js'
import { FACES_COLLECTION } from '../store/face-store.js'
import { PLATES_COLLECTION } from '../store/plate-store.js'
import { TRACK_ALIASES_COLLECTION } from '../store/track-alias-store.js'
import type { OrphanAuditDeps, OrphanKeysetPage, OrphanRow } from './orphan-audit.js'
import type { OrphanRawDeleteAssert } from './orphan-reclaimers.js'

/** Audited collection → its records-kind ledger. */
export function orphanAuditLedgers(
  wiring: EventLedgerWiringDeps,
): ReadonlyMap<string, EventLedgerCollection> {
  return new Map([
    [FACES_COLLECTION, wireFaceLedger(wiring)],
    [PLATES_COLLECTION, wirePlateLedger(wiring)],
    [TRACK_ALIASES_COLLECTION, wireTrackAliasLedger(wiring)],
  ])
}

/** {@link OrphanAuditDeps.pageKeyset} over those ledgers; `null` for any other collection. */
export function keysetPager(
  ledgers: ReadonlyMap<string, EventLedgerCollection>,
): NonNullable<OrphanAuditDeps['pageKeyset']> {
  return async (collection, cursor, limit): Promise<OrphanKeysetPage | null> => {
    const ledger = ledgers.get(collection)
    if (ledger === undefined) return null
    const page = await ledger.pageById(cursor, limit)
    return {
      rows: page.rows.map((row) => ({ key: row.id, data: row.data })),
      nextCursor: page.nextCursor,
    }
  }
}

/** The kind's count for a ledger-backed collection, `undefined` for any other. */
async function ledgerSize(
  ledgers: ReadonlyMap<string, EventLedgerCollection>,
  collection: string,
): Promise<number | undefined> {
  const ledger = ledgers.get(collection)
  return ledger === undefined ? undefined : ledger.count()
}

/**
 * The plate reclaim through the plate ledger. With `assert`, a row whose `trackId` is not
 * the dead track's is KEPT (logged), never deleted.
 */
export function plateDeleter(
  plates: Pick<EventLedgerCollection, 'get' | 'deleteKey'>,
  logger: IScopedLogger,
): (plateId: string, assert?: OrphanRawDeleteAssert) => Promise<boolean> {
  return async (plateId, assert) => {
    const row = await plates.get(plateId)
    if (row === null) return false
    if (assert !== undefined && row.data['trackId'] !== assert.trackId) {
      const deviceId = row.data['deviceId']
      logger.warn('orphan audit: plate row now names another track — kept', {
        ...(typeof deviceId === 'number' ? { tags: { deviceId } } : {}),
        meta: { plateId, expectedTrackId: assert.trackId },
      })
      return false
    }
    await plates.deleteKey(plateId)
    return true
  }
}

/**
 * The audit's ports for every NON-media collection, as production wires them:
 * a records-backed collection is paged by keyset and counted through its
 * kind; any other (object-events) is paged by offset and counted through the
 * settings store.
 */
export interface AuditCollectionPorts {
  readonly pageKeyset: NonNullable<OrphanAuditDeps['pageKeyset']>
  readonly pageByOffset: (
    collection: string,
    offset: number,
    limit: number,
  ) => Promise<readonly OrphanRow[]>
  readonly size: (collection: string) => Promise<number | null>
}

export function auditCollectionPorts(
  store: Pick<SettingsStoreClient, 'query' | 'count'>,
  ledgers: ReadonlyMap<string, EventLedgerCollection>,
): AuditCollectionPorts {
  return {
    pageKeyset: keysetPager(ledgers),
    pageByOffset: async (collection, offset, limit) => {
      const rows = await store.query.query({
        collection,
        filter: { orderBy: { field: 'id', direction: 'asc' }, limit, offset },
      })
      return rows.map((row) => ({ key: row.id, data: row.data }))
    },
    size: async (collection) => {
      const counted = await ledgerSize(ledgers, collection)
      if (counted !== undefined) return counted
      return store.count.query({ collection })
    },
  }
}
