/**
 * DetectionCoverageCache unit tests.
 *
 * The alarm-coverage authority the notification centre's device directory
 * reads: WHICH devices carry a WRAPPED `detection-pipeline` binding. The point
 * of the cache is that the directory's 30 s rule-reload tick STOPS calling
 * `getAllBindings` over the whole fleet — it warms ONCE, then rides
 * `DeviceBindingsChanged` events per device.
 *
 * Covers:
 *  - ensureWarm: seeds the whole fleet with ONE getAllBindings; only a WRAPPED
 *    detection-pipeline entry counts (native, or a different cap, does not).
 *  - ensureWarm is idempotent — a warm cache never calls getAllBindings again
 *    (the neutralisation test for the 30 s sweep).
 *  - a failed seed stays COLD (answers unknown) and retries next tick.
 *  - onBindingsChanged reflects a per-device change WITHOUT a fleet sweep.
 *  - destructive-direction: a covered→uncovered flip needs a concordant second
 *    read; a single transient empty read never reports a covered camera off.
 *  - forget / clearAll.
 */
import { describe, it, expect } from 'vitest'
import { DetectionCoverageCache } from '../runtime/detection-coverage-cache.js'
import { makeSilentLogger } from './test-helpers.js'
import { DETECTION_PIPELINE_CAP_NAME, type AddonApi } from '@camstack/types'

interface BindingEntry {
  readonly capName: string
  readonly kind: 'native' | 'wrapped'
}

interface FleetRow {
  readonly deviceId: number
  readonly entries: readonly BindingEntry[]
}

function entry(capName: string, kind: 'native' | 'wrapped'): BindingEntry {
  return { capName, kind }
}

function wrappedDetection(): BindingEntry {
  return entry(DETECTION_PIPELINE_CAP_NAME, 'wrapped')
}

interface Harness {
  readonly api: AddonApi
  readonly getAllCalls: () => number
  readonly getBindingsCalls: () => number
  /** Mutate the per-device binding set that a getBindings read will return. */
  setDeviceEntries: (deviceId: number, entries: readonly BindingEntry[]) => void
}

function makeApi(fleet: readonly FleetRow[]): Harness {
  let getAllCalls = 0
  let getBindingsCalls = 0
  const perDevice = new Map<number, readonly BindingEntry[]>()
  for (const row of fleet) perDevice.set(row.deviceId, row.entries)

  const api = {
    deviceManager: {
      getAllBindings: {
        query: async () => {
          getAllCalls++
          return fleet.map((r) => ({
            deviceId: r.deviceId,
            entries: r.entries.map((e) => ({
              ...e,
              providerAddonId: 'x',
              providerNodeId: 'hub',
              nativeAddonId: '',
            })),
          }))
        },
      },
      getBindings: {
        query: async (input: { deviceId: number }) => {
          getBindingsCalls++
          const entries = perDevice.get(input.deviceId) ?? []
          return {
            deviceId: input.deviceId,
            entries: entries.map((e) => ({
              ...e,
              providerAddonId: 'x',
              providerNodeId: 'hub',
              nativeAddonId: '',
            })),
          }
        },
      },
    },
  } as unknown as AddonApi

  return {
    api,
    getAllCalls: () => getAllCalls,
    getBindingsCalls: () => getBindingsCalls,
    setDeviceEntries: (deviceId, entries) => perDevice.set(deviceId, entries),
  }
}

