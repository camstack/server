/**
 * Who offers a device, as the picker draws it: "{addon name} ({integration
 * name})" — the integration part only when the device comes from a named
 * integration instance — otherwise just "{addon name}".
 *
 * Derived from what the UI already reads: the device's providing `addonId` and
 * its `integrationId` (fleet listing), the addon's manifest name
 * (`addons.list`) and the instance's name (`integrations.list`). Nothing here
 * knows a kind or an addon; a row whose provider cannot be resolved shows no
 * line at all rather than a guess.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useSystem } from '../../contexts/system-context.js'

/** "Home Assistant (Casa)", or "Home Assistant" without an instance name. */
export function formatProviderLabel(
  addonName: string,
  integrationName: string | null | undefined,
): string {
  const instance = integrationName?.trim() ?? ''
  return instance === '' || instance === addonName ? addonName : `${addonName} (${instance})`
}

export interface ProviderFleetRow {
  readonly id: number
  readonly addonId: string
  readonly integrationId?: string | undefined
}

export interface ProviderAddonRow {
  readonly id: string
  readonly name: string | undefined
}

export interface ProviderIntegrationRow {
  readonly id: string
  readonly name: string
}

/** `deviceId → provider label`; a device whose addon is unknown is absent. */
export function providerLabelsOf(
  fleet: readonly ProviderFleetRow[],
  addons: readonly ProviderAddonRow[],
  integrations: readonly ProviderIntegrationRow[],
): ReadonlyMap<number, string> {
  const addonName = new Map<string, string>()
  for (const a of addons) {
    if (a.name !== undefined && a.name !== '') addonName.set(a.id, a.name)
  }
  const instanceName = new Map(integrations.map((i) => [i.id, i.name]))
  const out = new Map<number, string>()
  for (const d of fleet) {
    const addon = addonName.get(d.addonId)
    if (addon === undefined) continue
    const instance =
      d.integrationId === undefined ? null : (instanceName.get(d.integrationId) ?? null)
    out.set(d.id, formatProviderLabel(addon, instance))
  }
  return out
}

const NONE: ReadonlyMap<number, string> = new Map()

const PROVIDER_LABELS_STALE_MS = 60_000

/**
 * The labels for every device in the fleet; empty until the reads answer (a
 * failed read draws no provider line — it is a hint, never a gate).
 */
export function useDeviceProviderLabels(enabled: boolean): ReadonlyMap<number, string> {
  const trpcClient = useSystem().trpcClient
  const query = useQuery({
    queryKey: ['ui-library', 'device-provider-labels'],
    enabled,
    staleTime: PROVIDER_LABELS_STALE_MS,
    queryFn: async (): Promise<ReadonlyMap<number, string>> => {
      const [fleet, addons, integrations] = await Promise.all([
        trpcClient.deviceManager.listAll.query({ projection: 'slim' }),
        trpcClient.addons.list.query(),
        trpcClient.integrations.list.query(),
      ])
      return providerLabelsOf(
        fleet,
        addons.map((a) => ({ id: a.manifest.id, name: a.manifest.name })),
        integrations,
      )
    },
  })
  return useMemo(() => query.data ?? NONE, [query.data])
}
