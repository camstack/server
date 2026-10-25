/**
 * Unit tests for the device-manager persisted bindings store (Task 3.1).
 *
 * These tests exercise DeviceManagerAddon#getBindings and
 * DeviceManagerAddon#setWrapperActive directly on the addon instance.
 *
 * The storage helpers (readAddonStore / writeAddonStore) are backed by a
 * plain in-memory object — no SQLite, no real filesystem.
 */

import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import {
  type AddonContext,
  DeviceType,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { clearDeviceRows, makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeEventBus(): IEventBus {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getRecent: vi.fn(() => []),
  } as unknown as IEventBus
}

type FakeSettings = ReturnType<typeof makeSettings>

function makeSettings() {
  const addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
  }
}

/**
 * Counts primary-key `get` vs. batched `query` calls the device-row store
 * issues against `ctx.api.settingsStore` — the door `getMany`/`listFleet`
 * reach through. `seedDeviceRow` writes via `store.backend` directly, so
 * seeding never inflates these counters.
 */
function countingReadsOf(store: FakeSettingsStore): {
  api: FakeSettingsStore['api']
  getCalls: () => number
  queryCalls: () => number
  countCalls: () => number
} {
  const rawApi = store.api
  let getCalls = 0
  let queryCalls = 0
  let countCalls = 0
  const api: FakeSettingsStore['api'] = {
    ...rawApi,
    get: {
      query: (input: Parameters<typeof rawApi.get.query>[0]) => {
        getCalls += 1
        return rawApi.get.query(input)
      },
    },
    query: {
      query: (input: Parameters<typeof rawApi.query.query>[0]) => {
        queryCalls += 1
        return rawApi.query.query(input)
      },
    },
    count: {
      query: (input: Parameters<typeof rawApi.count.query>[0]) => {
        countCalls += 1
        return rawApi.count.query(input)
      },
    },
  }
  return {
    api,
    getCalls: () => getCalls,
    queryCalls: () => queryCalls,
    countCalls: () => countCalls,
  }
}

async function setupAddon(): Promise<{
  addon: DeviceManagerAddon
  ctx: { kernel: Record<string, unknown> }
  store: FakeSettingsStore
  settings: FakeSettings
  reads: { getCalls: () => number; queryCalls: () => number; countCalls: () => number }
}> {
  const addon = new DeviceManagerAddon()
  const store = await makeSettingsStoreApi()
  const reads = countingReadsOf(store)
  const settings = makeSettings()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: reads.api },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: makeEventBus(),
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    kernel: { deviceRegistry: new DeviceRegistry() } as Record<string, unknown>,
  }
  await addon.initialize(ctx as unknown as AddonContext)
  return {
    addon,
    ctx,
    store,
    settings,
    reads: { getCalls: reads.getCalls, queryCalls: reads.queryCalls, countCalls: reads.countCalls },
  }
}

