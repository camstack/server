/**
 * Who offers a device, as the picker draws it: the addon's name alone
 * ("Home Assistant"). The integration instance's name is never part of the
 * label (operator, 2026-11-13): it repeated the addon ("Home Assistant (Home
 * Assistant provider)") and told the reader nothing.
 *
 * Derived from what the UI already reads: the device's providing `addonId`
 * (fleet listing) and the addon's manifest name (`addons.list`). Nothing here
 * knows a kind or an addon; a row whose provider cannot be resolved shows no
 * line at all rather than a guess.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type SystemTrpcClient, useSystem } from '../../contexts/system-context.js'

export interface ProviderFleetRow {
  readonly id: number
  readonly addonId: string
}

export interface ProviderAddonRow {
  readonly id: string
  readonly name: string | undefined
}

/** `deviceId → provider label`; a device whose addon is unknown is absent. */
export function providerLabelsOf(
  fleet: readonly ProviderFleetRow[],
  addons: readonly ProviderAddonRow[],
): ReadonlyMap<number, string> {
  const addonName = new Map<string, string>()
  for (const a of addons) {
    if (a.name !== undefined && a.name !== '') addonName.set(a.id, a.name)
  }
  const out = new Map<number, string>()
  for (const d of fleet) {
    const addon = addonName.get(d.addonId)
    if (addon === undefined) continue
    out.set(d.id, addon)
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
  return useDeviceProviderLabelsWith(useSystem().trpcClient, enabled)
}

/**
 * The same labels through a client the caller holds — for a surface mounted
 * with a lent client and no `System` (the device module in a webview).
 */
export function useDeviceProviderLabelsWith(
  trpcClient: SystemTrpcClient,
  enabled: boolean,
): ReadonlyMap<number, string> {
  const query = useQuery({
    queryKey: ['ui-library', 'device-provider-labels'],
    enabled,
    staleTime: PROVIDER_LABELS_STALE_MS,
    queryFn: async (): Promise<ReadonlyMap<number, string>> => {
      const [fleet, addons] = await Promise.all([
        trpcClient.deviceManager.listAll.query({ projection: 'slim' }),
        trpcClient.addons.list.query(),
      ])
      return providerLabelsOf(
        fleet,
        addons.map((a) => ({ id: a.manifest.id, name: a.manifest.name })),
      )
    },
  })
  return useMemo(() => query.data ?? NONE, [query.data])
}
