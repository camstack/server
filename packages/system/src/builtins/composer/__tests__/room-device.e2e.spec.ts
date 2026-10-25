// packages/system/src/builtins/composer/__tests__/room-device.e2e.spec.ts
/**
 * THE acceptance test of slice 1 (D659): a composed room device, through the
 * REAL device registry, capability registry, broker DeviceManagerApi and
 * DeclaredDevices — driven the way production drives it, by `core-blocks`' REAL
 * `BlockSupervisor` over a REAL `CoreBlockStore`, whose converge calls the
 * composer and mirrors its verdicts into the stored block. The only fakes are
 * the hub's RPC answers (the AddonApi, shaped exactly like
 * `device-manager-api.spec.ts`'s), the settings-store rows under the block
 * store, the process host (no code block runs here) and the source sensors.
 *
 * It proves the invariant "a composed device is a normal device row": its caps
 * are NATIVE providers on it, resolvable by `getProviderForDevice` (D13) — the
 * one lookup every consumer (HomeKit, notification-center, exporters) makes —
 * and each answers `getStatus` from runtime state (R4). That `getStatus` is
 * the kernel's: `ComposedDevice` registers empty natives, and `registerNativeCap`
 * installs a default over the runtime slice for every cap declaring `status`
 * and `runtimeState` (`device-cap-proxy.ts`, "Default `getStatus`") — which
 * every composable cap does. This spec is the only proof of R4.
 *
 * It also proves `core-blocks`' side end to end: a deleted source fails the
 * stored block with the composer's reason VERBATIM, naming the source.
 *
 * WHAT IT DOES NOT PROVE (R8): this is the hub-style path, with a
 * `capabilityRegistry`. The shipped composer is a forked runner in `udsMode`
 * (`device-cap-proxy.ts:117-123`): no registry, `registerNativeCap` fills the
 * per-process `workerNativeCaps` map and the UDS dispatch in `addon-runner`
 * serves the natives. No forked-runner test harness exists in this repo
 * (`udsMode` appears in tests only in `kernel/__tests__/event-plane-report.spec.ts`),
 * so that path is D659's live-verification item: on the first deploy,
 * `deviceManager.getBindings(composedId)` lists both caps and
 * `getDeviceStatusAggregate` shows their values.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonApi,
  type BinaryStatus,
  COMPOSER_ADDON_ID,
  DeclaredDevices,
  DeviceType,
  type IEventBus,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
  type SystemEvent,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../../kernel/capability-registry.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { createBrokerDeviceManagerApi } from '../../../kernel/moleculer/device-cap-proxy.js'
import { type BlockProcessHost, BlockSupervisor } from '../../core-blocks/block-supervisor.js'
import { CoreBlockStore } from '../../core-blocks/core-block-store.js'
import { coreBlockStoreHarness } from '../../core-blocks/__tests__/fixtures.js'
import { isRecord } from '../../shared/device-state-changed.js'
import { type ComposedDeviceHandle, isComposedDevice } from '../composed-device.js'
import { Composer } from '../composer.js'
import { NodeDeadlineTimer } from '../deadline-timer.js'
import { SourceTracker } from '../source-tracker.js'
import { FakeHub, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const INTEGRATION_ID = 'int_blocks'
const BLOCK_ID = 'room'
const T0 = 1_700_000_000_000
/** The caps the ROOM composes; `BaseDevice` itself writes `device-status` and `feature-probe` through the same writer (`base-device.ts:277, 294`). */
const COMPOSED_CAPS: ReadonlySet<string> = new Set(['temperature-sensor', 'binary'])
const SOFA = ROOM_EXAMPLE_TEMPERATURE_SOURCES[1]
/** Source device ids as `FakeHub` is seeded below: temperatures from 11, motions from 21. */
const TEMPERATURE_ID_BASE = 11
const MOTION_ID_BASE = 21
const SOFA_ID = TEMPERATURE_ID_BASE + 1
/** The most recent motion: the occupancy deadline is this plus the window. */
const LAST_MOTION_AGO_MS = 60_000

interface ApiCall {
  readonly path: string
  readonly input: unknown
}

interface RecordingApi {
  readonly api: AddonApi
  readonly calls: ApiCall[]
}

interface StatusInput {
  readonly deviceId: number
}

/** The shape every native of a `status` cap serves (`DeviceStatusContribution`), as the registry hands it back. */
interface StatusProvider<S> {
  readonly getStatus: (input: StatusInput) => Promise<S | null>
}