describe('device-manager bindings store', () => {
  let addon: DeviceManagerAddon
  let ctx: { kernel: Record<string, unknown> }
  let store: FakeSettingsStore
  let settings: FakeSettings
  let reads: { getCalls: () => number; queryCalls: () => number; countCalls: () => number }

  beforeEach(async () => {
    const result = await setupAddon()
    addon = result.addon
    ctx = result.ctx
    store = result.store
    settings = result.settings
    reads = result.reads
  })

  const CAM_01 = 1
  const CAM_02 = 2
  const CAM_XX = 99

  it('returns empty binding for an unknown device', async () => {
    expect(await addon.getBindings({ deviceId: CAM_XX })).toEqual({
      deviceId: CAM_XX,
      entries: [],
    })
  })

  it('getBindingsBatch answers a NAMED set with the same rows getBindings gives', async () => {
    // The gap this closes: between one device and `getAllBindings` (988 rows /
    // 679 KB on the live hub) there was nothing, so a caller needing 75 paid
    // 75 round-trips (1211 ms) or dragged the whole fleet across.
    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: true,
    })

    const batch = await addon.getBindingsBatch({ deviceIds: [CAM_01, CAM_02, CAM_01] })

    // Deduped, one row per distinct id, and every row byte-identical to the
    // single call — same resolver, so a divergence here means a second one
    // grew.
    expect(batch.map((r) => r.deviceId)).toEqual([CAM_01, CAM_02])
    expect(batch[0]).toEqual(await addon.getBindings({ deviceId: CAM_01 }))
    expect(batch[1]).toEqual(await addon.getBindings({ deviceId: CAM_02 }))
  })

  it('listDeviceIdsByCaps answers ONLY the ids bound to one of the caps (D636)', async () => {
    // The alarm's "every opening of the household" and the battery section's
    // picker used to read the ~433 KB fleet and then getBindingsBatch over
    // ~900 ids in five calls. The resolver is the same one getBindings uses;
    // only ids cross the wire.
    await seedDeviceRow(store, { deviceId: CAM_01, type: 'camera' })
    await seedDeviceRow(store, { deviceId: CAM_02, type: 'camera' })
    await addon.setWrapperActive({
      deviceId: CAM_02,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: true,
    })
    const bound = await addon.listDeviceIdsByCaps({ capNames: ['snapshot', 'contact'] })
    const expected = (await addon.getAllBindings())
      .filter((row) => row.entries.some((e) => e.capName === 'snapshot' || e.capName === 'contact'))
      .map((row) => row.deviceId)
    expect(bound).toEqual(expected)
    expect(bound).toContain(CAM_02)
    expect(await addon.listDeviceIdsByCaps({ capNames: ['a-cap-nobody-has'] })).toEqual([])
  })

  it('getBindingsBatch keeps a row for a device with nothing bound', async () => {
    // A caller that asked for three and got two cannot tell which one dropped.
    const batch = await addon.getBindingsBatch({ deviceIds: [CAM_XX] })
    expect(batch).toEqual([{ deviceId: CAM_XX, entries: [] }])
  })

  it('getBindingsBatch reads the device ledger in ONE batched query — never a get() per id', async () => {
    // Measured on the live hub 2026-08-25: `get device-manager:devices` at
    // 1 656 calls/min steady-state, one row per call — the exact shape of a
    // primary-key lookup repeated in a loop. `getBindings` (single) legitimately
    // does one `get()`; `getBindingsBatch` looping it N times was the loop.
    await seedDeviceRow(store, { deviceId: CAM_01, type: 'camera' })
    await seedDeviceRow(store, { deviceId: CAM_02, type: 'camera' })
    // Baseline AFTER setup/seeding — `onInitialize`'s own warm-boot reads are
    // not what this test is about.
    const getsBefore = reads.getCalls()
    const queriesBefore = reads.queryCalls()

    await addon.getBindingsBatch({ deviceIds: [CAM_01, CAM_02, CAM_XX] })

    expect(reads.getCalls() - getsBefore).toBe(0)
    expect(reads.queryCalls() - queriesBefore).toBe(1)
  })

  it('getAllBindings answers every device with the same rows getBindings gives', async () => {
    await seedDeviceRow(store, { deviceId: CAM_01, type: 'camera' })
    await seedDeviceRow(store, { deviceId: CAM_02, type: 'camera' })
    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: true,
    })

    const all = await addon.getAllBindings()

    expect(all.map((r) => r.deviceId)).toEqual([CAM_01, CAM_02])
    expect(all[0]).toEqual(await addon.getBindings({ deviceId: CAM_01 }))
    expect(all[1]).toEqual(await addon.getBindings({ deviceId: CAM_02 }))
  })

  it('getAllBindings reuses its ONE fleet listing — never a get() per device', async () => {
    // `getAllBindings` already pays for `deps.rows.listAll()` to build the id
    // set; looping `getBindings` (which does its OWN `rows.get(deviceId)`) on
    // top of that was a second, per-device read of a row already in hand.
    await seedDeviceRow(store, { deviceId: CAM_01, type: 'camera' })
    await seedDeviceRow(store, { deviceId: CAM_02, type: 'camera' })
    const getsBefore = reads.getCalls()
    const queriesBefore = reads.queryCalls()

    await addon.getAllBindings()

    expect(reads.getCalls() - getsBefore).toBe(0)
    expect(reads.queryCalls() - queriesBefore).toBe(1)
  })

  it('the fleet sweep loses no entry any per-device read would have returned', async () => {
    // The one thing a "make it faster" change must not do. Hoisting the
    // wrapper-activation read out of the per-device resolver is only safe if
    // the batched answer stays byte-identical to the per-device one on data
    // that exercises every branch it feeds: an operator ACTIVATION (step 1),
    // an operator DEACTIVATION that must keep the auto-bind suppressed (step
    // 1's `seenCaps` guard), a `defaultActive` auto-bind (step 2), a
    // deviceTypes mismatch that must still skip (step 2's gate), a hub-local
    // native (step 3), and a device with a row but no activations at all.
    const capRegistry = new CapabilityRegistry(makeLogger())
    capRegistry.registerWrapper('motion-detection', 'motion-wasm', { defaultActive: true })
    capRegistry.registerWrapper('snapshot', 'core/snapshot', { defaultActive: true })
    capRegistry.registerNativeProvider('snapshot', CAM_02, 'addon-provider-onvif', {})
    ctx.kernel.capabilityRegistry = capRegistry

    await seedDeviceRow(store, { deviceId: CAM_01, type: 'camera' })
    await seedDeviceRow(store, { deviceId: CAM_02, type: 'camera' })
    await seedDeviceRow(store, { deviceId: 3, type: 'event-emitter' })
    await seedDeviceRow(store, { deviceId: 4, type: 'camera' })
    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'ptz',
      wrapperAddonId: 'core/ptz',
      active: true,
    })
    await addon.setWrapperActive({
      deviceId: CAM_02,
      capName: 'motion-detection',
      wrapperAddonId: 'motion-wasm',
      active: false,
    })

    const all = await addon.getAllBindings()

    // Per-device reads taken AFTER the sweep, from the same store, so any
    // divergence is the sweep's and not the fixture's.
    const perDevice = await Promise.all(
      [CAM_01, CAM_02, 3, 4].map((deviceId) => addon.getBindings({ deviceId })),
    )
    expect(all).toEqual(perDevice)
    // And the sweep is not silently empty — the assertion above would pass on
    // two empty lists.
    expect(all.flatMap((row) => row.entries).length).toBeGreaterThan(0)
  })

  it('getAllBindings reads the persisted wrapper activations ONCE — not once per device', async () => {
    // The defect this pins. `resolveBindingsForDevice` read the wrapper-
    // activation blob (`ctx.settings.readAddonStore`) itself, so every caller
    // that looped it paid one settings-door ROUND TRIP per device. On hub-main
    // that view is `createDoorSettingsView` — an RPC to the isolated
    // sqlite-settings child, measured on the live hub 2026-08-30 at 2.9 s per
    // round trip while the storage drain was running. At 1 019 devices
    // `getAllBindings` therefore issued 1 020 round trips and never returned
    // inside SystemMirror.init's 15 s budget (nor inside 240 s).
    //
    // The blob is ONE fleet-wide value (775 bytes on that hub) — the same
    // bytes for every device in the sweep. Reading it once is not only
    // cheaper, it is the only way the sweep sees a single consistent version
    // of it.
    for (const deviceId of [CAM_01, CAM_02, 3, 4, 5]) {
      await seedDeviceRow(store, { deviceId, type: 'camera' })
    }
    settings.readAddonStore.mockClear()
    const doorBefore = reads.getCalls() + reads.queryCalls() + reads.countCalls()

    await addon.getAllBindings()

    expect(settings.readAddonStore).toHaveBeenCalledTimes(1)
    // And the whole sweep is TWO round trips, whatever a future edit adds to
    // the resolver: the fleet listing, plus the activations blob above. The
    // per-method assertion alone would not notice a third read arriving on a
    // method it does not name.
    expect(reads.getCalls() + reads.queryCalls() + reads.countCalls() - doorBefore).toBe(1)
  })

  it('getBindingsBatch reads the persisted wrapper activations ONCE — not once per id', async () => {
    // Same defect, same blob, on the call that exists precisely so a caller
    // needing many devices does not pay per device.
    for (const deviceId of [CAM_01, CAM_02, 3, 4, 5]) {
      await seedDeviceRow(store, { deviceId, type: 'camera' })
    }
    settings.readAddonStore.mockClear()

    await addon.getBindingsBatch({ deviceIds: [CAM_01, CAM_02, 3, 4, 5] })

    expect(settings.readAddonStore).toHaveBeenCalledTimes(1)
  })

  it('getBindingsBatch asks whether the ledger is empty ONCE, not once per unknown id', async () => {
    // `resolveDevicePresence` reaches `rows.count()` only when a device misses
    // BOTH the live registry and the ledger — and a sweep over an empty ledger
    // (device restore has not run yet) is exactly that, for every id. The
    // count answers a FLEET question, so it is the same read repeated too.
    await clearDeviceRows(store)
    const countsBefore = reads.countCalls()

    await addon.getBindingsBatch({ deviceIds: [11, 12, 13, 14] })

    expect(reads.countCalls() - countsBefore).toBe(1)
  })

  it('getBindings issues its two independent store reads CONCURRENTLY', async () => {
    // One device costs two settings-door round trips — the device ledger row
    // and the wrapper-activation blob — and they answer independent
    // questions. Awaited in series they add up: measured on the live hub
    // 2026-08-30, `getBindings({deviceId:101})` = 5.24 s against 2.87 s for a
    // single `settingsStore` read. Nothing orders them, so the latency of one
    // device should be one round trip, not two.
    //
    // Pinned as PEAK CONCURRENCY rather than wall-clock: a timing assertion
    // would flake in CI, and the shape is what the fix is.
    await seedDeviceRow(store, { deviceId: CAM_01, type: 'camera' })
    let inFlight = 0
    let peak = 0
    const track = async <T>(run: () => Promise<T>): Promise<T> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        // Two microtask turns: enough for a truly-parallel sibling to be
        // entered before this one settles, and not enough for a serial one.
        await Promise.resolve()
        await Promise.resolve()
        return await run()
      } finally {
        inFlight -= 1
      }
    }
    const rawGet = store.api.get.query.bind(store.api.get)
    store.api.get.query = (input: Parameters<typeof rawGet>[0]) => track(() => rawGet(input))
    const rawRead = settings.readAddonStore.getMockImplementation()
    if (rawRead === undefined) throw new Error('readAddonStore fake lost its implementation')
    settings.readAddonStore.mockImplementation(() => track(() => rawRead()))

    await addon.getBindings({ deviceId: CAM_01 })

    expect(peak).toBe(2)
  })

  it('persists wrapper activation and reads it back', async () => {
    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: true,
    })
    const binding = await addon.getBindings({ deviceId: CAM_01 })
    const entry = binding.entries.find((e) => e.capName === 'snapshot')
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('wrapped')
    expect(entry?.providerAddonId).toBe('core/snapshot')
  })

  it('setting active=false clears the wrapper for that (device, cap)', async () => {
    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: true,
    })
    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: false,
    })
    const binding = await addon.getBindings({ deviceId: CAM_01 })
    const entry = binding.entries.find((e) => e.capName === 'snapshot')
    // Either the entry is absent (no wrapper, no known native → no entry) OR kind='native' (if a native is inferable)
    expect(entry == null || entry.kind === 'native').toBe(true)
  })

  it('folds in native registrations even without wrapper configuration', async () => {
    const capRegistry = new CapabilityRegistry(makeLogger())
    capRegistry.registerNativeProvider('snapshot', CAM_01, 'addon-provider-onvif', {})
    ctx.kernel.capabilityRegistry = capRegistry

    const binding = await addon.getBindings({ deviceId: CAM_01 })
    const entry = binding.entries.find((e) => e.capName === 'snapshot')
    expect(entry).toMatchObject({
      kind: 'native',
      providerAddonId: 'addon-provider-onvif',
      nativeAddonId: 'addon-provider-onvif',
      providerNodeId: 'hub',
    })
  })

  it('resolves nativeAddonId on wrapped entries when registry knows the native', async () => {
    const capRegistry = new CapabilityRegistry(makeLogger())
    capRegistry.registerNativeProvider('snapshot', CAM_01, 'addon-provider-onvif', {})
    ctx.kernel.capabilityRegistry = capRegistry

    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: true,
    })

    const binding = await addon.getBindings({ deviceId: CAM_01 })
    const entry = binding.entries.find((e) => e.capName === 'snapshot')
    expect(entry).toMatchObject({
      kind: 'wrapped',
      providerAddonId: 'core/snapshot',
      nativeAddonId: 'addon-provider-onvif',
      providerNodeId: 'hub',
    })
  })

  it('auto-binds defaultActive wrappers on every device, even without a native', async () => {
    // Pure-wrapper caps (motion-detection, audio-analysis, detection-pipeline)
    // are themselves the implementation — no native exists for them. They must
    // still bind by default so the pipeline-orchestrator's
    // `isCapActiveForDevice` gate sees them as active.
    const capRegistry = new CapabilityRegistry(makeLogger())
    capRegistry.registerWrapper('motion-detection', 'motion-wasm', { defaultActive: true })
    ctx.kernel.capabilityRegistry = capRegistry

    const binding = await addon.getBindings({ deviceId: CAM_01 })
    const entry = binding.entries.find((e) => e.capName === 'motion-detection')
    expect(entry).toMatchObject({
      kind: 'wrapped',
      providerAddonId: 'motion-wasm',
      nativeAddonId: '',
      providerNodeId: 'hub',
    })
  })

  it('explicit wrapper deactivation suppresses defaultActive auto-bind', async () => {
    const capRegistry = new CapabilityRegistry(makeLogger())
    capRegistry.registerWrapper('motion-detection', 'motion-wasm', { defaultActive: true })
    ctx.kernel.capabilityRegistry = capRegistry

    await addon.setWrapperActive({
      deviceId: CAM_01,
      capName: 'motion-detection',
      wrapperAddonId: 'motion-wasm',
      active: false,
    })

    const binding = await addon.getBindings({ deviceId: CAM_01 })
    const entry = binding.entries.find((e) => e.capName === 'motion-detection')
    expect(entry).toBeUndefined()
  })

  // ── deviceTypes gate on the defaultActive auto-bind ──────────────────────
  //
  // Step 2 of `getBindings` binds every `defaultActive` wrapper. Without a
  // deviceTypes check it bound the whole camera battery (snapshot,
  // detection-pipeline, camera-streams, …) onto a Homematic button child —
  // `event-emitter` device 1446 answered with 13 entries, 9 of them nonsense.
  describe('defaultActive auto-bind respects the cap deviceTypes', () => {
    const EMITTER = 1446
    const CAMERA = 101

    /** Seed the persisted device rows `getBindings` resolves the type from. */
    async function seedDeviceMeta(entries: Record<number, string>): Promise<void> {
      for (const [id, type] of Object.entries(entries)) {
        await seedDeviceRow(store, { deviceId: Number(id), type })
      }
    }

    /** A registry with `snapshot` (camera-only) + `button` (button-only) +
     *  `untyped` (no `deviceTypes`) declared, each with a default wrapper. */
    function makeTypedRegistry(): CapabilityRegistry {
      const registry = new CapabilityRegistry(makeLogger())
      registry.declareCapability({
        name: 'snapshot',
        scope: 'device',
        mode: 'singleton',
        kind: 'wrapper',
        defaultActive: true,
        deviceTypes: [DeviceType.Camera],
        methods: {},
      })
      registry.declareCapability({
        name: 'button',
        scope: 'device',
        mode: 'singleton',
        kind: 'wrapper',
        defaultActive: true,
        deviceTypes: [DeviceType.Button],
        methods: {},
      })
      registry.declareCapability({
        name: 'untyped',
        scope: 'device',
        mode: 'singleton',
        kind: 'wrapper',
        defaultActive: true,
        methods: {},
      })
      registry.registerWrapper('snapshot', 'core/snapshot', { defaultActive: true })
      registry.registerWrapper('button', 'core/button', { defaultActive: true })
      registry.registerWrapper('untyped', 'core/untyped', { defaultActive: true })
      return registry
    }

    beforeEach(async () => {
      await seedDeviceMeta({ [EMITTER]: 'event-emitter', [CAMERA]: 'camera' })
      ctx.kernel.capabilityRegistry = makeTypedRegistry()
    })

    it('does NOT auto-bind a camera-typed wrapper onto an event-emitter', async () => {
      const { entries } = await addon.getBindings({ deviceId: EMITTER })
      expect(entries.map((e) => e.capName)).not.toContain('snapshot')
    })

    it('still auto-binds a camera-typed wrapper onto a camera', async () => {
      const { entries } = await addon.getBindings({ deviceId: CAMERA })
      expect(entries.find((e) => e.capName === 'snapshot')).toMatchObject({
        kind: 'wrapped',
        providerAddonId: 'core/snapshot',
      })
    })

    it('auto-binds a cap that declares NO deviceTypes on every device type', async () => {
      const emitter = await addon.getBindings({ deviceId: EMITTER })
      const camera = await addon.getBindings({ deviceId: CAMERA })
      expect(emitter.entries.map((e) => e.capName)).toContain('untyped')
      expect(camera.entries.map((e) => e.capName)).toContain('untyped')
    })

    it('auto-binds the wrapper whose deviceTypes DO match this device', async () => {
      await seedDeviceMeta({ [EMITTER]: 'button' })
      const { entries } = await addon.getBindings({ deviceId: EMITTER })
      expect(entries.map((e) => e.capName)).toContain('button')
      expect(entries.map((e) => e.capName)).not.toContain('snapshot')
    })

    it('an unknown device type never filters — a typeless row keeps every binding', async () => {
      // Destructive-read guard (D49): the device EXISTS, only its type failed
      // to resolve, and that must not cost it its bindings — this is the path
      // that protects a provider restart.
      // `type` is `NOT NULL` on the row, so "no type at all" is spelled as the
      // empty string — which `resolveDeviceType` reads as unresolved, exactly
      // like the missing key did on the blob.
      await seedDeviceRow(store, { deviceId: 777, type: '' })
      const { entries } = await addon.getBindings({ deviceId: 777 })
      expect(entries.map((e) => e.capName)).toEqual(
        expect.arrayContaining(['snapshot', 'button', 'untyped']),
      )
    })

    // ── B2: absent device → no speculative binds ──────────────────────────
    //
    // Deleting a camera dropped its meta row AND its persisted activations,
    // but `getBindings` then answered for the dead id by auto-binding every
    // `defaultActive` wrapper — so the deleted device came back with each
    // switch the operator had turned OFF silently back ON.
    describe('a device that is ABSENT gets no auto-bound wrappers', () => {
      const GONE = 3217

      it('returns no defaultActive wrapper entries', async () => {
        const { entries } = await addon.getBindings({ deviceId: GONE })
        expect(entries).toEqual([])
      })

      it('says so once, at debug, tagged with the deviceId', async () => {
        const logger = (addon as unknown as { ctx: AddonContext }).ctx.logger
        await addon.getBindings({ deviceId: GONE })
        const calls = (logger.debug as unknown as { mock: { calls: unknown[][] } }).mock.calls
        const hits = calls.filter(
          (c) => c[0] === 'bindings requested for absent device — returning none',
        )
        expect(hits).toHaveLength(1)
        expect(hits[0]?.[1]).toMatchObject({ tags: { deviceId: GONE } })
      })

      it('still reports what a driver actually registered for it', async () => {
        // Steps 3/4 are statements of fact, not speculation — a native that is
        // genuinely registered stays visible so the leak is diagnosable.
        const registry = ctx.kernel.capabilityRegistry as CapabilityRegistry
        registry.registerNativeProvider('snapshot', GONE, 'provider-test', {})
        const { entries } = await addon.getBindings({ deviceId: GONE })
        expect(entries).toEqual([expect.objectContaining({ capName: 'snapshot', kind: 'native' })])
      })

      it('a device the REGISTRY still knows is present even without a meta row', async () => {
        const registry = ctx.kernel.deviceRegistry as DeviceRegistry
        registry.register('provider-test', {
          id: GONE,
          stableId: 'stable-3217',
          name: 'still-here',
          type: DeviceType.Camera,
        } as never)
        const { entries } = await addon.getBindings({ deviceId: GONE })
        expect(entries.map((e) => e.capName)).toContain('snapshot')
      })

      it('an EMPTY device-meta store prunes nothing — that is not evidence of deletion', async () => {
        // D49 again: no rows at all means the store has not been restored, not
        // that the fleet was deleted. Fail open.
        await clearDeviceRows(store)
        const { entries } = await addon.getBindings({ deviceId: GONE })
        expect(entries.map((e) => e.capName)).toEqual(
          expect.arrayContaining(['snapshot', 'button', 'untyped']),
        )
      })
    })

    it('an operator activation on a "wrong" device type is still honoured', async () => {
      // Step 1 (persisted activations) is NEVER filtered: explicit is explicit.
      await addon.setWrapperActive({
        deviceId: EMITTER,
        capName: 'snapshot',
        wrapperAddonId: 'core/snapshot',
        active: true,
      })
      const { entries } = await addon.getBindings({ deviceId: EMITTER })
      expect(entries.find((e) => e.capName === 'snapshot')).toMatchObject({
        kind: 'wrapped',
        providerAddonId: 'core/snapshot',
      })
    })

    it('a native registration on a "wrong" device type is still reported', async () => {
      // Steps 3/4 report what a driver actually registered — the deviceTypes
      // gate gates only the SPECULATIVE default-wrapper bind.
      const registry = ctx.kernel.capabilityRegistry as CapabilityRegistry
      registry.registerNativeProvider('snapshot', EMITTER, 'provider-test', {})
      const { entries } = await addon.getBindings({ deviceId: EMITTER })
      expect(entries.find((e) => e.capName === 'snapshot')).toMatchObject({
        kind: 'native',
        providerAddonId: 'provider-test',
      })
    })
  })

  it('emits DeviceBindingsChanged when setWrapperActive is called', async () => {
    const events: SystemEvent[] = []
    const bus = (addon as unknown as { ctx: AddonContext }).ctx.eventBus
    ;(bus.emit as unknown as (e: SystemEvent) => void) = (e: SystemEvent) => {
      events.push(e)
    }

    await addon.setWrapperActive({
      deviceId: CAM_02,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: true,
    })
    await addon.setWrapperActive({
      deviceId: CAM_02,
      capName: 'snapshot',
      wrapperAddonId: 'core/snapshot',
      active: false,
    })

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      category: EventCategory.DeviceBindingsChanged,
      data: { deviceId: CAM_02, capName: 'snapshot', reason: 'wrapper-activated' },
    })
    expect(events[1]).toMatchObject({
      category: EventCategory.DeviceBindingsChanged,
      data: { deviceId: CAM_02, capName: 'snapshot', reason: 'wrapper-deactivated' },
    })
  })
})

