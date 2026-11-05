/**
 * The kinds an operator can create for one function (D1013), read from the holders'
 * `describe().kinds`: a kind's owning addon, its registry `brokerKind`, its sign-in contract and
 * connect paths are resolved once here. `InstanceCreateDialog` and the pickers read through it.
 * Kind VALUES are data; nothing here branches on one.
 */
import { useAddonsListCapabilityProviders, useSystem } from '@camstack/ui-library'
import type { IntegrationInstanceDescription } from '@camstack/types'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'

const HOLDER_CAP = 'integration-instances'
const DESCRIBE_QUERY_KEY = 'instance-kinds-describe'

/** A kind the operator can create, with the provider that serves it. */
export interface InstanceKindOption {
  readonly addonId: string
  /** The kind id sent back as `createInstance.kind`. */
  readonly kind: string
  /** The registry kind of the broker it yields (`kind.brokerKind ?? kind.id`). */
  readonly brokerKind: string
  readonly label: string
  readonly connectPath?: string
  readonly disconnectPath?: string
  readonly signInBasePath?: string
}

export interface InstanceKindsFilter {
  readonly functionCap: string
  readonly addonId?: string
  /** Narrow to one registry kind (`brokerKind ?? id`). */
  readonly kind?: string
}

export interface DescribedHolder {
  readonly addonId: string
  readonly description: IntegrationInstanceDescription
}

/** The creatable kinds of the section, across the described holders. Pure. */
export function buildInstanceKindOptions(
  holders: readonly DescribedHolder[],
  filter: InstanceKindsFilter,
): readonly InstanceKindOption[] {
  const out: InstanceKindOption[] = []
  for (const holder of holders) {
    if (filter.addonId !== undefined && holder.addonId !== filter.addonId) continue
    for (const k of holder.description.kinds ?? []) {
      if (k.functionCap !== filter.functionCap) continue
      const brokerKind = k.brokerKind ?? k.id
      if (filter.kind !== undefined && brokerKind !== filter.kind && k.id !== filter.kind) continue
      out.push({
        addonId: holder.addonId,
        kind: k.id,
        brokerKind,
        label: k.label,
        ...(k.connectPath !== undefined ? { connectPath: k.connectPath } : {}),
        ...(k.disconnectPath !== undefined ? { disconnectPath: k.disconnectPath } : {}),
        ...(k.signIn !== undefined ? { signInBasePath: k.signIn.basePath } : {}),
      })
    }
  }
  return out
}

export interface UseInstanceKindsResult {
  readonly options: readonly InstanceKindOption[]
  readonly holders: readonly DescribedHolder[]
  readonly isLoading: boolean
}

export function useInstanceKinds(filter: InstanceKindsFilter): UseInstanceKindsResult {
  const system = useSystem()
  const functionQuery = useAddonsListCapabilityProviders({ capName: filter.functionCap })
  const holdersQuery = useAddonsListCapabilityProviders({ capName: HOLDER_CAP })
  const holderIds = useMemo<readonly string[]>(() => {
    const holding = new Set((holdersQuery.data ?? []).map((p) => p.addonId))
    return (functionQuery.data ?? []).map((p) => p.addonId).filter((id) => holding.has(id))
  }, [functionQuery.data, holdersQuery.data])
  const described = useQueries({
    queries: holderIds.map((addonId) => ({
      queryKey: [DESCRIBE_QUERY_KEY, addonId],
      queryFn: async (): Promise<DescribedHolder> => ({
        addonId,
        description: await system.trpcClient.integrationInstances.describe.query({ addonId }),
      }),
    })),
  })
  const holders = useMemo<readonly DescribedHolder[]>(
    () => described.flatMap((q) => (q.data === undefined ? [] : [q.data])),
    [described],
  )
  const options = useMemo(
    () => buildInstanceKindOptions(holders, filter),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter is read by its fields
    [holders, filter.functionCap, filter.addonId, filter.kind],
  )
  return {
    options,
    holders,
    isLoading:
      functionQuery.isLoading === true ||
      holdersQuery.isLoading === true ||
      described.some((q) => q.isLoading),
  }
}
