import { describe, it, expect, vi, beforeEach } from 'vitest'
import sharp from 'sharp'
import {
  snapshotCapability,
  nodePin,
  type AddonApi,
  type AddonContext,
  type BatteryStatus,
  type CapabilityDefinition,
  type IngestOwner,
  type IScopedLogger,
  type InferNativeProvider,
  type InferProvider,
  type ProfileSlot,
  type RtspRestreamEntry,
} from '@camstack/types'
import { SnapshotAddon, fetchSnapshotBrokerEntries } from '../snapshot.addon.js'
import { freshSnapshotDataDir } from './scratch-data-dir.js'

type ISnapshotProvider = InferProvider<typeof snapshotCapability>
// Native providers registered per-device via `ctx.registerNativeCap` only
// serve the cap's device-scoped runtime methods — the three
// DeviceSettingsContribution methods (added by `exposesDeviceSettings:true`
// on the cap) are implemented by the SYSTEM-level provider (SnapshotAddon),
// not by the per-device native hook. The test mocks below therefore use
// `InferNativeProvider` to match the registerNativeCap contract.
type ISnapshotNativeProvider = InferNativeProvider<typeof snapshotCapability>

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

interface SnapshotImage {
  base64: string
  contentType: string
}

interface NativeMock {
  readonly getSnapshot: ReturnType<typeof vi.fn>
  readonly invalidateCache: ReturnType<typeof vi.fn>
}

function makeNativeMock(
  returnValue: SnapshotImage | null = { base64: 'aGVsbG8=', contentType: 'image/jpeg' },
): NativeMock {
  return {
    getSnapshot: vi.fn(async () => returnValue),
    invalidateCache: vi.fn(async () => undefined),
  }
}

async function makeJpegImage(background = '#d03030'): Promise<SnapshotImage> {
  const bytes = await sharp({
    create: { width: 320, height: 180, channels: 3, background },
  })
    .jpeg()
    .toBuffer()
  return { base64: bytes.toString('base64'), contentType: 'image/jpeg' }
}

interface CtxStubOptions {
  readonly nativeFactory?: (deviceId: number) => ISnapshotNativeProvider
  /**
   * Initial battery slice exposed through the canonical
   * `deviceState.getCapSlice` runtime mirror.
   */
  readonly batterySlice?: BatteryStatus | null
  /**
   * Mark the test device as battery-operated for the purpose of
   * `api.deviceManager.getDevice`. The snapshot addon picks the
   * per-device max-age default off this flag (1 h for battery cams,
   * 15 s otherwise).
   */
  readonly isBattery?: boolean
  /** Operator soft-disable. Drives the "Disabled" courtesy frame. */
  readonly disabled?: boolean
  /** Hub's reachability verdict. Drives the "Offline" courtesy frame. */
  readonly online?: boolean
  /**
   * `pipelineOrchestrator.getIngestOwner` response. Defaults to the
   * rollout-safe `{ ownerNodeId: 'hub' }` fallback used when the cap
   * hasn't been asked to return anything else.
   */
  readonly ingestOwner?: IngestOwner
  /** Mock for `api.streamBroker.getAllRtspEntries.query`. Defaults to an empty list. */
  readonly getAllRtspEntries?: ReturnType<typeof vi.fn>
  /** Mock for `api.streamBroker.listAllProfileSlots.query`. Defaults to an empty list. */
  readonly listAllProfileSlots?: ReturnType<typeof vi.fn>
}

