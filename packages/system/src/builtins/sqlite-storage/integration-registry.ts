import type {
  CollectionColumn,
  CollectionIndex,
  CreateIntegrationInput,
  IIntegrationRegistry,
  Integration,
  ISettingsStoreProvider,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { bareAddonId, parseJsonObject } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import {
  INTEGRATIONS_LEGACY,
  integrationRegistryRecordKinds,
  type IntegrationBody,
} from './integration-record-kinds.js'

export interface IntegrationRecordStores {
  readonly integrations: RecordKindHandle<IntegrationBody>
}

/**
 * Read an `info` blob off a row.
 *
 * The column is declared `JSON`, so the surface hands back a parsed object —
 * but rows written before B2 by an older build are still raw strings on disk
 * for as long as they go un-rewritten, and a string that fails to parse must
 * not take the whole record down.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readInfo(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') return parseJsonObject(raw) ?? {}
  if (isPlainObject(raw)) return { ...raw }
  return {}
}

let integrationCounter = 0

function nextIntegrationId(): string {
  return `int_${String(++integrationCounter).padStart(4, '0')}`
}

// ── Collections ───────────────────────────────────────────────────────
//
// The names stay the BARE table names: these tables are not namespaced on
// disk, and prefixing them would move the operator's data rather than read it.
//
// `info` is declared `JSON`, not `TEXT`. The surface owns the serialisation
// for that type — callers hand it an object and get an object back — where the
// `table*` version stringified by hand on the way in and re-parsed on the way
// out. Keeping the hand-rolled string with a `TEXT` column would silently lose
// the blob: `query` JSON-parses any TEXT column starting with `{`, so the
// mapper's `typeof row.info === 'string'` test would fail and yield `{}`.

const INTEGRATIONS_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT', primaryKey: true },
  { name: 'addon_id', type: 'TEXT', notNull: true },
  { name: 'name', type: 'TEXT', notNull: true },
  { name: 'enabled', type: 'INTEGER', notNull: true, defaultValue: 1 },
  { name: 'info', type: 'JSON', notNull: true, defaultValue: '{}' },
  { name: 'origin_stable_id', type: 'TEXT' },
  { name: 'created_at', type: 'INTEGER', notNull: true },
  { name: 'updated_at', type: 'INTEGER', notNull: true },
]

const INTEGRATIONS_INDEXES: readonly CollectionIndex[] = [
  { name: 'idx_integrations_addon', columns: ['addon_id'] },
]

/**
 * @durable class=config owner=integration-registry
 *   write="`createIntegration` — an operator adds a provider, or an addon declares
 *     a FIXED one (`info.fixed`); `updateIntegration` rewrites name/enabled/info"
 *   retention="`deleteIntegration` only, and a fixed integration refuses to be
 *     deleted. Nothing ages out. The `int_NNNN` counter resumes from the highest
 *     surviving row at boot, so wiping the table restarts numbering."
 */
const INTEGRATIONS = INTEGRATIONS_LEGACY

/**
 * The persisted INTEGRATIONS — one row per provider instance an operator (or a
 * declaring addon) added. The instance's configuration lives on the addon's own
 * record, not here.
 *
 * It had a device half once: `devices` + `device_settings_kv`, `dev_NNNN` ids,
 * `createDevice` / `listCameras` / `setDeviceSetting`. It was removed on
 * 2026-08-19 with both tables ([D183](../../../../../docs/decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)):
 * measured on the reference hub it held 0 rows against 974 live devices, no
 * production caller ever reached it, and its id-space could not be reconciled
 * with the numeric ids every track, rule and binding in the system uses. The
 * fleet is `device-manager:devices`. Do not add a device method here — the
 * device authority is the device-manager, and a second one that agrees with
 * nothing is how this half came to exist.
 */
function mapIntegrationBody(id: string, body: IntegrationBody): Integration {
  return {
    id,
    addonId: body.addonId,
    name: body.name,
    enabled: body.enabled,
    info: readInfo(body.info),
    ...(body.originStableId !== undefined ? { originStableId: body.originStableId } : {}),
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  }
}

export class IntegrationRegistry implements IIntegrationRegistry {
  private readonly store: ISettingsStoreProvider
  private readonly recordStores: IntegrationRecordStores | undefined

  constructor(backend: ISettingsStoreProvider, recordStores?: IntegrationRecordStores) {
    this.store = backend
    this.recordStores = recordStores
  }

  static recordStoresOf(records: Pick<RecordsAccess, 'kind'>): IntegrationRecordStores {
    return {
      integrations: records.kind(integrationRegistryRecordKinds.integrations),
    }
  }

  async initialize(): Promise<void> {
    if (this.recordStores === undefined) {
      await this.store.declareCollection({
        collection: INTEGRATIONS,
        columns: INTEGRATIONS_COLUMNS,
        indexes: INTEGRATIONS_INDEXES,
      })
    }
    await this.resumeCounter()
  }

  private async resumeCounter(): Promise<void> {
    const kind = this.recordStores?.integrations
    if (kind !== undefined) {
      const rows = await readAllRows(kind, { order: 'id' })
      rows.sort((a, b) => b.id.localeCompare(a.id))
      const top = rows[0]
      if (top !== undefined) {
        const num = parseInt(top.id.replace('int_', ''), 10)
        if (!isNaN(num)) integrationCounter = num
      }
      return
    }
    const ints = await this.store.query({
      collection: INTEGRATIONS,
      filter: { orderBy: { field: 'id', direction: 'desc' }, limit: 1 },
    })
    if (ints[0]) {
      const num = parseInt(ints[0].id.replace('int_', ''), 10)
      if (!isNaN(num)) integrationCounter = num
    }
  }

  // --- Integrations ---

  async createIntegration(rawInput: CreateIntegrationInput): Promise<Integration> {
    // ONE canonical spelling on disk: the bare manifest id (a hub-main `ctx.id` is `addon:<id>`).
    const input: CreateIntegrationInput = { ...rawInput, addonId: bareAddonId(rawInput.addonId) }
    const id = nextIntegrationId()
    const now = Math.floor(Date.now() / 1000)
    const enabled = input.enabled !== false
    const info = input.info ?? {}
    const body: IntegrationBody = {
      addonId: input.addonId,
      name: input.name,
      enabled,
      info,
      ...(input.originStableId !== undefined ? { originStableId: input.originStableId } : {}),
      createdAt: now,
      updatedAt: now,
    }
    const kind = this.recordStores?.integrations
    if (kind !== undefined) {
      await kind.put({ id, data: body })
    } else {
      await this.store.insert({
        collection: INTEGRATIONS,
        record: {
          id,
          data: {
            addon_id: input.addonId,
            name: input.name,
            enabled: enabled ? 1 : 0,
            info,
            origin_stable_id: input.originStableId ?? null,
            created_at: now,
            updated_at: now,
          },
        },
      })
    }

    return {
      id,
      addonId: input.addonId,
      name: input.name,
      enabled,
      info,
      ...(input.originStableId !== undefined ? { originStableId: input.originStableId } : {}),
      createdAt: now,
      updatedAt: now,
    }
  }

  async getIntegration(id: string): Promise<Integration | null> {
    const kind = this.recordStores?.integrations
    if (kind !== undefined) {
      const row = await kind.get(id)
      return row === null ? null : mapIntegrationBody(row.id, row.data)
    }
    const rows = await this.store.query({
      collection: INTEGRATIONS,
      filter: { where: { id }, limit: 1 },
    })
    return rows[0] ? this.mapIntegration(rows[0].data) : null
  }

  async getIntegrationByAddonId(rawAddonId: string): Promise<Integration | null> {
    const addonId = bareAddonId(rawAddonId)
    const kind = this.recordStores?.integrations
    if (kind !== undefined) {
      const page = await kind.query({ where: { addonId }, limit: 1 })
      const row = page.records[0]
      return row === undefined ? null : mapIntegrationBody(row.id, row.data)
    }
    const rows = await this.store.query({
      collection: INTEGRATIONS,
      filter: { where: { addon_id: addonId }, limit: 1 },
    })
    return rows[0] ? this.mapIntegration(rows[0].data) : null
  }

  async listIntegrations(): Promise<readonly Integration[]> {
    const kind = this.recordStores?.integrations
    if (kind !== undefined) {
      const rows = await readAllRows(kind)
      rows.sort((a, b) => a.data.createdAt - b.data.createdAt)
      return rows.map((r) => mapIntegrationBody(r.id, r.data))
    }
    const rows = await this.store.query({
      collection: INTEGRATIONS,
      filter: { orderBy: { field: 'created_at', direction: 'asc' } },
    })
    return rows.map((r) => this.mapIntegration(r.data))
  }

  async updateIntegration(
    id: string,
    updates: Partial<Pick<Integration, 'name' | 'enabled' | 'info'>>,
  ): Promise<Integration | null> {
    const now = Math.floor(Date.now() / 1000)
    const kind = this.recordStores?.integrations
    if (kind !== undefined) {
      const existing = await kind.get(id)
      if (existing === null) return null
      const next: IntegrationBody = {
        ...existing.data,
        updatedAt: now,
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
        ...(updates.info !== undefined ? { info: updates.info } : {}),
      }
      await kind.put({ id, data: next })
      return mapIntegrationBody(id, next)
    }
    const updateRow: Record<string, unknown> = { updated_at: now }
    if (updates.name !== undefined) updateRow['name'] = updates.name
    if (updates.enabled !== undefined) updateRow['enabled'] = updates.enabled ? 1 : 0
    if (updates.info !== undefined) updateRow['info'] = updates.info

    await this.store.updateWhere({
      collection: INTEGRATIONS,
      filter: { where: { id } },
      data: updateRow,
    })
    return this.getIntegration(id)
  }

  /**
   * A FIXED integration exists because an addon declares it, not because an
   * operator added it — the Notification Center's alarm panel is the first.
   * There is no add or delete flow for one, and this is where that is true
   * rather than merely hidden: a UI that only omits the button still leaves the
   * mutation one API call away.
   */
  static isFixed(integration: {
    readonly info: Readonly<Record<string, unknown>> | null
  }): boolean {
    // `info` is nullable on the row and on the `Integration` type — every
    // integration an operator created has none. Indexing it unguarded turned
    // this guard into a TypeError on exactly the integrations it was supposed
    // to wave through.
    return integration.info?.['fixed'] === true
  }

  async deleteIntegration(id: string): Promise<boolean> {
    const integration = await this.getIntegration(id)
    if (integration !== null && IntegrationRegistry.isFixed(integration)) {
      throw new Error(
        `integration "${id}" is fixed — it belongs to the addon that declared it and cannot be deleted`,
      )
    }
    const integrationsKind = this.recordStores?.integrations
    if (integrationsKind !== undefined) {
      await integrationsKind.delete(id)
      return true
    }
    await this.store.deleteWhere({ collection: INTEGRATIONS, filter: { where: { id } } })
    return true
  }

  // --- Mappers ---

  private mapIntegration(row: Record<string, unknown>): Integration {
    return {
      id: String(row['id']),
      addonId: String(row['addon_id']),
      name: String(row['name']),
      enabled: row['enabled'] === 1,
      info: readInfo(row['info']),
      ...(typeof row['origin_stable_id'] === 'string'
        ? { originStableId: row['origin_stable_id'] }
        : {}),
      createdAt: Number(row['created_at']),
      updatedAt: Number(row['updated_at']),
    }
  }
}
