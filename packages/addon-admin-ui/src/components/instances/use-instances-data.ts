/**
 * The queries behind the instances table, all derived from capabilities: the
 * providers of the function cap, the providers that hold `integration-instances` records, and
 * for each provider that is both, its description and its records. One query per provider, by
 * `addonId` — a record carries no addon id, so a fan-out without one could not route an action.
 */
import { useAddonsList, useAddonsListCapabilityProviders, useSystem } from '@camstack/ui-library'
import { useQueries } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { buildAddonDisplayNameMap } from '../../lib/addon-display-names'
import {
  buildRows,
  deriveState,
  type FunctionProvider,
  type HolderData,
  notRunningAddons,
  type PanelRow,
  type PanelState,
  sectionHolder,
} from './instances-model'

const POLL_INTERVAL_MS = 5_000
const HOLDER_CAP = 'integration-instances'

export const HOLDER_QUERY_KEY = 'provider-instances-holder'

export interface InstancesData {
  readonly state: PanelState
  readonly error: string | null
  readonly functionProviders: readonly FunctionProvider[]
  readonly rows: readonly PanelRow[]
  readonly holders: readonly HolderData[]
  readonly displayNames: ReadonlyMap<string, string>
  readonly descriptions: ReadonlyMap<string, string>
  readonly refetch: () => void
}

/** addonId → manifest description, so an addon describes itself. */
function descriptionMap(addons: readonly unknown[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const raw of addons) {
    const manifest = (raw as { manifest?: { id?: unknown; description?: unknown } } | null)
      ?.manifest
    if (typeof manifest?.id === 'string' && typeof manifest.description === 'string') {
      if (manifest.description.length > 0) map.set(manifest.id, manifest.description)
    }
  }
  return map
}

export function useInstancesData(functionCap: string): InstancesData {
  const system = useSystem()
  const functionQuery = useAddonsListCapabilityProviders(
    { capName: functionCap },
    { refetchInterval: POLL_INTERVAL_MS },
  )
  const holdersQuery = useAddonsListCapabilityProviders(
    { capName: HOLDER_CAP },
    { refetchInterval: POLL_INTERVAL_MS },
  )
  const addonsQuery = useAddonsList(undefined, {
    refetchInterval: POLL_INTERVAL_MS,
  })

  const functionProviders = useMemo<readonly FunctionProvider[]>(
    () =>
      (functionQuery.data ?? []).map((p) => ({
        addonId: p.addonId,
        isActive: p.isActive,
      })),
    [functionQuery.data],
  )
  const holderIds = useMemo<readonly string[]>(() => {
    const holding = new Set((holdersQuery.data ?? []).map((p) => p.addonId))
    return functionProviders.map((p) => p.addonId).filter((id) => holding.has(id))
  }, [functionProviders, holdersQuery.data])

  const holderQueries = useQueries({
    queries: holderIds.map((addonId) => ({
      queryKey: [HOLDER_QUERY_KEY, addonId],
      refetchInterval: POLL_INTERVAL_MS,
      queryFn: async (): Promise<HolderData> => {
        const client = system.trpcClient.integrationInstances
        const [description, instances] = await Promise.all([
          client.describe.query({ addonId }),
          client.listInstances.query({ addonId }),
        ])
        return { addonId, description, instances }
      },
    })),
  })

  const state = deriveState([functionQuery, holdersQuery, ...holderQueries])

  // A page section is a filter on `kinds[].functionCap` (D1013): the holder as THIS section sees it.
  const holders = useMemo<readonly HolderData[]>(
    () =>
      holderQueries.flatMap((q) => {
        const holder = q.data === undefined ? null : sectionHolder(q.data, functionCap)
        return holder === null ? [] : [holder]
      }),
    [holderQueries, functionCap],
  )
  const displayNames = useMemo(
    () => buildAddonDisplayNameMap(addonsQuery.data ?? []),
    [addonsQuery.data],
  )
  const descriptions = useMemo(() => descriptionMap(addonsQuery.data ?? []), [addonsQuery.data])

  // Only an ANSWERED `addons.list` says an addon is down; while it is pending nothing is claimed.
  const notRunning = useMemo(() => notRunningAddons(addonsQuery.data ?? []), [addonsQuery.data])

  const rows = useMemo<readonly PanelRow[]>(
    () => buildRows({ functionProviders, holders, displayNames, descriptions, notRunning }),
    [functionProviders, holders, displayNames, descriptions, notRunning],
  )

  const firstError =
    functionQuery.error ?? holdersQuery.error ?? holderQueries.find((q) => q.error)?.error ?? null

  const refetch = useCallback((): void => {
    void functionQuery.refetch()
    void holdersQuery.refetch()
    for (const q of holderQueries) void q.refetch()
  }, [functionQuery, holdersQuery, holderQueries])

  return {
    state,
    error: firstError === null ? null : firstError.message,
    functionProviders,
    rows,
    holders,
    displayNames,
    descriptions,
    refetch,
  }
}
