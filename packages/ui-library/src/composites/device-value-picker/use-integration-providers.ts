/**
 * Who offers each integration instance, for the picker's Integration facet:
 * `integrationId → the addon's name` ("Casa" → "Homematic"). Two instances
 * may share a name; the provider is what tells them apart.
 *
 * Derived from what the UI already reads — the instance list and the addon
 * manifests. An instance whose addon is unknown is absent: no line is drawn
 * rather than a guess, and nothing is claimed before the reads answer.
 */
import { useMemo } from 'react'
import { useAddonsList, useIntegrationsList } from '../../generated/system-hooks'

export interface ProviderIntegrationRow {
  readonly id: string
  readonly addonId: string
}

export interface ProviderAddonName {
  readonly id: string
  readonly name: string | undefined
}

export function integrationProvidersOf(
  integrations: readonly ProviderIntegrationRow[],
  addons: readonly ProviderAddonName[],
): ReadonlyMap<string, string> {
  const addonName = new Map<string, string>()
  for (const addon of addons) {
    if (addon.name !== undefined && addon.name !== '') addonName.set(addon.id, addon.name)
  }
  const out = new Map<string, string>()
  for (const integration of integrations) {
    const name = addonName.get(integration.addonId)
    if (name !== undefined) out.set(integration.id, name)
  }
  return out
}

const STALE_MS = 60_000

export function useIntegrationProviders(enabled: boolean): ReadonlyMap<string, string> {
  const integrations = useIntegrationsList(undefined, {
    enabled,
    staleTime: STALE_MS,
  })
  const addons = useAddonsList(undefined, { enabled, staleTime: STALE_MS })
  return useMemo(
    () =>
      integrationProvidersOf(
        integrations.data ?? [],
        (addons.data ?? []).map((a) => ({
          id: a.manifest.id,
          name: a.manifest.name,
        })),
      ),
    [integrations.data, addons.data],
  )
}
