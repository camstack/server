/**
 * The settings of one Home Assistant instance live on its integration (`integration_settings`,
 * D985): the integration record already carries `{ brokerId }`, and the values that belong to the
 * instance — the calendars it imports, whether the export reaches it, the address role its image
 * links use — sit beside that link. This is the one place that reads and writes them, through the
 * hub's `integrations` capability, for the provider and the export alike.
 *
 * A write MERGES into what is stored (the registry replaces the whole record) and passes
 * `skipRestart`, which the hub honours only for the integration's own addon.
 */
import { errMsg } from '@camstack/types'

/** The addon id the integrations of a Home Assistant instance carry. */
export const HA_PROVIDER_ADDON_ID = 'provider-homeassistant'

export interface HaInstanceRow {
  readonly integrationId: string
  /** The broker the integration links to; `null` when it names none. */
  readonly brokerId: string | null
  readonly settings: Readonly<Record<string, unknown>>
}

/** The slice of `ctx.api.integrations` this module calls. */
export interface HaIntegrationsApi {
  readonly list: {
    query(): Promise<readonly { readonly id: string; readonly addonId: string }[]>
  }
  readonly getSettings: {
    query(input: { id: string }): Promise<Readonly<Record<string, unknown>>>
  }
  readonly setSettings: {
    mutate(input: {
      id: string
      settings: Record<string, unknown>
      skipRestart?: boolean
    }): Promise<{ readonly success: boolean }>
  }
}

export interface HaInstanceSettingsPorts {
  /** Every Home Assistant integration with its stored settings. Throws when it cannot be read. */
  listInstances(): Promise<readonly HaInstanceRow[]>
  /**
   * Merge `patch` into one integration's settings. `false` when the integration is gone (a
   * deleted instance is skipped, never recreated); throws when the write fails.
   */
  patchInstanceSettings(
    integrationId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<boolean>
}

export function haInstanceSettingsPortsOver(api: HaIntegrationsApi): HaInstanceSettingsPorts {
  const listInstances = async (): Promise<readonly HaInstanceRow[]> => {
    const all = await api.list.query()
    const rows: HaInstanceRow[] = []
    for (const integration of all) {
      if (integration.addonId !== HA_PROVIDER_ADDON_ID) continue
      const settings = await api.getSettings.query({ id: integration.id })
      const brokerId = settings['brokerId']
      rows.push({
        integrationId: integration.id,
        brokerId: typeof brokerId === 'string' && brokerId.length > 0 ? brokerId : null,
        settings,
      })
    }
    return rows
  }
  return {
    listInstances,
    patchInstanceSettings: async (integrationId, patch) => {
      const all = await api.list.query()
      if (!all.some((i) => i.id === integrationId && i.addonId === HA_PROVIDER_ADDON_ID)) {
        return false
      }
      const stored = await api.getSettings.query({ id: integrationId })
      await api.setSettings.mutate({
        id: integrationId,
        settings: { ...stored, ...patch },
        skipRestart: true,
      })
      return true
    },
  }
}

/** The brokerId → settings view of the instances: what a reader keeps per broker. */
export function settingsByBroker(
  rows: readonly HaInstanceRow[],
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const out = new Map<string, Readonly<Record<string, unknown>>>()
  for (const row of rows) if (row.brokerId !== null) out.set(row.brokerId, row.settings)
  return out
}

/** Read the instances, or report why not and answer nothing (a reader falls back to the legacy key). */
export async function listInstancesOrNothing(
  ports: HaInstanceSettingsPorts,
  onError: (message: string) => void,
): Promise<readonly HaInstanceRow[]> {
  try {
    return await ports.listInstances()
  } catch (err) {
    onError(errMsg(err))
    return []
  }
}