function makeCtx(opts: CtxStubOptions = {}): {
  ctx: AddonContext
  getNativeProvider: ReturnType<typeof vi.fn>
  logger: IScopedLogger
} {
  const logger = makeLogger()
  const getNativeProvider = vi.fn((cap: CapabilityDefinition, deviceId: number) => {
    if (cap.name === 'snapshot') {
      if (!opts.nativeFactory) throw new Error(`no native registered for ${deviceId}`)
      return opts.nativeFactory(deviceId)
    }
    return null
  })
  const initialSlice = opts.batterySlice === undefined ? null : opts.batterySlice
  const addonStore: Record<string, unknown> = {}
  const ctx = {
    id: 'snapshot',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: freshSnapshotDataDir(),
    kernel: { localNodeId: 'hub', devices: {} as never },
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
    api: {
      deviceManager: {
        getDevice: {
          query: vi.fn(async ({ deviceId }: { deviceId: number }) => ({
            id: deviceId,
            name: 'test-cam',
            features: opts.isBattery ? ['battery-operated'] : [],
            disabled: opts.disabled ?? false,
            online: opts.online ?? true,
          })),
        },
      },
      deviceState: {
        getCapSlice: {
          query: vi.fn(async () => initialSlice),
        },
      },
      // Rollout-safe default (`{ ownerNodeId: 'hub' }`) matches the
      // fallback `resolveIngestOwner`/`fetchIngestOwner` use when the cap
      // throws — every existing test that never reaches the broker
      // fallback stays byte-identical without opting in to `ingestOwner`.
      pipelineOrchestrator: {
        getIngestOwner: {
          query: vi.fn(async () => opts.ingestOwner ?? { ownerNodeId: 'hub' }),
        },
      },
      streamBroker: {
        getAllRtspEntries: { query: opts.getAllRtspEntries ?? vi.fn(async () => []) },
        listAllProfileSlots: { query: opts.listAllProfileSlots ?? vi.fn(async () => []) },
      },
    } as never,
    getNativeProvider,
  } as unknown as AddonContext
  return { ctx, getNativeProvider, logger }
}

async function initAddon(addon: SnapshotAddon, ctx: AddonContext) {
  const result = await addon.initialize(ctx)
  if (Array.isArray(result)) return result
  return result?.providers ?? []
}

function getProvider(addon: SnapshotAddon, registrations: unknown): ISnapshotProvider {
  void addon
  const list = registrations as ReadonlyArray<{ readonly provider: ISnapshotProvider }>
  if (list.length !== 1) throw new Error(`expected 1 registration, got ${list.length}`)
  const first = list[0]
  if (!first) throw new Error('registration[0] is undefined')
  return first.provider
}

