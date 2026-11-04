/**
 * The OLD home of a Home Assistant instance's values: the `integration_settings` rows of its
 * integration (D985), read and written through the hub's `integrations` capability. Since
 * planning#416 the instance's own record holds them (`../ha-instance-settings.ts`) and nothing at
 * runtime reads these rows; this module is for the migrations alone, which still resolve the
 * broker an integration links (`brokerId`) and move what sits beside it onto the record.
 *
 * A write MERGES into what is stored (the registry replaces the whole record) and passes
 * `skipRestart`, which the hub honours only for the integration's own addon.
 */
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

/** The legacy rows: read them, merge into them, and clear keys out of them. */
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

/** Beside the legacy reads: delete keys from one integration's rows. */
export interface HaInstanceClearPorts extends HaInstanceSettingsPorts {
  /**
   * Remove `keys` from one integration's settings, leaving every other key. `false` when the
   * integration is gone; throws when the write fails.
   */
  clearInstanceSettingsKeys(integrationId: string, keys: readonly string[]): Promise<boolean>
}

export function haInstanceSettingsPortsOver(api: HaIntegrationsApi): HaInstanceClearPorts {
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
    clearInstanceSettingsKeys: async (integrationId, keys) => {
      const all = await api.list.query()
      if (!all.some((i) => i.id === integrationId && i.addonId === HA_PROVIDER_ADDON_ID)) {
        return false
      }
      const stored = await api.getSettings.query({ id: integrationId })
      const drop = new Set(keys)
      await api.setSettings.mutate({
        id: integrationId,
        settings: Object.fromEntries(Object.entries(stored).filter(([key]) => !drop.has(key))),
        skipRestart: true,
      })
      return true
    },
  }
}
