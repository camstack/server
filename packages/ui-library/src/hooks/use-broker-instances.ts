/**
 * The brokers an operator can pick, read from the ONE instance model (D1013): every provider of
 * `integration-instances` that also serves the `broker` function describes its kinds, and the
 * instances of a kind whose `functionCap` is `broker` are the brokers. A kind names the registry
 * kind of its brokers in `brokerKind` (absent: its `id`). Kind VALUES are data; nothing here
 * branches on one.
 */
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { IntegrationInstance, IntegrationInstanceDescription } from '@camstack/types'
import { useSystem } from '../contexts/system-context'
import { useAddonsListCapabilityProviders } from '../generated/system-hooks'

const POLL_INTERVAL_MS = 5_000
const BROKER_FUNCTION_CAP = 'broker'

export const BROKER_INSTANCES_QUERY_KEY = 'broker-instances-holder'

/** One broker, as the pickers and link fields see it. */
export interface BrokerInstance {
  readonly id: string
  readonly name: string
  /** The registry kind of the broker (`kind.brokerKind ?? kind.id`). */
  readonly kind: string
  readonly addonId: string
  readonly state: 'ok' | 'off' | 'error' | 'unknown'
  readonly stateLabel: string | null
}

export interface BrokerHolderData {
  readonly addonId: string
  readonly description: IntegrationInstanceDescription
  readonly instances: readonly IntegrationInstance[]
}

/**
 * The brokers of one holder: instances whose kind is a `broker` kind, optionally of one registry
 * kind. A holder without `kinds` serves one section and is read as all brokers when it is the
 * broker provider (its registry kind is the description `kind`).
 */
export function brokerInstancesOf(
  holder: BrokerHolderData,
  kind?: string,
): readonly BrokerInstance[] {
  const kinds = holder.description.kinds ?? []
  const out: BrokerInstance[] = []
  for (const instance of holder.instances) {
    const own = kinds.find((k) => k.id === instance.kind)
    if (own === undefined || own.functionCap !== BROKER_FUNCTION_CAP) continue
    const brokerKind = own.brokerKind ?? own.id
    if (kind !== undefined && brokerKind !== kind) continue
    out.push({
      id: instance.id,
      name: instance.name,
      kind: brokerKind,
      addonId: holder.addonId,
      state: instance.status?.state ?? 'unknown',
      stateLabel: instance.status?.label ?? null,
    })
  }
  return out
}

export interface UseBrokerInstancesResult {
  readonly data: readonly BrokerInstance[] | undefined
  readonly isLoading: boolean
  readonly isError: boolean
  readonly isSuccess: boolean
  readonly error: { readonly message: string } | null
}

export function useBrokerInstances(
  filter: { readonly kind?: string } = {},
  opts: { readonly enabled?: boolean } = {},
): UseBrokerInstancesResult {
  const system = useSystem()
  const enabled = opts.enabled ?? true
  const brokerProviders = useAddonsListCapabilityProviders(
    { capName: BROKER_FUNCTION_CAP },
    { refetchInterval: POLL_INTERVAL_MS, enabled },
  )
  const holders = useAddonsListCapabilityProviders(
    { capName: 'integration-instances' },
    { refetchInterval: POLL_INTERVAL_MS, enabled },
  )
  const holderIds = useMemo<readonly string[]>(() => {
    const holding = new Set((holders.data ?? []).map((p) => p.addonId))
    return (brokerProviders.data ?? []).map((p) => p.addonId).filter((id) => holding.has(id))
  }, [brokerProviders.data, holders.data])

  const queries = useQueries({
    queries: holderIds.map((addonId) => ({
      queryKey: [BROKER_INSTANCES_QUERY_KEY, addonId],
      enabled,
      refetchInterval: POLL_INTERVAL_MS,
      queryFn: async (): Promise<BrokerHolderData> => {
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
    !brokerProviders.isLoading &&
    !holders.isLoading &&
    brokerProviders.data !== undefined &&
    holders.data !== undefined &&
    queries.every((q) => !q.isLoading)
  const data = useMemo<readonly BrokerInstance[] | undefined>(
    () =>
      answered
        ? queries.flatMap((q) =>
            q.data === undefined ? [] : brokerInstancesOf(q.data, filter.kind),
          )
        : undefined,
    [answered, queries, filter.kind],
  )
  const firstError =
    brokerProviders.error ?? holders.error ?? queries.find((q) => q.error)?.error ?? null
  return {
    data,
    isLoading: enabled && !answered && firstError === null,
    isError: firstError !== null,
    isSuccess: answered && firstError === null,
    error: firstError,
  }
}