/**
 * A COLLECTION capability's providers are a SET, and the set is DERIVED.
 *
 * Operator, 2026-09-20: *"tutti i providers funzionano sempre, non serve
 * disattivarli/attivarli … loro vivono lì."* [all the providers always work, there is no need to deactivate/activate them … they live there.] A source exists for a camera
 * because a configuration elsewhere put it there — CamStack always, Reolink
 * because it is that camera's provider, HKSV because the camera is exported —
 * and none of those is an operator visiting a tick box. So for a collection cap
 * `getBindings` answers the ADDONS that provide it, one entry each, and nothing
 * persists that answer.
 *
 * Deduping by ADDON is the whole of defect 2: the same addon reaches the
 * registry as the hub-local registration and again as
 * `pipeline-analytics@agent-a` — and on 592 that put `analytics` in the
 * picker three times. The node an addon runs on is not part of its identity.
 */
describe('a collection capability binds to a SET of addons, derived', () => {
  const CAM = 41
  const COLLECTION_CAP = 'videoclips'

  async function bindingsFor(
    addonIds: readonly string[],
    options: { readonly native?: string; readonly deviceTypes?: readonly DeviceType[] } = {},
  ) {
    const { addon, ctx, store: rowStore } = await setupAddon()
    await seedDeviceRow(rowStore, { deviceId: CAM, type: 'camera' })
    const registry = new CapabilityRegistry(makeLogger())
    registry.declareCapability({
      name: COLLECTION_CAP,
      kind: 'wrapper',
      mode: 'collection',
      scope: 'device',
      ...(options.deviceTypes === undefined ? {} : { deviceTypes: [...options.deviceTypes] }),
      methods: {},
    })
    for (const id of addonIds) registry.registerProvider(COLLECTION_CAP, id, {})
    if (options.native !== undefined) {
      registry.registerNativeProvider(COLLECTION_CAP, CAM, options.native, {})
    }
    registry.ready()
    ctx.kernel.capabilityRegistry = registry
    const binding = await addon.getBindings({ deviceId: CAM })
    return { addon, entries: binding.entries.filter((e) => e.capName === COLLECTION_CAP) }
  }

  it('answers ONE entry per provider addon, not one per capability', async () => {
    const { entries } = await bindingsFor(['pipeline-analytics', 'provider-reolink'])
    expect(entries.map((e) => e.providerAddonId)).toEqual([
      'pipeline-analytics',
      'provider-reolink',
    ])
  })

  it('the node an addon runs on is not part of its identity', async () => {
    // `pipeline-analytics@agent-a` is the SAME addon. Three registrations
    // of it put three `analytics` rows in the picker on device 107.
    const { entries } = await bindingsFor([
      'pipeline-analytics',
      'pipeline-analytics@agent-a',
      'pipeline-analytics@MacMiniAgent.localdomain',
      'provider-reolink',
    ])
    expect(entries.map((e) => e.providerAddonId)).toEqual([
      'pipeline-analytics',
      'provider-reolink',
    ])
  })

  it('folds the device’s NATIVE provider into the same set, once', async () => {
    const { entries } = await bindingsFor(['pipeline-analytics'], {
      native: 'pipeline-analytics',
    })
    expect(entries.map((e) => e.providerAddonId)).toEqual(['pipeline-analytics'])
  })

  it('binds a provider the operator never touched — Reolink appears with no sweep', async () => {
    // The migration question, answered by construction: nothing is persisted,
    // so nothing has to be back-filled onto 300 cameras and nothing can go
    // stale when an addon is deployed to a camera later.
    const { entries } = await bindingsFor(['pipeline-analytics', 'provider-reolink'])
    expect(entries.some((e) => e.providerAddonId === 'provider-reolink')).toBe(true)
  })

  it('honours the cap’s deviceTypes — a collection cap is not bound to every device', async () => {
    const { entries } = await bindingsFor(['pipeline-analytics'], {
      deviceTypes: [DeviceType.Light],
    })
    expect(entries).toEqual([])
  })

  it('REFUSES setWrapperActive for a collection cap, by name', async () => {
    // The D62 shape, for the third time in one day: the verb wrote
    // `disabledSourceIds` and the enumeration read something else, so a
    // provider could be "registered" and unbound at once with nobody seeing
    // it. A collection cap's set is derived; there is nothing to activate, and
    // saying so is better than a verb that silently does nothing.
    const { addon } = await bindingsFor(['pipeline-analytics'])
    await expect(
      addon.setWrapperActive({
        deviceId: CAM,
        capName: COLLECTION_CAP,
        wrapperAddonId: 'provider-reolink',
        active: false,
      }),
    ).rejects.toThrow(/collection/i)
  })
})
