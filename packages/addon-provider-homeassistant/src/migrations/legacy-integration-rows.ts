/**
 * The OLD home of a Home Assistant instance's values: the leftover rows of its integration,
 * read through the migration-only door (`migrations.readLegacyIntegrationRows` and the two
 * writes beside it). Since planning#416 the instance's own record holds them and nothing at
 * runtime reads these rows; this module is for the migrations alone.
 *
 * A patch upserts only the keys it names. It does not rewrite the other rows, so a secret
 * marker stays a marker. A missing store answers as "nothing written" and the copy is a no-op.
 */
import { collectSecretMarkerRefs, type SecretsAccess } from '@camstack/types'

/** The addon id the integrations of a Home Assistant instance carry. */
export const HA_PROVIDER_ADDON_ID = 'provider-homeassistant'

export interface HaInstanceRow {
  readonly integrationId: string
  /** The broker the integration links to; `null` when it names none. */
  readonly brokerId: string | null
  readonly settings: Readonly<Record<string, unknown>>
}

/** The migration-only door plus the registry list, as a tRPC client exposes them. */
export interface HaLegacyRowsApi {
  readonly list: {
    query(): Promise<readonly { readonly id: string; readonly addonId: string }[]>
  }
  readonly readLegacyIntegrationRows: {
    query(input: { integrationId: string }): Promise<Readonly<Record<string, unknown>>>
  }
  readonly patchLegacyIntegrationRows: {
    mutate(input: {
      integrationId: string
      patch: Record<string, unknown>
    }): Promise<{ readonly written: boolean }>
  }
  readonly deleteLegacyIntegrationRowKeys: {
    mutate(input: { integrationId: string; keys: readonly string[] }): Promise<{
      readonly present: boolean
      readonly removed: Readonly<Record<string, unknown>>
    }>
  }
}

/** The legacy rows: read them, merge into them, and clear keys out of them. */
export interface HaInstanceSettingsPorts {
  /** Every Home Assistant integration with its stored settings. Throws when it cannot be read. */
  listInstances(): Promise<readonly HaInstanceRow[]>
  /**
   * Merge `patch` into one integration's settings. `false` when the integration is gone or the
   * store is already dropped (a deleted instance is skipped, never recreated).
   */
  patchInstanceSettings(
    integrationId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<boolean>
}

/** Beside the legacy reads: delete keys from one integration's rows. */
export interface HaInstanceClearPorts extends HaInstanceSettingsPorts {
  /**
   * Remove `keys` from one integration's settings, leaving every other key. `false` when the
   * integration is gone or the store is already dropped.
   */
  clearInstanceSettingsKeys(integrationId: string, keys: readonly string[]): Promise<boolean>
}

function refsOfKeys(
  stored: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): readonly string[] {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) picked[key] = stored[key]
  }
  return collectSecretMarkerRefs(picked)
}

export function haInstanceSettingsPortsOver(
  api: HaLegacyRowsApi,
  secrets: SecretsAccess | null = null,
): HaInstanceClearPorts {
  const listInstances = async (): Promise<readonly HaInstanceRow[]> => {
    const all = await api.list.query()
    const rows: HaInstanceRow[] = []
    for (const integration of all) {
      if (integration.addonId !== HA_PROVIDER_ADDON_ID) continue
      const settings = await api.readLegacyIntegrationRows.query({
        integrationId: integration.id,
      })
      const brokerId = settings['brokerId']
      rows.push({
        integrationId: integration.id,
        brokerId: typeof brokerId === 'string' && brokerId.length > 0 ? brokerId : null,
        settings,
      })
    }
    return rows
  }
  const owns = async (integrationId: string): Promise<boolean> => {
    const all = await api.list.query()
    return all.some((i) => i.id === integrationId && i.addonId === HA_PROVIDER_ADDON_ID)
  }
  return {
    listInstances,
    patchInstanceSettings: async (integrationId, patch) => {
      if (!(await owns(integrationId))) return false
      const result = await api.patchLegacyIntegrationRows.mutate({
        integrationId,
        patch: { ...patch },
      })
      return result.written
    },
    clearInstanceSettingsKeys: async (integrationId, keys) => {
      if (!(await owns(integrationId))) return false
      const stored = await api.readLegacyIntegrationRows.query({ integrationId })
      const refs = refsOfKeys(stored, keys)
      if (refs.length > 0 && secrets !== null) await secrets.delete(refs)
      const result = await api.deleteLegacyIntegrationRowKeys.mutate({ integrationId, keys })
      return result.present
    },
  }
}
