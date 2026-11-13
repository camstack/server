/**
 * Reads the list a `dynamic` offer names off one device, through the router of
 * the cap it reads — its own or the sibling it names (`<cap>.getStatus` or the offer's read method, both `{ deviceId }`).
 * The router is reached by key, so the answer is `unknown` and is narrowed by
 * `dynamicChoicesOf` — nothing here assumes a cap's shape.
 */

import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import {
  capRouterKey,
  type DynamicChoices,
  type DynamicOffer,
  dynamicChoicesOf,
  dynamicReadCap,
  dynamicReadName,
} from './dynamic-offer'

const STALE_MS = 30_000

interface QueryProcedure {
  readonly query: (input: { readonly deviceId: number }) => Promise<unknown>
}

function isQueryProcedure(value: unknown): value is QueryProcedure {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'query') === 'function'
  )
}

export function useDynamicChoices(
  deviceId: number | null,
  cap: string,
  offer: DynamicOffer | null,
): DynamicChoices {
  const system = useSystem()
  const read = offer === null ? '' : dynamicReadName(offer)
  const readCap = offer === null ? cap : dynamicReadCap(cap, offer)
  const query = useQuery({
    queryKey: ['build', 'dynamic-offer', deviceId, readCap, read],
    enabled: deviceId !== null && deviceId > 0 && offer !== null,
    staleTime: STALE_MS,
    retry: false,
    queryFn: async (): Promise<unknown> => {
      const router: unknown = Reflect.get(system.trpcClient, capRouterKey(readCap))
      const procedure: unknown =
        typeof router === 'object' && router !== null ? Reflect.get(router, read) : undefined
      if (!isQueryProcedure(procedure) || deviceId === null) {
        throw new Error(`no readable ${readCap}.${read}`)
      }
      return procedure.query({ deviceId })
    },
  })
  if (offer === null || deviceId === null) return { state: 'unavailable' }
  if (query.isPending) return { state: 'loading' }
  if (query.isError) return { state: 'unavailable' }
  const choices = dynamicChoicesOf(query.data, offer)
  return choices.length === 0 ? { state: 'unavailable' } : { state: 'ready', choices }
}