describe('SnapshotAddon (wrapper)', () => {
  let addon: SnapshotAddon
  beforeEach(() => {
    addon = new SnapshotAddon()
  })

  it('registers a provider for snapshotCapability — wrapper intent is declared on the cap definition', async () => {
    const { ctx } = makeCtx({ nativeFactory: () => makeNativeMock() })
    const result = await initAddon(addon, ctx)
    const list = result as ReadonlyArray<{
      readonly capability: {
        readonly name: string
        readonly kind?: string
        readonly defaultActive?: boolean
      }
      readonly kind?: string
      readonly defaultActive?: boolean
    }>
    expect(list).toHaveLength(1)
    const first = list[0]
    if (!first) throw new Error('registration[0] is undefined')
    expect(first.capability.name).toBe('snapshot')
    // Since D4, kind/defaultActive are declared on the CapabilityDefinition, not on the registration object.
    expect(first.kind).toBeUndefined()
    expect(first.defaultActive).toBeUndefined()
    // Wrapper intent lives on the cap def itself.
    expect(first.capability.kind).toBe('wrapper')
    expect(first.capability.defaultActive).toBe(true)
  })

  it('on cache miss, calls ctx.getNativeProvider(snapshot, deviceId) and returns its result', async () => {
    const native = makeNativeMock({ base64: 'AAA', contentType: 'image/jpeg' })
    const { ctx, getNativeProvider } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))
    const out = await provider.getSnapshot({ deviceId: 1 })
    expect(out).toEqual({ base64: 'AAA', contentType: 'image/jpeg' })
    expect(getNativeProvider).toHaveBeenCalledWith(snapshotCapability, 1)
    expect(native.getSnapshot).toHaveBeenCalledWith({ deviceId: 1 })
  })

  it('serves fresh cache on subsequent call within freshTtlMs (no native call)', async () => {
    const native = makeNativeMock({ base64: 'BBB', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))
    await provider.getSnapshot({ deviceId: 1 })
    const second = await provider.getSnapshot({ deviceId: 1 })
    expect(second).toEqual({ base64: 'BBB', contentType: 'image/jpeg' })
    expect(native.getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('returns null without caching when native returns null', async () => {
    const native = makeNativeMock(null)
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const out = await provider.getSnapshot({ deviceId: 1 })
      expect(out).toBeNull()
      // Once the camera's rest window has passed, the next call hits native
      // again — null was not cached (the rest itself is pinned below).
      vi.setSystemTime(1_000_000 + 11_000)
      await provider.getSnapshot({ deviceId: 1 })
      expect(native.getSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to stale cache (logged) when native throws and stale entry exists within staleTtlMs', async () => {
    let calls = 0
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        calls += 1
        if (calls === 1) return { base64: 'STALE', contentType: 'image/jpeg' }
        throw new Error('boom')
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx, logger } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    // Prime cache.
    const first = await provider.getSnapshot({ deviceId: 1 })
    expect(first).toEqual({ base64: 'STALE', contentType: 'image/jpeg' })

    // Force expiry of fresh window so the addon hits the native again.
    // freshTtlMs default = 5000; advance virtual time using fake timers.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 20_000) // > 15 s non-battery default, < staleTtlMs (60_000)
      const second = await provider.getSnapshot({ deviceId: 1 })
      expect(second).toEqual({ base64: 'STALE', contentType: 'image/jpeg' })
      // 1 warn: native throw. Broker fallback returns silently because
      // the test ctx exposes no `cameraStreams` cap on the DeviceProxy
      // (no RTSP entries to grab from) — that's a valid "no streams"
      // case, not an error.
      expect(logger.warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a camera that could not answer REST: the next miss within the window never dials it', async () => {
    // Retro casa, 2026-09-05: 68 native 503s in an hour, one ISAPI request per
    // poll, on a camera already too weak to keep its streams. A null from the
    // provider (the Hikvision class catches and returns null) and a throw are
    // the same fact here — the camera did not answer.
    let calls = 0
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        calls += 1
        return null
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx, logger } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      await provider.getSnapshot({ deviceId: 1 })
      expect(calls).toBe(1)
      // Two seconds later, still no frame: the camera is resting, not dialled.
      vi.setSystemTime(1_002_000)
      await provider.getSnapshot({ deviceId: 1 })
      expect(calls).toBe(1)
      expect(logger.info).toHaveBeenCalledWith(
        'native snapshot: camera resting after a miss — not dialled',
        expect.objectContaining({ tags: expect.objectContaining({ deviceId: 1 }) }),
      )
      // After the base window it is asked again; a second miss doubles the rest.
      vi.setSystemTime(1_011_000)
      await provider.getSnapshot({ deviceId: 1 })
      expect(calls).toBe(2)
      vi.setSystemTime(1_025_000)
      await provider.getSnapshot({ deviceId: 1 })
      expect(calls).toBe(2)
      // An operator's `force` is a deliberate wake and is never held back.
      await provider.getSnapshot({ deviceId: 1, force: true })
      expect(calls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rethrows when native throws and no stale entry is available', async () => {
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        throw new Error('upstream-down')
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx, logger } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))
    await expect(provider.getSnapshot({ deviceId: 1 })).rejects.toThrow('upstream-down')
    // 1 warn: native throw. Broker fallback no-ops (no `cameraStreams`
    // cap mocked on the test DeviceProxy) — see preceding test for the
    // rationale.
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  // ── Per-device max-age cache (battery-aware default) ─────────────────
  //
  // The snapshot wrapper applies a per-device cache window driven by
  // `DeviceFeature.BatteryOperated` from the device-manager: 1 h
  // default for battery cams (avoids gratuitous wake-ups that drain
  // charge — the battery cap warns explicitly against that), 15 s for
  // everything else (the Viewer's currency contract). Operators can override
  // per-device via
  // `snapshotMaxAgeS` and the UI refresh button bypasses the gate via
  // `force: true` (see the dedicated tests below).

  function batterySlice(sleeping: boolean): BatteryStatus {
    return {
      level: 80,
      charging: 'none',
      sleeping,
      lastUpdated: Date.now(),
    }
  }

  it('labels a cached sleeping frame within the 1 h window without capturing again', async () => {
    const cachedFrame = await makeJpegImage()
    const native = makeNativeMock(cachedFrame)
    const { ctx } = makeCtx({
      nativeFactory: () => native,
      batterySlice: batterySlice(true),
      isBattery: true,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    // Prime the cache with an EXPLICIT capture: on a sleeping battery cam
    // that is the only thing that fills it (the provider's wake warm-up
    // and the operator's refresh button both pass `force`).
    await provider.getSnapshot({ deviceId: 1, force: true })
    expect(native.getSnapshot).toHaveBeenCalledTimes(1)

    // Advance within the 1 h battery default — the point is the STATE
    // override (sleeping), not the freshness window.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 10_000)
      const second = await provider.getSnapshot({ deviceId: 1 })
      expect(second?.contentType).toBe('image/jpeg')
      expect(second?.base64).not.toBe(cachedFrame.base64)
      expect(Buffer.from(second?.base64 ?? '', 'base64').subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xd8]),
      )
      // State overrode the fresh-cache fast path, but no capture/wake occurred.
      expect(native.getSnapshot).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('probes the native when a non-battery cam exceeds the 15 s default window', async () => {
    const native = makeNativeMock({ base64: 'FRESH', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({
      nativeFactory: () => native,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await provider.getSnapshot({ deviceId: 1 })
    expect(native.getSnapshot).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 16_000)
      await provider.getSnapshot({ deviceId: 1 })
      // Non-battery default (15 s — the Viewer's currency contract) elapsed →
      // native re-fetched.
      expect(native.getSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('probes the native when an AWAKE battery cam cache exceeds the 1 h window', async () => {
    const native = makeNativeMock({ base64: 'WAKE', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({
      nativeFactory: () => native,
      batterySlice: batterySlice(false),
      isBattery: true,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await provider.getSnapshot({ deviceId: 1 })
    expect(native.getSnapshot).toHaveBeenCalledTimes(1)

    // Advance past the 1 h battery default.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 3_601_000)
      await provider.getSnapshot({ deviceId: 1 })
      // Awake: the max-age window governs exactly as before.
      expect(native.getSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT probe a SLEEPING battery cam past the window — expiry is no reason to wake', async () => {
    // Reversal of the previous policy (window expiry authorised a
    // capture regardless of sleep state). Capturing dials the native,
    // and on a UDP/battery camera that login is the wake — which is how
    // simply opening the device page woke a camera that had been asleep
    // for hours.
    const cachedFrame = await makeJpegImage()
    const native = makeNativeMock(cachedFrame)
    const { ctx } = makeCtx({
      nativeFactory: () => native,
      batterySlice: batterySlice(true),
      isBattery: true,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    // Explicit capture to seed the cache (see above).
    await provider.getSnapshot({ deviceId: 1, force: true })
    expect(native.getSnapshot).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 3_601_000)
      const served = await provider.getSnapshot({ deviceId: 1 })
      expect(served?.base64).not.toBe(cachedFrame.base64)
      expect(served?.contentType).toBe('image/jpeg')
      expect(native.getSnapshot).toHaveBeenCalledTimes(1)

      // The operator asking explicitly still captures.
      await provider.getSnapshot({ deviceId: 1, force: true })
      expect(native.getSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('probes the native normally when registry and runtime state show no battery', async () => {
    const native = makeNativeMock({ base64: 'NOBAT', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await provider.getSnapshot({ deviceId: 1 })

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 20_000)
      await provider.getSnapshot({ deviceId: 1 })
      expect(native.getSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the canonical device-state mirror before deciding a battery camera is awake', async () => {
    const native = makeNativeMock({ base64: 'NOPE', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({
      nativeFactory: () => native,
      batterySlice: batterySlice(true),
      isBattery: true,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    const out = await provider.getSnapshot({ deviceId: 1 })
    // The assertion that matters: the native was NOT dialed, so the camera was
    // not woken. The answer itself became a "Sleeping" courtesy frame on
    // 2026-08-11 (it was `null`, which the client rendered as "Unavailable"),
    // but nothing about the gate changed.
    expect(native.getSnapshot).not.toHaveBeenCalled()
    expect(out?.contentType).toBe('image/jpeg')
    expect(Buffer.from(out?.base64 ?? '', 'base64').subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    )
  })

  it('treats a valid sleeping battery slice as affirmative evidence when registry features lag', async () => {
    // Field regression: device 106 "Baby monitor" had a durable sleeping
    // battery slice while getDevice.features temporarily omitted
    // battery-operated. A Viewer snapshot was therefore classified as mains
    // and the native Baichuan login woke it.
    const native = makeNativeMock({ base64: 'MUST-NOT-DIAL', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({
      nativeFactory: () => native,
      batterySlice: batterySlice(true),
      isBattery: false,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    const out = await provider.getSnapshot({ deviceId: 1 })

    expect(native.getSnapshot).not.toHaveBeenCalled()
    expect(out?.contentType).toBe('image/jpeg')
  })

  /**
   * The live case: camera 105 was soft-disabled, so the wrapper had nothing to
   * say and the media route answered 404 — which the client renders as a bare
   * "Unavailable", the same thing it shows for a camera that is genuinely
   * broken. [D62] is explicit that an off switch must be REPORTED off.
   */
  it('answers a DISABLED camera with a courtesy frame, and never dials it', async () => {
    const native = makeNativeMock({ base64: 'SHOULD-NOT-BE-CALLED', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({ nativeFactory: () => native, disabled: true })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    const out = await provider.getSnapshot({ deviceId: 1 })

    expect(native.getSnapshot).not.toHaveBeenCalled()
    expect(out?.contentType).toBe('image/jpeg')
    const bytes = Buffer.from(out?.base64 ?? '', 'base64')
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    // Not the native's frame — a rendered one.
    expect(out?.base64).not.toBe('SHOULD-NOT-BE-CALLED')
  })

  it('never dials a DISABLED camera, even when the courtesy render fails', async () => {
    // The first draft returned the courtesy frame but FELL THROUGH on a render
    // failure, into the full capture ladder. One fontconfig problem on a host
    // and the off switch silently stopped being an off switch — dialing, on
    // every poll, a camera the operator had switched off. A null here is the
    // old 404, which is the correct degradation.
    const native = makeNativeMock({ base64: 'SHOULD-NOT-BE-CALLED', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({ nativeFactory: () => native, disabled: true })
    const addon = new SnapshotAddon(async () => {
      throw new Error('resize unavailable')
    })
    // Break the renderer the same way a font-less host would.
    const broken = addon as unknown as { courtesyImage: () => Promise<null> }
    broken.courtesyImage = async () => null
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await expect(provider.getSnapshot({ deviceId: 1 })).resolves.toBeNull()
    expect(native.getSnapshot).not.toHaveBeenCalled()
  })

  /**
   * An offline camera fails FAST — a vendor snapshot URL refuses the connection
   * in well under a second — so the settled branch, not the wait-bound timeout,
   * is where "offline" almost always lands. The first draft only answered on
   * the slow path, which left the common case as a bare 404.
   */
  it('answers a fast-failing OFFLINE camera with a courtesy frame, having still tried', async () => {
    const native = {
      getSnapshot: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED')
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx } = makeCtx({ nativeFactory: () => native, online: false })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    const out = await provider.getSnapshot({ deviceId: 1 })

    // A FALLBACK, not a gate: the ladder still ran. Refusing to dial a camera
    // the registry calls offline would make a wrong flag self-sealing.
    expect(native.getSnapshot).toHaveBeenCalled()
    expect(out?.contentType).toBe('image/jpeg')
    expect(Buffer.from(out?.base64 ?? '', 'base64').subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    )
  })

  it('still surfaces the error for a camera the hub believes is ONLINE', async () => {
    // Discriminating pair for the test above: the courtesy frame must not
    // swallow a genuine fault on a camera that is supposed to be reachable.
    const native = {
      getSnapshot: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED')
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx } = makeCtx({ nativeFactory: () => native, online: true })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await expect(provider.getSnapshot({ deviceId: 1 })).rejects.toThrow(/ECONNREFUSED/)
  })

  it('probes the native normally when the battery runtime-state lookup fails', async () => {
    const native = makeNativeMock({ base64: 'THROW', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const api = ctx.api as unknown as {
      deviceState: { getCapSlice: { query: ReturnType<typeof vi.fn> } }
    }
    api.deviceState.getCapSlice.query = vi.fn(async () => {
      throw new Error('runtime mirror unavailable')
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await provider.getSnapshot({ deviceId: 1 })

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 20_000)
      await provider.getSnapshot({ deviceId: 1 })
      expect(native.getSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidateCache drops the cached entry for the device', async () => {
    const native = makeNativeMock({ base64: 'X', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))
    await provider.getSnapshot({ deviceId: 1 })
    await provider.invalidateCache({ deviceId: 1 })
    await provider.getSnapshot({ deviceId: 1 })
    expect(native.getSnapshot).toHaveBeenCalledTimes(2)
  })

  // ── Owner-pin + reachable-host wiring (ingest-owner relocation) ────────
  //
  // The broker fallback used to call the device-scoped `dev.cameraStreams`
  // facade with no node pin — wrong once `ingestNode != hub` (double-pulls
  // the camera, or dials a hub-local restream nobody is serving). It now
  // resolves the cluster's ingest owner via `pipelineOrchestrator
  // .getIngestOwner` and pins every `streamBroker` call to it, rewriting
  // the returned URL host via the cap's own `hostname` input when a
  // `reachableHost` is registered. These tests exercise the wiring
  // end-to-end through `getSnapshot` (broker fallback path) with EMPTY
  // broker responses so no real ffmpeg process is spawned — see
  // `fetchSnapshotBrokerEntries` below for the entry-selection contract
  // itself (pure function, no addon instantiation).

  it('broker fallback pins the stream-broker fetch to a non-hub ingest owner + reachable host', async () => {
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        throw new Error('upstream-down')
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const getAllRtspEntries = vi.fn(async () => [])
    const listAllProfileSlots = vi.fn(async () => [])
    const { ctx } = makeCtx({
      nativeFactory: () => native,
      ingestOwner: { ownerNodeId: 'owner-x', reachableHost: '10.0.0.9' },
      getAllRtspEntries,
      listAllProfileSlots,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await expect(provider.getSnapshot({ deviceId: 1 })).rejects.toThrow('upstream-down')

    expect(getAllRtspEntries).toHaveBeenCalledWith({ hostname: '10.0.0.9' }, nodePin('owner-x'))
    expect(listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('owner-x'))
  })

  it('broker fallback pins to nodePin(hub) with no hostname override (rollout-safe default)', async () => {
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        throw new Error('upstream-down')
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const getAllRtspEntries = vi.fn(async () => [])
    const listAllProfileSlots = vi.fn(async () => [])
    // No `ingestOwner` override — makeCtx defaults `getIngestOwner` to
    // `{ ownerNodeId: 'hub' }`, matching the graceful-fallback behaviour
    // when the cap isn't mounted yet.
    const { ctx } = makeCtx({
      nativeFactory: () => native,
      getAllRtspEntries,
      listAllProfileSlots,
    })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    await expect(provider.getSnapshot({ deviceId: 1 })).rejects.toThrow('upstream-down')

    // No `hostname` key at all — byte-identical to the pre-relocation call.
    expect(getAllRtspEntries).toHaveBeenCalledWith({}, nodePin('hub'))
    expect(listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('hub'))
  })
})

describe('fetchSnapshotBrokerEntries (pinned entry-resolution + host-rewrite)', () => {
  function makeFakeApi(
    entries: readonly RtspRestreamEntry[],
    slots: readonly ProfileSlot[],
  ): {
    api: AddonApi
    getAllRtspEntries: ReturnType<typeof vi.fn>
    listAllProfileSlots: ReturnType<typeof vi.fn>
  } {
    const getAllRtspEntries = vi.fn(async () => entries)
    const listAllProfileSlots = vi.fn(async () => slots)
    const api = {
      streamBroker: {
        getAllRtspEntries: { query: getAllRtspEntries },
        listAllProfileSlots: { query: listAllProfileSlots },
      },
    } as unknown as AddonApi
    return { api, getAllRtspEntries, listAllProfileSlots }
  }

  it('pins the broker call to the owner node and passes reachableHost as the hostname input', async () => {
    const entries: readonly RtspRestreamEntry[] = [
      {
        brokerId: '7/high',
        url: 'rtsp://10.0.0.9:8554/tok-abc',
        mutedUrl: 'rtsp://10.0.0.9:8554/tok-abc?mute=1',
        enabled: true,
      },
      // Different device — must be filtered out by the `${deviceId}/` prefix.
      { brokerId: '70/high', url: 'rtsp://10.0.0.9:8554/tok-xyz', mutedUrl: '', enabled: true },
    ]
    const slots: readonly ProfileSlot[] = [
      {
        deviceId: 7,
        profile: 'high',
        brokerId: '7/high',
        sourceCamStreamId: 'main',
        status: 'streaming',
      },
      {
        deviceId: 70,
        profile: 'high',
        brokerId: '70/high',
        sourceCamStreamId: 'main',
        status: 'idle',
      },
    ]
    const { api, getAllRtspEntries, listAllProfileSlots } = makeFakeApi(entries, slots)

    const result = await fetchSnapshotBrokerEntries(api, {
      deviceId: 7,
      ownerNodeId: 'owner-x',
      reachableHost: '10.0.0.9',
    })

    expect(getAllRtspEntries).toHaveBeenCalledWith({ hostname: '10.0.0.9' }, nodePin('owner-x'))
    expect(listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('owner-x'))
    // Device-7-only, and the URL host is the broker's own rewrite
    // (server-side `hostname` substitution) — passed through unchanged.
    expect(result.entries).toEqual([entries[0]])
    expect(result.entries[0]?.url).toBe('rtsp://10.0.0.9:8554/tok-abc')
    expect(result.slots).toEqual([slots[0]])
  })

  it('owner=hub + no reachableHost: pins nodePin(hub), omits hostname, and leaves the URL host unchanged', async () => {
    const entries: readonly RtspRestreamEntry[] = [
      {
        brokerId: '7/high',
        url: 'rtsp://127.0.0.1:8554/tok-abc',
        mutedUrl: 'rtsp://127.0.0.1:8554/tok-abc?mute=1',
        enabled: true,
      },
    ]
    const slots: readonly ProfileSlot[] = [
      {
        deviceId: 7,
        profile: 'high',
        brokerId: '7/high',
        sourceCamStreamId: 'main',
        status: 'streaming',
      },
    ]
    const { api, getAllRtspEntries, listAllProfileSlots } = makeFakeApi(entries, slots)

    const result = await fetchSnapshotBrokerEntries(api, {
      deviceId: 7,
      ownerNodeId: 'hub',
    })

    expect(getAllRtspEntries).toHaveBeenCalledWith({}, nodePin('hub'))
    expect(listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('hub'))
    expect(result.entries[0]?.url).toBe('rtsp://127.0.0.1:8554/tok-abc')
  })
})

// -- Coalescing / stale-while-revalidate / force (Slice 1) ---------------
//
// These exercise the wrapper end-to-end through `getSnapshot` to lock in the
// single-flight + hold-window semantics: concurrent callers share one capture,
// a force burst within the hold window can't stack dials, and force bypasses a
// fresh cache once the hold window has elapsed.

describe('SnapshotAddon coalescing / SWR / force', () => {
  let addon: SnapshotAddon
  beforeEach(() => {
    addon = new SnapshotAddon()
  })

  it('collapses concurrent getSnapshot calls into a single native capture', async () => {
    let calls = 0
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        calls += 1
        // Keep the flight in-flight so the sibling calls arrive while it runs.
        await new Promise((r) => setTimeout(r, 5))
        return { base64: `frame-${calls}`, contentType: 'image/jpeg' }
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    const [a, b, c] = await Promise.all([
      provider.getSnapshot({ deviceId: 1 }),
      provider.getSnapshot({ deviceId: 1 }),
      provider.getSnapshot({ deviceId: 1 }),
    ])

    expect(native.getSnapshot).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ base64: 'frame-1', contentType: 'image/jpeg' })
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('a force-refresh burst within the hold window collapses into one capture', async () => {
    let calls = 0
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 5))
        return { base64: `f${calls}`, contentType: 'image/jpeg' }
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    const results = await Promise.all([
      provider.getSnapshot({ deviceId: 1, force: true }),
      provider.getSnapshot({ deviceId: 1, force: true }),
      provider.getSnapshot({ deviceId: 1, force: true }),
    ])

    expect(native.getSnapshot).toHaveBeenCalledTimes(1)
    expect(results[0]).toEqual({ base64: 'f1', contentType: 'image/jpeg' })
  })

  it('force bypasses a fresh cache and re-captures once past the hold window', async () => {
    let calls = 0
    const native: NativeMock = {
      getSnapshot: vi.fn(async () => {
        calls += 1
        return { base64: `v${calls}`, contentType: 'image/jpeg' }
      }),
      invalidateCache: vi.fn(async () => undefined),
    }
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    const first = await provider.getSnapshot({ deviceId: 1 })
    expect(first).toEqual({ base64: 'v1', contentType: 'image/jpeg' })
    // A plain call within the fresh window serves cache — no new capture.
    await provider.getSnapshot({ deviceId: 1 })
    expect(native.getSnapshot).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      // Past COALESCE_MS (4s) so force starts a NEW flight instead of joining.
      vi.setSystemTime(Date.now() + 5_000)
      const forced = await provider.getSnapshot({ deviceId: 1, force: true })
      expect(native.getSnapshot).toHaveBeenCalledTimes(2)
      expect(forced).toEqual({ base64: 'v2', contentType: 'image/jpeg' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('getSnapshotOverview reports cache metadata without triggering a capture', async () => {
    const native = makeNativeMock({ base64: 'OVR', contentType: 'image/jpeg' })
    const { ctx } = makeCtx({ nativeFactory: () => native })
    const provider = getProvider(addon, await initAddon(addon, ctx))

    // Prime the cache for device 1 only.
    await provider.getSnapshot({ deviceId: 1 })
    const callsAfterPrime = native.getSnapshot.mock.calls.length

    const overview = await provider.getSnapshotOverview({ deviceIds: [1, 2] })
    // Overview never captures.
    expect(native.getSnapshot).toHaveBeenCalledTimes(callsAfterPrime)

    const one = overview.find((r) => r.deviceId === 1)
    const two = overview.find((r) => r.deviceId === 2)
    expect(one?.lastCapturedAt).toBeTypeOf('number')
    expect(one?.etag).toBe(`"1-${one?.lastCapturedAt}"`)
    expect(two).toEqual({ deviceId: 2, lastCapturedAt: null, cacheAgeMs: null, etag: null })
  })
})
