/**
 * Persistence layer for the storage-orchestrator's `StorageLocation`
 * map (Task 6 of the storage-unification refactor).
 *
 * The service depends only on the abstract `ILocationStore` —
 * production wires `SqliteLocationStore` (settings-backend-backed),
 * tests pass a fake (in-memory `Map`-backed) implementation. Same
 * pattern as `IntegrationRegistry` in `sqlite-storage/`.
 */
import type {
  LegacyStorageLocationDefault,
  RecordKindHandle,
  RecordsAccess,
  StorageLocation,
} from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import {
  storageOrchestratorRecordKinds,
  type StorageLocationBody,
  type StorageSeedMarkerBody,
} from './record-kinds.js'
import { LegacyStorageLocationDefaultSchema, StorageLocationTypeSchema } from '@camstack/types'

/**
 * A location as it comes back OFF DISK: the live record plus the retired
 * `isDefault` column, which exists only so the orchestrator's boot migration
 * can turn an old default into the enabled write set and say which row it came
 * from. No other reader may take this type.
 */
export type PersistedStorageLocation = StorageLocation & LegacyStorageLocationDefault

/**
 * Abstract storage interface for `StorageLocation` records. Methods are
 * async because production-side implementations hit SQLite — but the
 * orchestrator's mutation paths fire-and-forget the writes so a slow
 * disk doesn't block the cap surface.
 */
export interface ILocationStore {
  /** Read every persisted location. Called once at boot. Rows carry the
   *  RETIRED `isDefault` column when it was set, for the one reader allowed to
   *  see it: the orchestrator's boot migration onto the `enabled` write set. */
  loadAll(): Promise<readonly PersistedStorageLocation[]>
  /** Insert or replace a single location by id. */
  upsert(loc: StorageLocation): Promise<void>
  /** Remove a location by id. */
  delete(id: string): Promise<void>
  /**
   * The location types a default was ever seeded for (or that already existed
   * when this memory began). Absent on a store that cannot remember — such a
   * store seeds on "type has no row", as before.
   */
  loadSeededTypes?(): Promise<readonly string[]>
  markTypeSeeded?(type: string): Promise<void>
  /**
   * Forget that a type was seeded. Called ONLY when the declaration pass prunes
   * the type's default because no installed package declares it any more — so a
   * later re-declaration seeds it again, and an operator's own delete (which
   * never calls this) keeps sticking.
   */
  unmarkTypeSeeded?(type: string): Promise<void>
}

/**
 * The keychain scope collection a storage location's secret fields are filed
 * under (`row/storage_locations/<id>`). The table it was named for is gone; the
 * string stays because existing secret markers point at it.
 */
export const STORAGE_LOCATIONS_SECRET_SCOPE = 'storage_locations'

/**
 * `ILocationStore` on the storage-orchestrator's own record kinds (`locations`
 * and `seed-markers`).
 */
export class SqliteLocationStore implements ILocationStore {
  constructor(
    private readonly locationsKind: RecordKindHandle<StorageLocationBody>,
    private readonly seedMarkersKind: RecordKindHandle<StorageSeedMarkerBody>,
  ) {}

  static seedMarkersOf(
    records: Pick<RecordsAccess, 'kind'>,
  ): RecordKindHandle<StorageSeedMarkerBody> {
    return records.kind(storageOrchestratorRecordKinds['seed-markers'])
  }

  async loadSeededTypes(): Promise<readonly string[]> {
    return (await readAllRows(this.seedMarkersKind)).map((r) => r.id)
  }

  async markTypeSeeded(type: string): Promise<void> {
    await this.seedMarkersKind.put({ id: type, data: { seededAt: Date.now() } })
  }

  async unmarkTypeSeeded(type: string): Promise<void> {
    await this.seedMarkersKind.delete(type)
  }

  static recordStoresOf(
    records: Pick<RecordsAccess, 'kind'>,
  ): RecordKindHandle<StorageLocationBody> {
    return records.kind(storageOrchestratorRecordKinds.locations)
  }

  async loadAll(): Promise<readonly PersistedStorageLocation[]> {
    const rows = await readAllRows(this.locationsKind)
    rows.sort((a, b) => a.data.createdAt - b.data.createdAt)
    const out: PersistedStorageLocation[] = []
    for (const row of rows) {
      const mapped = bodyToPersistedLocation(row.id, row.data)
      if (mapped) out.push(mapped)
    }
    return out
  }

  async upsert(loc: StorageLocation): Promise<void> {
    const data = storageOrchestratorRecordKinds.locations.schema.parse(locationToBody(loc))
    await this.locationsKind.put({ id: loc.id, data })
  }

  async delete(id: string): Promise<void> {
    await this.locationsKind.delete(id)
  }
}

export function locationToBody(loc: StorageLocation): StorageLocationBody {
  return {
    type: loc.type,
    displayName: loc.displayName,
    providerId: loc.providerId,
    config: { ...loc.config },
    isSystem: loc.isSystem,
    createdAt: loc.createdAt,
    updatedAt: loc.updatedAt,
    ...(loc.nodeId !== undefined ? { nodeId: loc.nodeId } : {}),
    ...(loc.enabled !== undefined ? { enabled: loc.enabled } : {}),
    ...(loc.mode !== undefined ? { mode: loc.mode } : {}),
  }
}

export function bodyToPersistedLocation(
  id: string,
  body: StorageLocationBody,
): PersistedStorageLocation | null {
  const parsedType = StorageLocationTypeSchema.safeParse(body.type)
  if (!parsedType.success || id.length === 0) return null
  return {
    id,
    type: parsedType.data,
    displayName: body.displayName,
    providerId: body.providerId,
    config: { ...body.config },
    ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...LegacyStorageLocationDefaultSchema.parse({ isDefault: body.isDefault ?? false }),
    isSystem: body.isSystem,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  }
}