interface TemperatureStatus {
  readonly celsius: number
}

/** `device-manager-api.spec.ts`'s recording AddonApi, over every namespace. */
function makeRecordingApi(): RecordingApi {
  const calls: ApiCall[] = []
  let nextId = 1900
  const allocated = new Map<string, number>()
  /** The few answers the kernel's device registration reads back; every other call answers nothing. */
  const answer = (ns: string, method: string, input: unknown): unknown => {
    if (ns !== 'deviceManager') return undefined
    if (method === 'allocateDeviceId') {
      const stableId = isRecord(input) ? String(input['stableId']) : ''
      const id = allocated.get(stableId) ?? nextId++
      allocated.set(stableId, id)
      return { id }
    }
    if (method === 'getBindings') {
      return { deviceId: isRecord(input) ? input['deviceId'] : 0, entries: [] }
    }
    // A fresh device's stored runtime state: the hub answers `{}`, never
    // nothing — a load with no answer refuses the build (D677).
    if (method === 'loadRuntimeState') return {}
    // The accessory reconcile reads the device's children (none, for a composed device).
    if (method === 'getChildrenBatch') {
      const ids = isRecord(input) ? input['parentDeviceIds'] : []
      return Object.fromEntries((Array.isArray(ids) ? ids : []).map((id) => [String(id), []]))
    }
    return undefined
  }
  const leaf = (ns: string, method: string) => {
    const call = async (input: unknown): Promise<unknown> => {
      calls.push({ path: `${ns}.${method}`, input })
      return answer(ns, method, input)
    }
    return { mutate: vi.fn(call), query: vi.fn(call) }
  }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, ns) =>
      typeof ns !== 'string'
        ? undefined
        : new Proxy(
            {},
            { get: (_u, method) => (typeof method === 'string' ? leaf(ns, method) : undefined) },
          ),
  }
  // Documented type boundary: a test double at the AddonApi boundary, as device-manager-api.spec.ts.
  return { api: new Proxy({}, handler) as unknown as AddonApi, calls }
}

function makeBus(): IEventBus {
  return {
    emit: (_e: SystemEvent) => undefined,
    subscribe: () => () => undefined,
    getRecent: () => [],
  }
}

/** No code block exists in this spec: the host is never asked to spawn. */
const IDLE_HOST: BlockProcessHost = {
  list: async () => [],
  spawn: async () => {
    throw new Error('unreachable: no code block is stored')
  },
  stop: async () => undefined,
}

/**
 * Zero-delay turns a converge may take: measured 1 on every converge of this
 * spec, plus a small margin. Tight on purpose — a new `setTimeout(0)` spin
 * awaited inside a converge (a D3 "wait for the registry" loop) must fail here,
 * not be absorbed.
 */
const MAX_ZERO_DELAY_TURNS = 3

/**
 * Await a promise while firing only ZERO-delay timers: the kernel's children
 * batch loader coalesces on a `setTimeout(0)` (`children-batch-loader.ts`), and
 * under fake timers nothing else would ever fire it. The clock never moves, so
 * the occupancy deadline stays exactly where it was armed.
 */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  // A handled branch: a rejection while the loop still turns is not "unhandled";
  // the caller sees it from `return promise`.
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  for (let turn = 0; !settled; turn++) {
    if (turn >= MAX_ZERO_DELAY_TURNS)
      throw new Error(`drive: not settled after ${MAX_ZERO_DELAY_TURNS} zero-delay turns`)
    await vi.advanceTimersByTimeAsync(0)
  }
  return promise
}

