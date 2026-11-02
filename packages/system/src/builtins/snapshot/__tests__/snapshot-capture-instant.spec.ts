import { describe, it, expect, vi } from 'vitest'
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

describe('SnapshotAddon — the capture instant (planning#384)', () => {
  it('stamps lastCapturedAt when the frame LANDED, not when the capture was queued', async () => {
    const SLOW_MS = 120
    const jpeg = await sharp({
      create: { width: 32, height: 18, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer()
    const slowNative: ISnapshotNativeProvider = {
      getSnapshot: async () => {
        await new Promise((r) => setTimeout(r, SLOW_MS))
        return { base64: jpeg.toString('base64'), contentType: 'image/jpeg' }
      },
      invalidateCache: async () => {},
    }
    const ctx = makeCtxRoutingCaps({ snapshot: slowNative })
    const provider = await initAddon(new SnapshotAddon(), ctx)

    const startedAt = Date.now()
    await provider.getSnapshot({ deviceId: 584 })
    const landedAt = Date.now()

    const [row] = await provider.getSnapshotOverview({ deviceIds: [584] })
    // A frame that took SLOW_MS to arrive is not from before it was asked
    // for: the stamp is the landing, so a freshness judge comparing it with
    // an event time does not reject a picture that is in fact current.
    expect(row?.lastCapturedAt).not.toBeNull()
    expect(row?.lastCapturedAt ?? 0).toBeGreaterThanOrEqual(startedAt + SLOW_MS - 10)
    expect(row?.lastCapturedAt ?? Infinity).toBeLessThanOrEqual(landedAt)
  })

  it('getDebugState answers for a wired camera with no battery slice', async () => {
    const ctx = makeCtxRoutingCaps({})
    const provider = await initAddon(new SnapshotAddon(), ctx)
    const debug = await provider.getDebugState({ deviceId: 584 })
    expect(debug.battery).toBeNull()
    expect(debug.state.reason).toBeNull()
  })
})
