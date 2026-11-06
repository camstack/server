/**
 * The instances an operator can link to, read from the ONE instance model (D1013 rule 5): every
 * provider of `integration-instances` that also serves the function cap describes its kinds, and
 * the instances of a kind whose `functionCap` is that cap are the pickable ones, narrowed to one
 * kind (`brokerKind ?? id`) when the link names it. Kind VALUES are data; nothing branches on one.
 */
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { IntegrationInstance, IntegrationInstanceDescription } from '@camstack/types'
import { useSystem } from '../contexts/system-context'
import { useAddonsListCapabilityProviders } from '../generated/system-hooks'

const POLL_INTERVAL_MS = 5_000

export const CAP_INSTANCES_QUERY_KEY = 'cap-instances-holder'

/** One instance a link field can pick. */
export interface LinkableInstance {
  readonly id: string
  readonly name: string
  /** The kind of the instance (`kind.brokerKind ?? kind.id`). */
  readonly kind: string
  readonly addonId: string
  readonly state: 'ok' | 'off' | 'error' | 'unknown'
  readonly stateLabel: string | null
  /** Switched on, configured and not failing: a picker offers only these, plus the chosen one. */
  readonly usable: boolean
}

export interface InstanceHolderData {
  readonly addonId: string
  readonly description: IntegrationInstanceDescription
  readonly instances: readonly IntegrationInstance[]
}

/** The usable ones plus the CURRENTLY chosen one, whatever its state. */
export function selectableInstances(
  instances: readonly LinkableInstance[],
  selectedId: string | null | undefined,
): readonly LinkableInstance[] {
  return instances.filter((i) => i.usable || i.id === selectedId)
}

/**
 * The instances of one holder whose kind is configured for `functionCap`, optionally of one kind.
 * A holder without `kinds` declares none, so it holds none.
 */
export function instancesOfHolder(
  holder: InstanceHolderData,
  functionCap: string,
  kind?: string,
): readonly LinkableInstance[] {
  const kinds = holder.description.kinds ?? []
  const out: LinkableInstance[] = []
  for (const instance of holder.instances) {
    const own = kinds.find((k) => k.id === instance.kind)
    if (own === undefined || own.functionCap !== functionCap) continue
    const kindName = own.brokerKind ?? own.id
    if (kind !== undefined && kindName !== kind) continue
    out.push({
      id: instance.id,
      name: instance.name,
      kind: kindName,
      addonId: holder.addonId,
      state: instance.status?.state ?? 'unknown',
      stateLabel: instance.status?.label ?? null,
      usable:
        instance.enabled !== false &&
        instance.configured &&
        instance.status?.state !== 'off' &&
        instance.status?.state !== 'error',
    })
  }
  return out
}

export interface UseInstancesOfCapResult {
  readonly data: readonly LinkableInstance[] | undefined
  readonly isLoading: boolean
  readonly isError: boolean
  readonly isSuccess: boolean
  readonly error: { readonly message: string } | null
}

export function useInstancesOfCap(
  filter: { readonly functionCap: string; readonly kind?: string },
  opts: { readonly enabled?: boolean } = {},
): UseInstancesOfCapResult {
  const system = useSystem()
  const enabled = opts.enabled ?? true
  const capProviders = useAddonsListCapabilityProviders(
    { capName: filter.functionCap },
    { refetchInterval: POLL_INTERVAL_MS, enabled },
  )
  const holders = useAddonsListCapabilityProviders(
    { capName: 'integration-instances' },
    { refetchInterval: POLL_INTERVAL_MS, enabled },
  )
  const holderIds = useMemo<readonly string[]>(() => {
    const holding = new Set((holders.data ?? []).map((p) => p.addonId))
    return (capProviders.data ?? []).map((p) => p.addonId).filter((id) => holding.has(id))
  }, [capProviders.data, holders.data])

  const queries = useQueries({
    queries: holderIds.map((addonId) => ({
      queryKey: [CAP_INSTANCES_QUERY_KEY, addonId],
      enabled,
      refetchInterval: POLL_INTERVAL_MS,
      queryFn: async (): Promise<InstanceHolderData> => {
        const client = system.trpcClient.integrationInstances
        const [description, instances] = await Promise.all([
          client.describe.query({ addonId }),
          client.listInstances.query({ addonId }),
        ])
        return { addonId, description, instances }
      },
    })),
  })

  const answered =
    enabled &&
    !capProviders.isLoading &&
    !holders.isLoading &&
    capProviders.data !== undefined &&
    holders.data !== undefined &&
    queries.every((q) => !q.isLoading)
  const data = useMemo<readonly LinkableInstance[] | undefined>(
    () =>
      answered
        ? queries.flatMap((q) =>
            q.data === undefined ? [] : instancesOfHolder(q.data, filter.functionCap, filter.kind),
          )
        : undefined,
    [answered, queries, filter.functionCap, filter.kind],
  )
  const firstError =
    capProviders.error ?? holders.error ?? queries.find((q) => q.error)?.error ?? null
  return {
    data,
    isLoading: enabled && !answered && firstError === null,
    isError: firstError !== null,
    isSuccess: answered && firstError === null,
    error: firstError,
  }
}
