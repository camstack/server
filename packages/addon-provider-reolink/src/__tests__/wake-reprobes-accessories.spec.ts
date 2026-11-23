/**
 * The wiring of the accessory re-probe into `onWakeTransition`: a first-hand
 * wake of a probed battery camera past the window re-probes; a lagging hub
 * sweep (`hub-reconcile`) or a wired camera does not; a rejected reprobe is
 * swallowed and logged. `onWakeTransition` runs on a stand-in `this` through
 * the real prototype methods.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESSORY_REPROBE_WINDOW_MS, AccessoryReprobeWindow } from '../accessory-reprobe-window.js'
import { ReolinkCamera } from '../reolink-camera.js'
import type { SleepCommitSource } from '../sleep-state-decision.js'

const NOW = 1_800_000_000_000
const STALE = NOW - ACCESSORY_REPROBE_WINDOW_MS - 1

function method(name: string, self: object, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(ReolinkCamera.prototype, name)
  if (typeof fn !== 'function') throw new Error(`${name} is not a method`)
  return Reflect.apply(fn, self, args)
}

interface Harness {
  readonly wake: (reason: SleepCommitSource) => unknown
  readonly reprobe: ReturnType<typeof vi.fn>
  readonly logger: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
}

function build(opts: {
  isBattery: boolean
  lastProbedAt: number
  reprobe?: () => Promise<void>
}): Harness {
  const logger = { info: vi.fn(), debug: vi.fn() }
  const reprobe = vi.fn(opts.reprobe ?? (async () => undefined))
  const self = {
    id: 41,
    isBattery: opts.isBattery,
    ctx: { logger },
    auxAccessoryRefs: new Map(),
    accessoryReprobeWindow: new AccessoryReprobeWindow(),
    runtimeState: { getCapState: () => ({ lastProbedAt: opts.lastProbedAt }) },
    shouldRebuildCatalogOnWake: () => false,
    hasProbed: () => true,
    reprobe,
    getBatteryRefresh: () => ({
      noteAwake: async () => true,
      shouldDeferForStream: () => false,
      noteStreamDeferred: () => undefined,
    }),
    refreshClipCatalogOnWake: async () => undefined,
    warmCapSlicesOnWake: async () => undefined,
    warmSnapshotOnWake: async () => undefined,
    alignAuxDevicesState: async () => undefined,
    refreshParentSettingsSnapshot: async () => undefined,
    reprobeAccessoriesIfStale: (reason: SleepCommitSource) =>
      method('reprobeAccessoriesIfStale', self, reason),
  }
  return { wake: (reason) => method('onWakeTransition', self, reason), reprobe, logger }
}

describe('onWakeTransition re-probes the accessories of a stale battery camera', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-probes on a first-hand wake past the window, logging the trigger with the deviceId', async () => {
    vi.useFakeTimers({ now: NOW })
    const h = build({ isBattery: true, lastProbedAt: STALE })
    await h.wake('simple-event')
    expect(h.reprobe).toHaveBeenCalledTimes(1)
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('accessory re-probe'),
      expect.objectContaining({ tags: { deviceId: 41 } }),
    )
  })

  it('does not re-probe on a hub-reconcile wake (the sweep lags real state)', async () => {
    vi.useFakeTimers({ now: NOW })
    const h = build({ isBattery: true, lastProbedAt: STALE })
    await h.wake('hub-reconcile')
    expect(h.reprobe).not.toHaveBeenCalled()
  })

  it('does not re-probe a wired camera', async () => {
    vi.useFakeTimers({ now: NOW })
    const h = build({ isBattery: false, lastProbedAt: STALE })
    await h.wake('simple-event')
    expect(h.reprobe).not.toHaveBeenCalled()
  })

  it('does not re-probe inside the window', async () => {
    vi.useFakeTimers({ now: NOW })
    const h = build({ isBattery: true, lastProbedAt: NOW - 1000 })
    await h.wake('simple-event')
    expect(h.reprobe).not.toHaveBeenCalled()
  })

  it('swallows and logs a rejected reprobe', async () => {
    vi.useFakeTimers({ now: NOW })
    const h = build({
      isBattery: true,
      lastProbedAt: STALE,
      reprobe: async () => {
        throw new Error('login refused')
      },
    })
    await expect(h.wake('sleep-poll')).resolves.toBeUndefined()
    expect(h.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('accessory re-probe failed'),
      expect.objectContaining({ tags: { deviceId: 41 }, meta: { error: 'login refused' } }),
    )
  })
})
