import { describe, it, expect, vi, beforeEach } from 'vitest'
import sharp from 'sharp'
import {
  batteryCapability,
  snapshotCapability,
  type AddonContext,
  type CapabilityDefinition,
  type IScopedLogger,
  type InferNativeProvider,
  type InferProvider,
} from '@camstack/types'
import { SnapshotAddon } from '../snapshot.addon.js'
import { freshSnapshotDataDir } from './scratch-data-dir.js'

/**
 * End-to-end integration between the SnapshotAddon and a
 * TestCamera-style device. Unlike the addon's unit spec, this test
 * wires the FULL path:
 *
 *   SnapshotAddon
 *     → deviceManager.getDevice + deviceState.getCapSlice('battery')
 *       → a durable runtime slice backed by mutable in-memory state
 *     → ctx.getNativeProvider(snapshotCapability, deviceId)
 *       → a provider that tracks how many times it was invoked (proves
 *         the sleeping-cache guard short-circuited the wake)
 *
 * Drives the assertion pattern: with the same `SnapshotAddon` instance
 * and the same device, flipping `sleeping` changes whether the native
 * snapshot fetch happens — demonstrating the contract declared in the
 * `battery` cap's docstring ("providers MUST avoid polling during sleep
 * — reading the battery wakes the camera up").
 *
 * Uses a TestCamera-inspired battery state source rather than a static mock so
 * the cap's schema + value semantics are exercised end-to-end.
 */

type ISnapshotNativeProvider = InferNativeProvider<typeof snapshotCapability>
type IBatteryNativeProvider = InferNativeProvider<typeof batteryCapability>
type ISnapshotProvider = InferProvider<typeof snapshotCapability>

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

/**
 * Mirrors the TestCamera battery provider contract — getStatus returns
 * a schema-valid shape, mutation happens via an explicit test hook so
 * the spec can flip sleeping=true/false mid-run. Also exposes a
 * `stateHandle` matching the runtime mirror's slice shape.
 */
function makeBatteryProviderWithState() {
  const state = {
    level: 80,
    charging: 'none' as const,
    sleeping: false,
    lastUpdated: Date.now(),
  }
  const provider: IBatteryNativeProvider = {
    getStatus: async () => ({ ...state }),
    wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
  }
  const stateHandle = {
    get value() {
      return { ...state }
    },
    refresh: async () => {
      /* no-op for the fake — state is already in-sync */
    },
    subscribe: (_cb: (s: typeof state | undefined) => void) => () => undefined,
  }
  return {
    provider,
    stateHandle,
    setSleeping: (v: boolean) => {
      state.sleeping = v
      state.lastUpdated = Date.now()
    },
  }
}

/** Snapshot native provider with an invocation counter. */
function makeSnapshotNativeWithCounter() {
  let calls = 0
  let lastBase64: string | null = null
  const provider: ISnapshotNativeProvider = {
    getSnapshot: async () => {
      calls += 1
      const bytes = await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 3,
          background: calls % 2 === 0 ? '#3060d0' : '#d03030',
        },
      })
        .jpeg()
        .toBuffer()
      lastBase64 = bytes.toString('base64')
      return { base64: lastBase64, contentType: 'image/jpeg' }
    },
    invalidateCache: async () => {},
  }
  return { provider, getCallCount: () => calls, getLastBase64: () => lastBase64 }
}

