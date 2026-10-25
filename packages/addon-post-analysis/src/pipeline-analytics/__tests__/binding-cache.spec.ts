/**
 * BindingCache unit tests — P9.
 *
 * Covers:
 *  - isActive: initial miss hits deviceManager.getBindings and caches
 *  - isActive: subsequent hits come from the cache (no API call)
 *  - inflight dedup: concurrent isActive calls coalesce into one lookup
 *  - onBindingsChanged(wrapper-activated/deactivated): writes the cache
 *  - onBindingsChanged(native-registered/unregistered): invalidates so
 *    the next isActive refetches
 *  - invalidate + clearAll
 *  - getBindings failure defaults to inactive
 */
import { describe, it, expect, vi } from 'vitest'
import { BindingCache } from '../runtime/binding-cache.js'
import { makeFakeAddonApi, makeFakeDeviceManager, makeSilentLogger } from './test-helpers.js'
import type { AddonApi } from '@camstack/types'

function makeApiWithSpy(
  override?: (input: { deviceId: number }) => Promise<{ deviceId: number; entries: unknown[] }>,
): {
  api: AddonApi
  calls: number
} {
  let calls = 0
  const defaultHandler = async (input: { deviceId: number }) => ({
    deviceId: input.deviceId,
    entries: [],
  })
  const api = {
    deviceManager: {
      getBindings: {
        query: async (input: { deviceId: number }) => {
          calls++
          return (override ?? defaultHandler)(input)
        },
      },
    },
  } as unknown as AddonApi
  return {
    api,
    get calls() {
      return calls
    },
  } as { api: AddonApi; calls: number }
}

describe('BindingCache', () => {
  describe('isActive', () => {
    it('is false when getBindings returns no pipeline-analytics entry', async () => {
      const { api } = makeApiWithSpy()
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      expect(await cache.isActive(4)).toBe(false)
    })

    it('is true when getBindings returns a pipeline-analytics entry', async () => {
      const api = {
        deviceManager: {
          getBindings: {
            query: async () => ({
              deviceId: 4,
              entries: [
                {
                  capName: 'pipeline-analytics',
                  kind: 'wrapped',
                  providerAddonId: 'pipeline-analytics',
                  providerNodeId: 'hub',
                  nativeAddonId: '',
                },
              ],
            }),
          },
        },
      } as unknown as AddonApi
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      expect(await cache.isActive(4)).toBe(true)
    })

    it('caches on first lookup — subsequent calls hit RAM', async () => {
      const dm = makeFakeDeviceManager()
      dm.setActive(4, 'pipeline-analytics', true)
      const spy = vi.spyOn(dm.api.deviceManager.getBindings, 'query')
      const api = makeFakeAddonApi({
        settingsStore: {} as AddonApi['settingsStore'],
        deviceManager: dm.api.deviceManager,
      })
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      expect(await cache.isActive(4)).toBe(true)
      expect(await cache.isActive(4)).toBe(true)
      expect(await cache.isActive(4)).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('coalesces concurrent lookups into a single API call', async () => {
      let resolveGate!: () => void
      const gate = new Promise<void>((r) => {
        resolveGate = r
      })
      let calls = 0
      const api = {
        deviceManager: {
          getBindings: {
            query: async () => {
              calls++
              await gate
              return { deviceId: 4, entries: [] }
            },
          },
        },
      } as unknown as AddonApi
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      const p1 = cache.isActive(4)
      const p2 = cache.isActive(4)
      const p3 = cache.isActive(4)
      resolveGate()
      await Promise.all([p1, p2, p3])
      expect(calls).toBe(1)
    })

    it('defaults to inactive when getBindings throws', async () => {
      const api = {
        deviceManager: {
          getBindings: {
            query: async () => {
              throw new Error('registry not ready')
            },
          },
        },
      } as unknown as AddonApi
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      expect(await cache.isActive(4)).toBe(false)
    })
  })

  describe('onBindingsChanged', () => {
    it('writes cached state on wrapper-activated / wrapper-deactivated', async () => {
      const { api } = makeApiWithSpy()
      const cache = new BindingCache({ api, logger: makeSilentLogger() })

      cache.onBindingsChanged({
        deviceId: 4,
        capName: 'pipeline-analytics',
        reason: 'wrapper-activated',
      })
      expect(await cache.isActive(4)).toBe(true)

      cache.onBindingsChanged({
        deviceId: 4,
        capName: 'pipeline-analytics',
        reason: 'wrapper-deactivated',
      })
      expect(await cache.isActive(4)).toBe(false)
    })

    it('ignores events for other caps', async () => {
      const { api } = makeApiWithSpy()
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      cache.onBindingsChanged({
        deviceId: 4,
        capName: 'pipeline-analytics',
        reason: 'wrapper-activated',
      })
      cache.onBindingsChanged({ deviceId: 4, capName: 'other-cap', reason: 'wrapper-deactivated' })
      expect(await cache.isActive(4)).toBe(true)
    })

    it('invalidates (not sets) on native-registered / native-unregistered', async () => {
      let returnActive = true
      const api = {
        deviceManager: {
          getBindings: {
            query: async () => ({
              deviceId: 4,
              entries: returnActive
                ? [
                    {
                      capName: 'pipeline-analytics',
                      kind: 'wrapped',
                      providerAddonId: 'x',
                      providerNodeId: 'hub',
                      nativeAddonId: '',
                    },
                  ]
                : [],
            }),
          },
        },
      } as unknown as AddonApi
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      expect(await cache.isActive(4)).toBe(true) // seed cache

      // Flip the upstream to inactive + fire native-unregistered → cache
      // drops its entry + next lookup returns the new value.
      returnActive = false
      cache.onBindingsChanged({
        deviceId: 4,
        capName: 'pipeline-analytics',
        reason: 'native-unregistered',
      })
      expect(await cache.isActive(4)).toBe(false)
    })
  })

  describe('invalidate / clearAll', () => {
    it('invalidate drops a single device', async () => {
      const dm = makeFakeDeviceManager()
      dm.setActive(4, 'pipeline-analytics', true)
      const spy = vi.spyOn(dm.api.deviceManager.getBindings, 'query')
      const api = makeFakeAddonApi({
        settingsStore: {} as AddonApi['settingsStore'],
        deviceManager: dm.api.deviceManager,
      })
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      await cache.isActive(4)
      cache.invalidate(4)
      await cache.isActive(4)
      expect(spy).toHaveBeenCalledTimes(2)
    })

    it('clearAll drops every device', async () => {
      const dm = makeFakeDeviceManager()
      dm.setActive(4, 'pipeline-analytics', true)
      dm.setActive(5, 'pipeline-analytics', true)
      const spy = vi.spyOn(dm.api.deviceManager.getBindings, 'query')
      const api = makeFakeAddonApi({
        settingsStore: {} as AddonApi['settingsStore'],
        deviceManager: dm.api.deviceManager,
      })
      const cache = new BindingCache({ api, logger: makeSilentLogger() })
      await cache.isActive(4)
      await cache.isActive(5)
      cache.clearAll()
      await cache.isActive(4)
      await cache.isActive(5)
      expect(spy).toHaveBeenCalledTimes(4)
    })
  })
})
