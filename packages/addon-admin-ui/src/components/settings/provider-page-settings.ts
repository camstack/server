/**
 * Which settings already live on a provider page (an `InstancesTable`).
 *
 * A function cap named by an `integration-instances` kind, plus `login-method`
 * (a provider that keeps no records, such as passkeys, still has a row).
 * The aggregate System → Settings surface drops declarations of those caps.
 * A section owned by any other cap stays — the owner is the capability, not
 * the addon. A surface that names `capability`, `sectionIds`, `fieldScope`
 * or `fieldKeys` is that page (or a node card) and is left alone.
 */
import { useQuery, useQueries } from '@tanstack/react-query'
import { useSystem } from '@camstack/ui-library'

/** The function cap of a sign-in provider. Always on an InstancesTable, even with no kind. */
export const LOGIN_METHOD_CAP = 'login-method'

/** The cap whose `describe().kinds` name every other InstancesTable function cap. */
export const INTEGRATION_INSTANCES_CAP = 'integration-instances'

const EMPTY_CAPS: ReadonlySet<string> = new Set()

export interface ProviderPageCaps {
  /** `off` — do not filter. `loading` — the set is not known yet. `ready` — filter by `caps`. */
  readonly phase: 'off' | 'loading' | 'ready'
  readonly caps: ReadonlySet<string>
  /** Set when the provider list or a description failed. The known caps are still applied. */
  readonly error: string | null
}

export interface AggregateSurface {
  readonly level: string
  readonly capability?: string
  readonly sectionIds?: readonly string[]
  readonly fieldScope?: string
  readonly fieldKeys?: readonly string[]
}

/** The System → Settings panel: every hub addon, no narrowing. */
export function isAggregateSettingsSurface(surface: AggregateSurface): boolean {
  return (
    surface.level === 'global' &&
    surface.capability === undefined &&
    surface.sectionIds === undefined &&
    surface.fieldScope === undefined &&
    surface.fieldKeys === undefined
  )
}

/** `login-method` plus every function cap the described kinds name. */
export function functionCapsOfDescribed(
  kindCaps: readonly (readonly string[])[],
): ReadonlySet<string> {
  const caps = new Set<string>([LOGIN_METHOD_CAP])
  for (const group of kindCaps) {
    for (const cap of group) caps.add(cap)
  }
  return caps
}

interface QuerySlice {
  readonly isSuccess: boolean
  readonly isError: boolean
  readonly data?: readonly string[]
  readonly error: unknown
}

function waiting(query: QuerySlice): boolean {
  return !query.isSuccess && !query.isError
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message.length > 0
    ? err.message
    : 'Could not list connection providers'
}

/** Pure: phase and caps from the holder list and each holder's kind caps. */
export function deriveProviderPageCaps(input: {
  readonly active: boolean
  readonly canQuery: boolean
  readonly holders: QuerySlice
  readonly described: readonly QuerySlice[]
}): ProviderPageCaps {
  if (!input.active) return { phase: 'off', caps: EMPTY_CAPS, error: null }
  if (!input.canQuery) return { phase: 'ready', caps: EMPTY_CAPS, error: null }
  if (waiting(input.holders)) return { phase: 'loading', caps: EMPTY_CAPS, error: null }
  if (input.holders.isError) {
    return {
      phase: 'ready',
      caps: functionCapsOfDescribed([]),
      error: messageOf(input.holders.error),
    }
  }
  if (input.described.some(waiting)) return { phase: 'loading', caps: EMPTY_CAPS, error: null }
  const failed = input.described.find((query) => query.isError)
  const kindCaps = input.described.flatMap((query) =>
    query.data === undefined ? [] : [query.data],
  )
  return {
    phase: 'ready',
    caps: functionCapsOfDescribed(kindCaps),
    error: failed === undefined ? null : messageOf(failed.error),
  }
}

function addonIdOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || !('addonId' in raw)) return null
  const id = raw.addonId
  return typeof id === 'string' && id.length > 0 ? id : null
}

async function loadHolderIds(
  listProviders: (input: { capName: string }) => Promise<unknown>,
): Promise<readonly string[]> {
  const raw = await listProviders({ capName: INTEGRATION_INSTANCES_CAP })
  if (!Array.isArray(raw)) {
    throw new Error('listCapabilityProviders did not answer with a list')
  }
  const ids: string[] = []
  for (const row of raw) {
    const id = addonIdOf(row)
    if (id !== null) ids.push(id)
  }
  return ids
}

function kindCapsOf(description: unknown): readonly string[] {
  if (typeof description !== 'object' || description === null || !('kinds' in description))
    return []
  const kinds = description.kinds
  if (!Array.isArray(kinds)) return []
  const caps: string[] = []
  for (const kind of kinds) {
    if (typeof kind !== 'object' || kind === null || !('functionCap' in kind)) continue
    const cap = kind.functionCap
    if (typeof cap === 'string' && cap.length > 0) caps.push(cap)
  }
  return caps
}

/**
 * The function caps an InstancesTable shows. Inactive on a narrowed surface.
 * When the transport has no provider list, the set is empty — nothing is skipped
 * that the UI could not see.
 */
export function useProviderPageCaps(active: boolean): ProviderPageCaps {
  const trpc = useSystem().trpcClient
  const listProviders = trpc.addons.listCapabilityProviders?.query
  const describeKind = trpc.integrationInstances?.describe?.query
  const canQuery = listProviders !== undefined && describeKind !== undefined
  const holders = useQuery({
    queryKey: ['settings', 'provider-page-holders'],
    enabled: active && canQuery,
    queryFn: () => {
      if (listProviders === undefined) throw new Error('listCapabilityProviders is not available')
      return loadHolderIds(listProviders)
    },
  })
  const holderIds = holders.data ?? []
  const described = useQueries({
    queries: holderIds.map((addonId) => ({
      queryKey: ['settings', 'provider-page-kinds', addonId],
      enabled: active && canQuery && holders.isSuccess,
      queryFn: async (): Promise<readonly string[]> => {
        if (describeKind === undefined)
          throw new Error('integrationInstances.describe is not available')
        return kindCapsOf(await describeKind({ addonId }))
      },
    })),
  })
  return deriveProviderPageCaps({
    active,
    canQuery,
    holders,
    described,
  })
}