let registry: DeviceRegistry
let capabilities: CapabilityRegistry
let calls: ApiCall[]
let composer: Composer
let hub: FakeHub
let store: CoreBlockStore
let supervisor: BlockSupervisor

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  const log = recordingLogger()
  registry = new DeviceRegistry()
  capabilities = new CapabilityRegistry(log.logger)
  const recording = makeRecordingApi()
  calls = recording.calls
  const devices = createBrokerDeviceManagerApi({
    api: recording.api,
    addonId: COMPOSER_ADDON_ID,
    nodeId: 'hub/composer',
    logger: log.logger,
    eventBus: makeBus(),
    registry,
    capabilityRegistry: capabilities,
  })
  hub = new FakeHub()
  ROOM_EXAMPLE_TEMPERATURE_SOURCES.forEach((ref, i) =>
    hub.add(ref, TEMPERATURE_ID_BASE + i, {
      'temperature-sensor': { celsius: [21.0, 21.5, 21.4][i], lastFetchedAt: T0 - 10_000 + i },
    }),
  )
  ROOM_EXAMPLE_MOTION_SOURCES.forEach((ref, i) =>
    hub.add(ref, MOTION_ID_BASE + i, {
      motion: {
        detected: false,
        lastDetectedAt: i === 0 ? T0 - LAST_MOTION_AGO_MS : null,
        autoClearAfterMs: null,
      },
    }),
  )
  const listOwnDevices = async () =>
    registry
      .getAllForAddon(COMPOSER_ADDON_ID)
      .map((d) => ({ id: d.id, stableId: d.stableId, integrationId: INTEGRATION_ID }))
  const declared = new DeclaredDevices({
    logger: log.logger,
    addonId: COMPOSER_ADDON_ID,
    devices,
    localNodeId: 'hub/composer',
    getIntegration: async () => null,
    createIntegration: async () => {
      throw new Error('unreachable: integrationId is supplied')
    },
    updateIntegration: async () => undefined,
    listOwnDevices,
  })
  composer = new Composer({
    logger: log.logger,
    tracker: new SourceTracker(hub.ports(log.logger)),
    lookupCap: LOOKUP_CAP,
    readPersisted: async () =>
      (await listOwnDevices()).map((r) => ({ id: r.id, stableId: r.stableId })),
    declare: async (integrationId, declarations) => {
      const result = await declared.reconcile({
        integrationName: 'Blocks',
        integrationId,
        devices: declarations,
      })
      const handles = new Map<string, ComposedDeviceHandle>()
      for (const o of result.devices)
        if (isComposedDevice(o.device)) handles.set(o.stableId, o.device)
      return { devices: handles }
    },
    devices: {
      setName: (id, name) => devices.setName(id, name),
      decommission: (id) => devices.decommission(id),
      applyDerivedSpec: (id, spec) => devices.applyDerivedSpec(id, spec),
    },
    claims: hub.claimsApi(),
    events: { emit: () => undefined },
    readExistingTargetCap: async (deviceId, capName) => hub.effective(deviceId, capName) ?? null,
    describeTarget: hub.ports(log.logger).readBoundCaps,
    now: () => Date.now(),
    newTimer: () => new NodeDeadlineTimer(() => Date.now()),
  })

  // The operator's write, through the real block store.
  store = await coreBlockStoreHarness(log.logger, { newId: () => BLOCK_ID })
  await store.load()
  await store.createComposition(
    {
      name: 'Living room',
      enabled: true,
      composition: roomCompositionExample({
        temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
        motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
        occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
      }),
    },
    'admin',
  )
  supervisor = new BlockSupervisor({
    nodeId: 'hub',
    root: path.join(os.tmpdir(), 'camstack-room-e2e-unused'),
    store,
    host: IDLE_HOST,
    compile: async () => ({ ok: false, error: 'unreachable: no code block is stored' }),
    logger: log.logger,
    composer,
    integrationId: () => INTEGRATION_ID,
    storeLoaded: () => store.isLoaded(),
    loadStore: () => store.load(),
  })

  // First converge: the composer's own rows read EMPTY once — a cold registry
  // answers the same — so it declares nothing and says why (D49).
  await drive(supervisor.converge())
  expect(store.get(BLOCK_ID)).toMatchObject({
    status: 'starting',
    lastError: expect.stringContaining('read empty once'),
  })
  expect(registry.getAllForAddon(COMPOSER_ADDON_ID)).toEqual([])
  // Second converge: the read agrees, the room is declared and runs.
  await drive(supervisor.converge())
  expect(store.get(BLOCK_ID)).toMatchObject({ status: 'running' })
  expect(store.get(BLOCK_ID)?.lastError).toBeUndefined()
})

afterEach(() => {
  composer.shutdown()
  vi.useRealTimers()
})

function room() {
  const device = registry
    .getAllForAddon(COMPOSER_ADDON_ID)
    .find((d) => d.stableId === `composed-${BLOCK_ID}`)
  if (device === undefined || !isComposedDevice(device))
    throw new Error('the room device is not registered')
  return device
}

