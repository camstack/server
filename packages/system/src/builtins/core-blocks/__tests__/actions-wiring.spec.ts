import { describe, expect, it } from 'vitest'
import type { AddonApi } from '@camstack/types'
import { sourcesOver } from '../actions-wiring.js'

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
