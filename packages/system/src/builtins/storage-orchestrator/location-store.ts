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
import { REDACTED_SECRET } from '@camstack/types'
import { isOwnLocationMarker, locationSecretMarker } from './location-secret-refs.js'
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
 * Credentials a save carries, by config key, until the store writes the row: a value sets the
 * credential, `null` removes it. The service persists without waiting (`upsert` is fire and
 * forget), so the plaintext cannot ride on the location itself; it is staged here, one shot per
 * location id, and `SqliteLocationStore.upsert` hands it to the records door with the row.
 */
export class LocationSecretStaging {
  private readonly staged = new Map<string, Readonly<Record<string, string | null>>>()
  private readonly waiting = new Map<string, () => void>()
  private readonly settledBy = new Map<string, Promise<void>>()

  stage(id: string, secrets: Readonly<Record<string, string | null>>): void {
    if (Object.keys(secrets).length === 0) return
    this.staged.set(id, secrets)
    this.settledBy.set(
      id,
      new Promise<void>((resolve) => {
        this.waiting.set(id, resolve)
      }),
    )
  }

  /** The staged credentials of `id`, once; a save that was refused discards them instead. */
  take(id: string): Readonly<Record<string, string | null>> {
    const secrets = this.staged.get(id) ?? {}
    this.staged.delete(id)
    return secrets
  }

  /** The row of `id` is written (or the write failed): whoever waits for the credential may go on. */
  written(id: string): void {
    this.waiting.get(id)?.()
    this.waiting.delete(id)
    this.settledBy.delete(id)
  }

  discard(id: string): void {
    this.staged.delete(id)
    this.written(id)
  }

  /** Resolves when the staged credentials of `id` are written; at once when none are staged. */
  settled(id: string): Promise<void> {
    return this.settledBy.get(id) ?? Promise.resolve()
  }
}

/**
 * `ILocationStore` on the storage-orchestrator's own record kinds (`locations`
 * and `seed-markers`).
 */
export class SqliteLocationStore implements ILocationStore {
  constructor(
    private readonly locationsKind: RecordKindHandle<StorageLocationBody>,
    private readonly seedMarkersKind: RecordKindHandle<StorageSeedMarkerBody>,
    readonly staging: LocationSecretStaging = new LocationSecretStaging(),
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
    await this.seedMarkersKind.put({
      id: type,
      data: { seededAt: Date.now() },
    })
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
    // Taken before the first await: the save that staged it is the one that persists it.
    const staged = this.staging.take(loc.id)
    try {
      const data = storageOrchestratorRecordKinds.locations.schema.parse(
        locationToBody(loc, staged),
      )
      await this.locationsKind.put({ id: loc.id, data })
    } finally {
      this.staging.written(loc.id)
    }
  }

  async delete(id: string): Promise<void> {
    await this.locationsKind.delete(id)
  }
}

/**
 * The body a location is stored as. A credential the location keeps in its own record (the marker
 * of `location-secret-refs.ts`) leaves `config` for `secrets`, where the records door keeps the
 * value and the redaction token means "keep what is stored"; `staged` sets or removes one. Any
 * other marker (a legacy ref the migration has not moved yet) stays in `config` untouched.
 */
export function locationToBody(
  loc: StorageLocation,
  staged: Readonly<Record<string, string | null>> = {},
): StorageLocationBody {
  const config: Record<string, unknown> = {}
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(loc.config)) {
    if (isOwnLocationMarker(loc.id, key, value)) secrets[key] = REDACTED_SECRET
    else config[key] = value
  }
  for (const [key, value] of Object.entries(staged)) {
    if (value === null) delete secrets[key]
    else secrets[key] = value
  }
  return {
    type: loc.type,
    displayName: loc.displayName,
    providerId: loc.providerId,
    config,
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
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
    config: {
      ...body.config,
      ...Object.fromEntries(
        Object.keys(body.secrets ?? {}).map((key) => [key, locationSecretMarker(id, key)]),
      ),
    },
    ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...LegacyStorageLocationDefaultSchema.parse({
      isDefault: body.isDefault ?? false,
    }),
    isSystem: body.isSystem,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  }
}
