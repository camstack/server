/**
 * Reads the list a `dynamic` offer names off one device, through the router of
 * the cap it reads — its own or the sibling it names (`<cap>.getStatus` or the offer's read method, both `{ deviceId }`).
 * The router is reached by key, so the answer is `unknown` and is narrowed by
 * `dynamicChoicesOf` — nothing here assumes a cap's shape.
 */

import {
  type ActionGateAnswer,
  type ActionGateAnswerOf,
  actionGateAnswerFrom,
  type DynamicOfferAnswer,
  type DynamicOfferAnswerOf,
  type LooseVocabActionGate,
  type ResolvedVocabAction,
} from '@dominevo/types'
import { useSystem } from '@dominevo/ui-library'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  capRouterKey,
  type DynamicChoices,
  type DynamicOffer,
  dynamicAnswerOf,
  dynamicChoicesOf,
  dynamicReadCap,
  dynamicReadName,
  isDynamicOffer,
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

/** The query that reads one dynamic list off one device; shared so every reader hits one cache entry. */
function dynamicReadQuery(
  trpcClient: unknown,
  deviceId: number | null,
  readCap: string,
  read: string,
) {
  return {
    queryKey: ['build', 'dynamic-offer', deviceId, readCap, read],
    staleTime: STALE_MS,
    retry: false,
    queryFn: async (): Promise<unknown> => {
      const router: unknown =
        typeof trpcClient === 'object' && trpcClient !== null
          ? Reflect.get(trpcClient, capRouterKey(readCap))
          : undefined
      const procedure: unknown =
        typeof router === 'object' && router !== null ? Reflect.get(router, read) : undefined
      if (!isQueryProcedure(procedure) || deviceId === null) {
        throw new Error(`no readable ${readCap}.${read}`)
      }
      return procedure.query({ deviceId })
    },
  }
}

interface DynamicRead {
  readonly key: string
  readonly readCap: string
  readonly read: string
  readonly offer: DynamicOffer
}

function readKey(readCap: string, read: string): string {
  return `${readCap}.${read}`
}

function dynamicReadsOf(actions: readonly ResolvedVocabAction[]): readonly DynamicRead[] {
  const reads = new Map<string, DynamicRead>()
  for (const action of actions) {
    for (const arg of action.openArgs) {
      if (!isDynamicOffer(arg.offer)) continue
      const readCap = dynamicReadCap(action.cap, arg.offer)
      const read = dynamicReadName(arg.offer)
      const key = readKey(readCap, read)
      if (!reads.has(key)) reads.set(key, { key, readCap, read, offer: arg.offer })
    }
  }
  return [...reads.values()]
}

/**
 * What ONE device answered for every dynamic list its commands read, as the
 * `answerOf` of `offeredActionsWith`. With no device, every answer is pending.
 */
export function useDynamicOfferAnswers(
  deviceId: number | null,
  actions: readonly ResolvedVocabAction[],
): DynamicOfferAnswerOf {
  const system = useSystem()
  const reads = dynamicReadsOf(actions)
  const results = useQueries({
    queries: reads.map((r) => ({
      ...dynamicReadQuery(system.trpcClient, deviceId, r.readCap, r.read),
      enabled: deviceId !== null && deviceId > 0,
    })),
  })
  const answers = new Map<string, DynamicOfferAnswer>()
  reads.forEach((r, i) => {
    const result = results[i]
    if (result === undefined || result.isPending) answers.set(r.key, { kind: 'pending' })
    else if (result.isError) answers.set(r.key, { kind: 'failed' })
    else answers.set(r.key, dynamicAnswerOf(result.data, r.offer))
  })
  return (cap, offer) =>
    answers.get(readKey(dynamicReadCap(cap, offer), dynamicReadName(offer))) ?? { kind: 'pending' }
}

interface GateRead {
  readonly key: string
  readonly cap: string
  readonly gate: LooseVocabActionGate
}

function gateReadsOf(actions: readonly ResolvedVocabAction[]): readonly GateRead[] {
  const reads = new Map<string, GateRead>()
  for (const action of actions) {
    if (action.offeredWhen === null) continue
    const key = `${readKey(action.cap, action.offeredWhen.method)}#${action.offeredWhen.field}`
    if (!reads.has(key)) reads.set(key, { key, cap: action.cap, gate: action.offeredWhen })
  }
  return [...reads.values()]
}

/**
 * What ONE device answered for every `offeredWhen` read its commands name, as
 * the `gateOf` of `offeredActionsWith` (a switch that only reports offers no
 * on/off — D1058). A read that failed or is pending keeps the command (D315).
 */
export function useActionGateAnswers(
  deviceId: number | null,
  actions: readonly ResolvedVocabAction[],
): ActionGateAnswerOf {
  const system = useSystem()
  const reads = gateReadsOf(actions)
  const results = useQueries({
    queries: reads.map((r) => ({
      ...dynamicReadQuery(system.trpcClient, deviceId, r.cap, r.gate.method),
      enabled: deviceId !== null && deviceId > 0,
    })),
  })
  const answers = new Map<string, ActionGateAnswer>()
  reads.forEach((r, i) => {
    const result = results[i]
    if (result === undefined || result.isPending) answers.set(r.key, { kind: 'pending' })
    else if (result.isError) answers.set(r.key, { kind: 'failed' })
    else answers.set(r.key, actionGateAnswerFrom(result.data, r.gate))
  })
  return (cap, gate) =>
    answers.get(`${readKey(cap, gate.method)}#${gate.field}`) ?? { kind: 'pending' }
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
    ...dynamicReadQuery(system.trpcClient, deviceId, readCap, read),
    enabled: deviceId !== null && deviceId > 0 && offer !== null,
  })
  if (offer === null || deviceId === null) return { state: 'unavailable' }
  if (query.isPending) return { state: 'loading' }
  if (query.isError) return { state: 'unavailable' }
  const choices = dynamicChoicesOf(query.data, offer)
  return choices.length === 0 ? { state: 'unavailable' } : { state: 'ready', choices }
}
