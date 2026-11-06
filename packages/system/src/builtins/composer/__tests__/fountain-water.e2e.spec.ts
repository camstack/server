// packages/system/src/builtins/composer/__tests__/fountain-water.e2e.spec.ts
/**
 * A composed pet fountain's tank is also a `water` consumable (supply / tank),
 * DERIVED from its own `pet-fountain` slice by the composed device — never a
 * second binding. Through the real device registry, as `forward-device.e2e.spec.ts`:
 * a fountain with a maintenance item gets `water` beside it, one built without any
 * consumables entity still serves the cap with `water` alone, the level follows
 * the source, and a level that is unknown falls back to the `empty` flag.
 */
import {
  COMPOSER_ADDON_ID,
  DeclaredDevices,
  DeviceType,
  petFountainFromEntitiesComposition,
} from '@camstack/types'
import type {
  AddonApi,
  Composition,
  ComposerApplyInput,
  IEventBus,
  SystemEvent,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../../kernel/capability-registry.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { createBrokerDeviceManagerApi } from '../../../kernel/moleculer/device-cap-proxy.js'
import { isRecord } from '../../shared/device-state-changed.js'
import { type ComposedDeviceHandle, isComposedDevice } from '../composed-device.js'
import { Composer } from '../composer.js'
import { NodeDeadlineTimer } from '../deadline-timer.js'
import { SourceTracker } from '../source-tracker.js'
import { FakeHub, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const INTEGRATION_ID = 'int_blocks'
const BLOCK_ID = 'fountain'
const T0 = 1_700_000_000_000
const LEVEL = { addonId: 'homeassistant', stableId: 'sensor.level' }
const VOLUME = { addonId: 'homeassistant', stableId: 'sensor.volume' }
const PUMP = { addonId: 'homeassistant', stableId: 'switch.pump' }
const FILTER_DAYS = { addonId: 'homeassistant', stableId: 'sensor.filter_days' }
const FILTER_BUTTON = { addonId: 'homeassistant', stableId: 'button.filter_changed' }
const LEVEL_ID = 31

interface ApiCall {
  readonly path: string
  readonly input: unknown
}

const BASE = { waterLevel: LEVEL, waterVolume: VOLUME, pump: PUMP }
const WITH_FILTER = petFountainFromEntitiesComposition({
  ...BASE,
  filter: { daysRemaining: FILTER_DAYS, changed: FILTER_BUTTON },
})
const BARE = petFountainFromEntitiesComposition(BASE)

function makeRecordingApi(): { readonly api: AddonApi; readonly calls: ApiCall[] } {
  const calls: ApiCall[] = []
  let nextId = 1900
  const allocated = new Map<string, number>()
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
    if (method === 'loadRuntimeState') return {}
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
  // Documented type boundary: a test double at the AddonApi boundary, as room-device.e2e.spec.ts.
  return { api: new Proxy({}, handler) as unknown as AddonApi, calls }
}

function makeBus(): IEventBus {
  return {
    emit: (_e: SystemEvent) => undefined,
    subscribe: () => () => undefined,
    getRecent: () => [],
  }
}

let registry: DeviceRegistry
let capabilities: CapabilityRegistry
let composer: Composer
let hub: FakeHub

/** Await a promise while firing only zero-delay timers (the children batch loader coalesces on one). */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  for (let turn = 0; !settled; turn++) {
    if (turn >= 5) throw new Error('drive: not settled after 5 zero-delay turns')
    await vi.advanceTimersByTimeAsync(0)
  }
  return promise
}

function applyInput(composition: Composition): ComposerApplyInput {
  return {
    integrationId: INTEGRATION_ID,
    storeLoaded: true,
    blocks: [{ id: BLOCK_ID, name: 'Fountain', enabled: true, updatedAt: 1, composition }],
    restartBlockIds: [],
    unreadableBlocks: [],
  }
}

async function start(composition: Composition): Promise<void> {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  const log = recordingLogger()
  registry = new DeviceRegistry()
  capabilities = new CapabilityRegistry(log.logger)
  const recording = makeRecordingApi()
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
  hub.add(LEVEL, LEVEL_ID, { 'enum-sensor': { value: '64' } })
  hub.add(VOLUME, 32, { 'enum-sensor': { value: '1200' } })
  hub.add(PUMP, 33, { switch: { on: true } })
  hub.add(FILTER_DAYS, 34, { 'enum-sensor': { value: '12' } })
  hub.add(FILTER_BUTTON, 35, { button: {} }, DeviceType.Button)
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
    callCapMethod: async () => undefined,
  })
  // The composer's own rows read empty once; the second apply's read agrees (D49).
  await drive(composer.apply(applyInput(composition)))
  const result = await drive(composer.apply(applyInput(composition)))
  expect(result.blocks).toEqual([{ blockId: BLOCK_ID, status: 'running' }])
}

afterEach(() => {
  composer.shutdown()
  vi.useRealTimers()
})

afterEach(() => {
  composer.shutdown()
  vi.useRealTimers()
})

function fountain() {
  const device = registry
    .getAllForAddon(COMPOSER_ADDON_ID)
    .find((d) => d.stableId === `composed-${BLOCK_ID}`)
  if (device === undefined || !isComposedDevice(device))
    throw new Error('the fountain device is not registered')
  return device
}

function keysOf(slice: unknown): readonly string[] {
  if (!isRecord(slice) || !Array.isArray(slice['items'])) return []
  return slice['items'].flatMap((item) => (isRecord(item) ? [String(item['key'])] : []))
}

function waterOf(slice: unknown): unknown {
  if (!isRecord(slice) || !Array.isArray(slice['items'])) return undefined
  return slice['items'].find((item) => isRecord(item) && item['key'] === 'water')
}

describe('the water consumable of a composed pet fountain', () => {
  it('sits beside the maintenance items, as a supply tank at the fountain level', async () => {
    await start(WITH_FILTER)
    const slice = fountain().runtimeState.getCapState('consumables')
    expect(keysOf(slice).toSorted()).toEqual(['filter', 'water'])
    expect(waterOf(slice)).toMatchObject({
      key: 'water',
      level: 64,
      status: null,
      kind: 'supply',
      form: 'tank',
      resettable: false,
    })
  })

  it('exists on a fountain built without any consumables entity', async () => {
    await start(BARE)
    expect(keysOf(fountain().runtimeState.getCapState('consumables'))).toEqual(['water'])
    expect(capabilities.getProviderForDevice('consumables', fountain().id)).not.toBeNull()
  })

  async function reading(value: string): Promise<unknown> {
    hub.setSlice(LEVEL_ID, 'enum-sensor', { value })
    await drive(
      composer.onStateChanged({ deviceId: LEVEL_ID, capName: 'enum-sensor', slice: { value } }),
    )
    return waterOf(fountain().runtimeState.getCapState('consumables'))
  }

  it('follows the source level', async () => {
    await start(BARE)
    expect(await reading('18')).toMatchObject({ level: 18, status: null })
    expect(await reading('0')).toMatchObject({ level: 0, status: null })
  })

  it('reads an unreadable level as unknown, never 0, and invents no verdict (D393)', async () => {
    await start(BARE)
    expect(await reading('unavailable')).toMatchObject({ level: null, status: null })
  })
})