describe('DetectionCoverageCache', () => {
  describe('ensureWarm (fleet seed)', () => {
    it('seeds the whole fleet with ONE getAllBindings', async () => {
      const h = makeApi([
        { deviceId: 1, entries: [wrappedDetection()] },
        { deviceId: 2, entries: [] },
        { deviceId: 3, entries: [entry('recording', 'wrapped')] },
      ])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(h.getAllCalls()).toBe(1)
      expect(cache.isWarm()).toBe(true)
      expect(cache.get(1)).toBe(true)
      expect(cache.get(2)).toBe(false)
      expect(cache.get(3)).toBe(false)
    })

    it('only a WRAPPED detection-pipeline entry is coverage — native does not count', async () => {
      const h = makeApi([
        {
          deviceId: 1,
          entries: [entry(DETECTION_PIPELINE_CAP_NAME, 'native')],
        },
        { deviceId: 2, entries: [wrappedDetection()] },
      ])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(cache.get(1)).toBe(false)
      expect(cache.get(2)).toBe(true)
    })

    it('NEUTRALISATION: a warm cache never re-runs getAllBindings on later ticks', async () => {
      const h = makeApi([{ deviceId: 1, entries: [wrappedDetection()] }])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      await cache.ensureWarm()
      await cache.ensureWarm()
      expect(h.getAllCalls()).toBe(1)
    })

    it('coalesces concurrent seeds into a single getAllBindings', async () => {
      const h = makeApi([{ deviceId: 1, entries: [wrappedDetection()] }])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await Promise.all([cache.ensureWarm(), cache.ensureWarm(), cache.ensureWarm()])
      expect(h.getAllCalls()).toBe(1)
    })

    it('a failed seed stays COLD (unknown for every id) and retries next tick', async () => {
      let attempts = 0
      const api = {
        deviceManager: {
          getAllBindings: {
            query: async () => {
              attempts++
              if (attempts === 1) throw new Error('registry racing')
              return [{ deviceId: 1, entries: [] }]
            },
          },
        },
      } as unknown as AddonApi
      const cache = new DetectionCoverageCache({
        api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(cache.isWarm()).toBe(false)
      expect(cache.has(1)).toBe(false)
      expect(cache.get(1)).toBeUndefined()
      // Next tick retries.
      await cache.ensureWarm()
      expect(cache.isWarm()).toBe(true)
      expect(attempts).toBe(2)
    })
  })

  describe('onBindingsChanged (per-device, no fleet sweep)', () => {
    it('reflects a device that gained a wrapped detection binding — without getAllBindings', async () => {
      const h = makeApi([{ deviceId: 1, entries: [] }])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(cache.get(1)).toBe(false)

      h.setDeviceEntries(1, [wrappedDetection()])
      await cache.onBindingsChanged({
        deviceId: 1,
        capName: DETECTION_PIPELINE_CAP_NAME,
        reason: 'wrapper-activated',
      })
      expect(cache.get(1)).toBe(true)
      // The fleet sweep ran exactly once (the warm seed) — never again.
      expect(h.getAllCalls()).toBe(1)
    })

    it('ignores events for a different cap', async () => {
      const h = makeApi([{ deviceId: 1, entries: [wrappedDetection()] }])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      const before = h.getBindingsCalls()
      await cache.onBindingsChanged({
        deviceId: 1,
        capName: 'recording',
        reason: 'wrapper-deactivated',
      })
      expect(h.getBindingsCalls()).toBe(before)
      expect(cache.get(1)).toBe(true)
    })
  })

  describe('destructive-direction discipline (D49)', () => {
    it('a covered→uncovered flip is confirmed by a concordant SECOND read', async () => {
      const h = makeApi([{ deviceId: 1, entries: [wrappedDetection()] }])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(cache.get(1)).toBe(true)

      // The wrapper really was removed — both reads agree it is gone.
      h.setDeviceEntries(1, [])
      const before = h.getBindingsCalls()
      await cache.onBindingsChanged({
        deviceId: 1,
        capName: DETECTION_PIPELINE_CAP_NAME,
        reason: 'wrapper-deactivated',
      })
      expect(cache.get(1)).toBe(false)
      // Two reads: the first said empty, the second confirmed it (D49).
      expect(h.getBindingsCalls()).toBe(before + 2)
    })

    it('a transient empty read never flips a covered camera off (the second read disagrees)', async () => {
      let reads = 0
      const api = {
        deviceManager: {
          getAllBindings: {
            query: async () => [{ deviceId: 1, entries: [wrappedDetection()] }],
          },
          getBindings: {
            query: async (_input: { deviceId: number }) => {
              reads++
              // First read is a transient blip (empty); the second recovers.
              const entries = reads === 1 ? [] : [wrappedDetection()]
              return {
                deviceId: 1,
                entries: entries.map((e) => ({
                  ...e,
                  providerAddonId: 'x',
                  providerNodeId: 'hub',
                  nativeAddonId: '',
                })),
              }
            },
          },
        },
      } as unknown as AddonApi
      const cache = new DetectionCoverageCache({
        api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(cache.get(1)).toBe(true)

      await cache.onBindingsChanged({
        deviceId: 1,
        capName: DETECTION_PIPELINE_CAP_NAME,
        reason: 'wrapper-deactivated',
      })
      // The second read disagreed with the destructive first — coverage held.
      expect(cache.get(1)).toBe(true)
      expect(reads).toBe(2)
    })

    it('a failed read never flips coverage — the previous value holds', async () => {
      const api = {
        deviceManager: {
          getAllBindings: {
            query: async () => [{ deviceId: 1, entries: [wrappedDetection()] }],
          },
          getBindings: {
            query: async () => {
              throw new Error('transient')
            },
          },
        },
      } as unknown as AddonApi
      const cache = new DetectionCoverageCache({
        api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(cache.get(1)).toBe(true)
      await cache.onBindingsChanged({
        deviceId: 1,
        capName: DETECTION_PIPELINE_CAP_NAME,
        reason: 'wrapper-deactivated',
      })
      expect(cache.get(1)).toBe(true)
    })
  })

  describe('forget / clearAll', () => {
    it('forget drops one device (an unregistered device is unknown again)', async () => {
      const h = makeApi([{ deviceId: 1, entries: [wrappedDetection()] }])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      expect(cache.has(1)).toBe(true)
      cache.forget(1)
      expect(cache.has(1)).toBe(false)
      expect(cache.get(1)).toBeUndefined()
    })

    it('clearAll drops the whole mirror and returns it to cold', async () => {
      const h = makeApi([
        { deviceId: 1, entries: [wrappedDetection()] },
        { deviceId: 2, entries: [] },
      ])
      const cache = new DetectionCoverageCache({
        api: h.api,
        logger: makeSilentLogger(),
      })
      await cache.ensureWarm()
      cache.clearAll()
      expect(cache.isWarm()).toBe(false)
      expect(cache.has(1)).toBe(false)
      // A fresh seed runs again.
      await cache.ensureWarm()
      expect(h.getAllCalls()).toBe(2)
    })
  })
})