function makeCtxRoutingCaps(providers: {
  battery?: IBatteryNativeProvider
  batteryStateHandle?: {
    value: unknown
    refresh: () => Promise<void>
    subscribe: (cb: (s: unknown) => void) => () => void
  }
  snapshot?: ISnapshotNativeProvider
  /**
   * Whether the test device should advertise `DeviceFeature.BatteryOperated`
   * via the mocked `api.deviceManager.getDevice`. The snapshot wrapper now
   * keys the per-device cache window off this feature flag, so battery
   * scenarios must opt in here.
   */
  isBattery?: boolean
}): AddonContext {
  const logger = makeLogger()
  const getNativeProvider = vi.fn((cap: CapabilityDefinition, _deviceId: number) => {
    if (cap.name === 'battery') return providers.battery ?? null
    if (cap.name === 'snapshot') return providers.snapshot ?? null
    return null
  })
  const kernelStub: unknown = { localNodeId: 'hub', devices: {} }
  const apiStub: unknown = {
    deviceManager: {
      getDevice: {
        query: vi.fn(async ({ deviceId }: { deviceId: number }) => ({
          id: deviceId,
          name: 'test-cam',
          features: providers.isBattery ? ['battery-operated'] : [],
        })),
      },
    },
    deviceState: {
      getCapSlice: {
        query: vi.fn(async () => {
          const handle = providers.batteryStateHandle
          if (!handle) return null
          await handle.refresh()
          return handle.value
        }),
      },
    },
  }
  const addonStore: Record<string, unknown> = {}
  const raw: unknown = {
    id: 'snapshot',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: freshSnapshotDataDir(),
    kernel: kernelStub,
    settings: {
      // A REAL store, not a write-swallower. The wrapper reads back the link
      // secret it just wrote to prove the store is answering; a fake that
      // accepts a write and then reports empty is indistinguishable from a
      // settings store that is down, and would make every test look like the
      // degraded path.
      readAddonStore: vi.fn(async () => ({ ...addonStore })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    api: apiStub,
    getNativeProvider,
  }
  return raw as AddonContext
}

async function initAddon(addon: SnapshotAddon, ctx: AddonContext): Promise<ISnapshotProvider> {
  const result = await addon.initialize(ctx)
  const list = (Array.isArray(result) ? result : (result?.providers ?? [])) as ReadonlyArray<{
    readonly provider: ISnapshotProvider
  }>
  const first = list[0]
  if (!first) throw new Error('SnapshotAddon.initialize returned no registrations')
  return first.provider
}

describe('SnapshotAddon × battery cap — sleeping-aware cache E2E', () => {
  let addon: SnapshotAddon
  beforeEach(() => {
    addon = new SnapshotAddon()
  })

  it('does NOT capture (and so does not wake) a SLEEPING battery cam without force', async () => {
    // Opening the device page issues a plain `force: false` fetch. On a
    // sleeping battery camera a capture means dialing the native, and the
    // Baichuan login alone wakes the firmware — so a page view woke the
    // camera whenever the cache was cold or past its window.
    const battery = makeBatteryProviderWithState()
    const snapshotNative = makeSnapshotNativeWithCounter()
    const ctx = makeCtxRoutingCaps({
      battery: battery.provider,
      batteryStateHandle: battery.stateHandle,
      snapshot: snapshotNative.provider,
      isBattery: true,
    })
    const provider = await initAddon(addon, ctx)

    battery.setSleeping(true)

    // Cold cache + asleep + no force → NO CAPTURE. That is what this test is
    // about, and it is unchanged: the native must not be dialed, because
    // dialing is what wakes the firmware.
    const cold = await provider.getSnapshot({ deviceId: 42 })
    expect(snapshotNative.getCallCount()).toBe(0)

    // What it answers WITH changed on 2026-08-11. It used to be `null`, which
    // the media route turned into a 404 and the client into a bare
    // "Unavailable" — indistinguishable from a broken camera. It now answers a
    // courtesy frame that says "Sleeping". Still no capture, still no wake.
    expect(cold).not.toBeNull()
    expect(cold?.contentType).toBe('image/jpeg')
    // A real JPEG, not a placeholder string: SOI marker.
    expect(Buffer.from(cold?.base64 ?? '', 'base64').subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    )
  })

  it('serves the LAST frame for a sleeping battery cam instead of capturing', async () => {
    const battery = makeBatteryProviderWithState()
    const snapshotNative = makeSnapshotNativeWithCounter()
    const ctx = makeCtxRoutingCaps({
      battery: battery.provider,
      batteryStateHandle: battery.stateHandle,
      snapshot: snapshotNative.provider,
      isBattery: true,
    })
    const provider = await initAddon(addon, ctx)

    // Warm the cache while awake (this is what the provider's wake warm-up
    // does for real), then go to sleep.
    const fresh = await provider.getSnapshot({ deviceId: 42 })
    expect(fresh?.base64).toBe(snapshotNative.getLastBase64())
    expect(snapshotNative.getCallCount()).toBe(1)
    battery.setSleeping(true)

    // A plain fetch keeps the real cached frame as its background, but state
    // now outranks raw pixels: the returned bytes carry the Sleeping overlay.
    const cached = await provider.getSnapshot({ deviceId: 42 })
    expect(cached?.base64).not.toBe(fresh?.base64)
    expect(cached?.contentType).toBe('image/jpeg')
    expect(snapshotNative.getCallCount()).toBe(1)
  })

  it('DOES capture a sleeping battery cam when the operator forces it', async () => {
    // `force` is the operator saying "fresh frame, I accept the wake" —
    // the cap input documents exactly that.
    const battery = makeBatteryProviderWithState()
    const snapshotNative = makeSnapshotNativeWithCounter()
    const ctx = makeCtxRoutingCaps({
      battery: battery.provider,
      batteryStateHandle: battery.stateHandle,
      snapshot: snapshotNative.provider,
      isBattery: true,
    })
    const provider = await initAddon(addon, ctx)
    battery.setSleeping(true)

    const forced = await provider.getSnapshot({ deviceId: 42, force: true })
    expect(forced?.base64).toBe(snapshotNative.getLastBase64())
    expect(snapshotNative.getCallCount()).toBe(1)
  })

  it('serves the cache for the full 1 h default window on a battery cam', async () => {
    const battery = makeBatteryProviderWithState()
    const snapshotNative = makeSnapshotNativeWithCounter()
    const ctx = makeCtxRoutingCaps({
      battery: battery.provider,
      batteryStateHandle: battery.stateHandle,
      snapshot: snapshotNative.provider,
      isBattery: true,
    })
    const provider = await initAddon(addon, ctx)

    // 1. Cold cache → native hit, cache warmed.
    const initial = await provider.getSnapshot({ deviceId: 42 })
    expect(snapshotNative.getCallCount()).toBe(1)

    // 2. Put the cam to sleep and advance 30 min — well within the
    //    1 h battery default. Cache should be served, native untouched.
    battery.setSleeping(true)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 30 * 60 * 1000)
      const out = await provider.getSnapshot({ deviceId: 42 })
      expect(out?.base64).not.toBe(initial?.base64)
      expect(snapshotNative.getCallCount()).toBe(1)

      // 3. Advance past the 1 h window WHILE ASLEEP. The window expiring
      //    is NOT a reason to wake the camera: without `force` the stale
      //    frame keeps being served. (This reverses the earlier
      //    "sleep-state independent" policy — expiry used to trigger a
      //    capture, which in production woke the camera every time the
      //    operator opened the device page with a cold or aged cache.)
      vi.setSystemTime(Date.now() + 35 * 60 * 1000 + 1000)
      const stale = await provider.getSnapshot({ deviceId: 42 })
      expect(stale?.base64).toBe(out?.base64)
      expect(snapshotNative.getCallCount()).toBe(1)

      // 4. Awake again → the max-age window governs as before.
      battery.setSleeping(false)
      await provider.getSnapshot({ deviceId: 42 })
      expect(snapshotNative.getCallCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('within the window the cache is served regardless of sleep state', async () => {
    const battery = makeBatteryProviderWithState()
    const snapshotNative = makeSnapshotNativeWithCounter()
    const ctx = makeCtxRoutingCaps({
      battery: battery.provider,
      batteryStateHandle: battery.stateHandle,
      snapshot: snapshotNative.provider,
      isBattery: true,
    })
    const provider = await initAddon(addon, ctx)

    await provider.getSnapshot({ deviceId: 42 })
    battery.setSleeping(true)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 10_000)
      await provider.getSnapshot({ deviceId: 42 }) // cache served
      expect(snapshotNative.getCallCount()).toBe(1)

      // Camera waking up does NOT invalidate the cache — WITHIN the
      // window the per-device max-age governs regardless of sleep
      // state. (Sleep state only decides whether an EXPIRED window may
      // trigger a capture: asleep + no force never captures.)
      battery.setSleeping(false)
      vi.setSystemTime(Date.now() + 10_000)
      await provider.getSnapshot({ deviceId: 42 })
      expect(snapshotNative.getCallCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a no-op when the device has no battery cap registered (backwards compat)', async () => {
    const snapshotNative = makeSnapshotNativeWithCounter()
    // No battery provider — getNativeProvider(battery, id) returns null.
    const ctx = makeCtxRoutingCaps({ snapshot: snapshotNative.provider })
    const provider = await initAddon(addon, ctx)

    await provider.getSnapshot({ deviceId: 42 })

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 16_000)
      await provider.getSnapshot({ deviceId: 42 })
      // Non-battery devices: normal cache expiry (15 s default) → native refetch.
      expect(snapshotNative.getCallCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