describe('the composed room is a normal device', () => {
  it('is registered under the composer, as a Sensor', () => {
    expect(room().type).toBe(DeviceType.Sensor)
  })

  it('carries its caps as NATIVE providers, resolvable per device (D13)', () => {
    const id = room().id
    expect(capabilities.getNativeCapsForDevice(id)).toEqual(
      expect.arrayContaining(['temperature-sensor', 'binary']),
    )
    expect(capabilities.getProviderForDevice('temperature-sensor', id)).not.toBeNull()
    expect(capabilities.getProviderForDevice('binary', id)).not.toBeNull()
  })

  it('a consumer holding only the device id reaches it through the ordinary lookups', () => {
    // What HomeKit / notification-center do: id → device row → provider for (cap, device).
    const id = room().id
    expect(registry.getById(id)).toBe(room())
    expect(registry.getAddonId(id)).toBe(COMPOSER_ADDON_ID)
    expect(capabilities.getNativeAddonId('binary', id)).toBe(COMPOSER_ADDON_ID)
    expect(capabilities.getNativeAddonId('temperature-sensor', id)).toBe(COMPOSER_ADDON_ID)
  })

  it('answers getStatus from its runtime state, like every native of a status cap (R4)', async () => {
    const id = room().id
    const binary = capabilities.getProviderForDevice<StatusProvider<BinaryStatus>>('binary', id)
    const temperature = capabilities.getProviderForDevice<StatusProvider<TemperatureStatus>>(
      'temperature-sensor',
      id,
    )
    expect(typeof binary?.getStatus).toBe('function')
    expect(typeof temperature?.getStatus).toBe('function')
    await expect(binary?.getStatus({ deviceId: id })).resolves.toMatchObject({ on: true })
    await expect(temperature?.getStatus({ deviceId: id })).resolves.toMatchObject({ celsius: 21.3 })
  })

  it('holds the average temperature and the occupancy', () => {
    expect(room().runtimeState.getCapState('temperature-sensor')).toMatchObject({ celsius: 21.3 })
    expect(room().runtimeState.getCapState('binary')).toMatchObject({ on: true })
    expect(room().online).toBe(true)
  })

  it('writes its COMPOSED slices through deviceState.setCapSlice, tagged with its own id (R8)', () => {
    const id = room().id
    // `drive` returned only once the converge settled: the writes have landed, no wait needed.
    const composedWrites = calls.flatMap((c) => {
      if (c.path !== 'deviceState.setCapSlice' || !isRecord(c.input)) return []
      const capName = c.input['capName']
      if (c.input['deviceId'] !== id || typeof capName !== 'string' || !COMPOSED_CAPS.has(capName))
        return []
      return [{ capName, slice: c.input['slice'] }]
    })
    // Both composed caps, not only the `device-status` / `feature-probe` writes BaseDevice makes on its own.
    expect(composedWrites.map((w) => w.capName).toSorted()).toEqual([
      'binary',
      'temperature-sensor',
    ])
    expect(composedWrites.find((w) => w.capName === 'temperature-sensor')?.slice).toMatchObject({
      celsius: 21.3,
    })
    expect(composedWrites.find((w) => w.capName === 'binary')?.slice).toMatchObject({ on: true })
  })

  it('occupancy clears on its own deadline — no source event, no poll', async () => {
    const untilDeadline = ROOM_OCCUPANCY_WINDOW_MS - LAST_MOTION_AGO_MS
    const sourceReadsBefore = hub.calls.length
    await vi.advanceTimersByTimeAsync(untilDeadline - 1)
    expect(room().runtimeState.getCapState('binary')).toMatchObject({ on: true })
    await vi.advanceTimersByTimeAsync(2)
    expect(room().runtimeState.getCapState('binary')).toMatchObject({ on: false })
    // No poll: the window closed on the stored deadline without reading any source.
    expect(hub.calls.slice(sourceReadsBefore)).toEqual([])
  })
})

describe('a source is deleted — the stored block carries the composer’s reason, verbatim', () => {
  beforeEach(async () => {
    if (SOFA === undefined) throw new Error('the room example has no sofa sensor')
    hub.remove(SOFA)
    await composer.onDeviceUnregistered(SOFA_ID)
    await drive(supervisor.converge())
  })

  it('the core block is FAILED and its lastError is the composer’s reason naming the source', () => {
    const composerReason = composer.getStates([BLOCK_ID])[0]?.reason
    expect(composerReason).toEqual(expect.stringContaining('sensor.sofa_temperature'))
    expect(store.get(BLOCK_ID)).toMatchObject({ status: 'failed', lastError: composerReason })
  })

  it('the composed device stays registered, offline, still resolvable', () => {
    const id = room().id
    expect(room().online).toBe(false)
    expect(capabilities.getProviderForDevice('binary', id)).not.toBeNull()
  })
})
