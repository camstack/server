import type {
  CreateIntegrationInput,
  IIntegrationRegistry,
  Integration,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { bareAddonId, parseJsonObject } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { integrationRegistryRecordKinds, type IntegrationBody } from './integration-record-kinds.js'

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
  private readonly recordStores: IntegrationRecordStores

  constructor(recordStores: IntegrationRecordStores) {
    this.recordStores = recordStores
  }

  static recordStoresOf(records: Pick<RecordsAccess, 'kind'>): IntegrationRecordStores {
    return {
      integrations: records.kind(integrationRegistryRecordKinds.integrations),
    }
  }

  async initialize(): Promise<void> {
    await this.resumeCounter()
  }

  private async resumeCounter(): Promise<void> {
    const rows = await readAllRows(this.recordStores.integrations, { order: 'id' })
    rows.sort((a, b) => b.id.localeCompare(a.id))
    const top = rows[0]
    if (top !== undefined) {
      const num = parseInt(top.id.replace('int_', ''), 10)
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
    await this.recordStores.integrations.put({ id, data: body })
    return mapIntegrationBody(id, body)
  }

  async getIntegration(id: string): Promise<Integration | null> {
    const row = await this.recordStores.integrations.get(id)
    return row === null ? null : mapIntegrationBody(row.id, row.data)
  }

  async getIntegrationByAddonId(rawAddonId: string): Promise<Integration | null> {
    const addonId = bareAddonId(rawAddonId)
    const page = await this.recordStores.integrations.query({ where: { addonId }, limit: 1 })
    const row = page.records[0]
    return row === undefined ? null : mapIntegrationBody(row.id, row.data)
  }

  async listIntegrations(): Promise<readonly Integration[]> {
    const rows = await readAllRows(this.recordStores.integrations)
    rows.sort((a, b) => a.data.createdAt - b.data.createdAt)
    return rows.map((r) => mapIntegrationBody(r.id, r.data))
  }

  async updateIntegration(
    id: string,
    updates: Partial<Pick<Integration, 'name' | 'enabled' | 'info'>>,
  ): Promise<Integration | null> {
    const now = Math.floor(Date.now() / 1000)
    const existing = await this.recordStores.integrations.get(id)
    if (existing === null) return null
    const next: IntegrationBody = {
      ...existing.data,
      updatedAt: now,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
      ...(updates.info !== undefined ? { info: updates.info } : {}),
    }
    await this.recordStores.integrations.put({ id, data: next })
    return mapIntegrationBody(id, next)
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
    await this.recordStores.integrations.delete(id)
    return true
  }
}
