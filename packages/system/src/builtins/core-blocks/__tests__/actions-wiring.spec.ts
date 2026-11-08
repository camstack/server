import { describe, expect, it } from 'vitest'
import type { AddonApi } from '@camstack/types'
import { readCommandOrigin } from '@camstack/types'
import { invokeCapOver, sourcesOver } from '../actions-wiring.js'

interface FakeOptions {
  /** `providers` of the registry entry; `null` = the registry has no entry. */
  readonly providers: readonly string[] | null
  readonly listActions: () => Promise<unknown[]>
}

function apiOf(options: FakeOptions): { api: AddonApi; listCalls: () => number } {
  let listCalls = 0
  const fake = {
    capabilities: {
      getCapability: {
        query: async () =>
          options.providers === null
            ? null
            : { name: 'action-source', mode: 'collection', providers: [...options.providers] },
      },
    },
    actionSource: {
      listActions: {
        query: () => {
          listCalls += 1
          return options.listActions()
        },
      },
    },
  }
  // The fake covers only the two routers the wiring reads.
  return { api: Object.assign(Object.create(null), fake), listCalls: () => listCalls }
}

const NEVER = (): Promise<unknown[]> => new Promise(() => undefined)

describe('sourcesOver.list', () => {
  it('answers none at once when the collection has no provider (does not wait for one)', async () => {
    const { api, listCalls } = apiOf({ providers: [], listActions: NEVER })
    const result = await Promise.race([
      sourcesOver(() => api).list(),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ])
    expect(result).toEqual([])
    expect(listCalls()).toBe(0)
  })

  it('still asks, and still fails, when a provider is registered', async () => {
    const { api } = apiOf({
      providers: ['some-addon'],
      listActions: async () => {
        throw new Error('provider exploded')
      },
    })
    await expect(sourcesOver(() => api).list()).rejects.toThrow('provider exploded')
  })

  it('returns the providers entries when one is registered', async () => {
    const entry = { id: 'x:1' }
    const { api } = apiOf({ providers: ['x'], listActions: async () => [entry] })
    await expect(sourcesOver(() => api).list()).resolves.toEqual([entry])
  })

  it('asks anyway when the registry has no entry (unanswered is not absent)', async () => {
    const { api, listCalls } = apiOf({ providers: null, listActions: async () => [] })
    await sourcesOver(() => api).list()
    expect(listCalls()).toBe(1)
  })
})

describe('invokeCapOver origin (D1022)', () => {
  function sirenApi(): { api: AddonApi; seen: Array<{ input: unknown; options: unknown }> } {
    const seen: Array<{ input: unknown; options: unknown }> = []
    const fake = {
      siren: { on: { mutate: async (input: unknown, options?: unknown) => void seen.push({ input, options }) } },
    }
    return { api: Object.assign(Object.create(null), fake), seen }
  }

  it('hands the origin to the call as request context, never inside the arguments', async () => {
    const { api, seen } = sirenApi()
    await invokeCapOver(() => api)({
      deviceId: 616,
      cap: 'siren',
      method: 'on',
      args: { volume: 9 },
      origin: { kind: 'action', actionId: 'a1', runId: 'r1' },
    })
    expect(seen[0]?.input).toEqual({ volume: 9, deviceId: 616 })
    const context = Reflect.get(Object(seen[0]?.options), 'context')
    expect(readCommandOrigin(context)).toEqual({ kind: 'action', actionId: 'a1', runId: 'r1' })
  })

  it('sends a call without an origin exactly as before', async () => {
    const { api, seen } = sirenApi()
    await invokeCapOver(() => api)({ deviceId: 616, cap: 'siren', method: 'on', args: {} })
    expect(seen[0]).toEqual({ input: { deviceId: 616 }, options: undefined })
  })
})
