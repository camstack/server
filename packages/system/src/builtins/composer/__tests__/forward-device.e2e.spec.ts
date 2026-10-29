// packages/system/src/builtins/composer/__tests__/forward-device.e2e.spec.ts
/**
 * A composed device of a NEW type whose cap is commanded by `forward` (D967),
 * through the REAL device registry, capability registry and `DeclaredDevices`
 * (the wiring `room-device.e2e.spec.ts` proves for state): the call a consumer
 * makes on `getProviderForDevice(cap, composedId)` reaches the source device's
 * cap method, with the source's own device id and the mapped input; an item
 * with a `reset` forward is `resettable`; a source that is gone fails the call
 * with a reason that names it.
 *
 * Not proven here (the hub-style path, as in the room spec): the forked
 * runner's UDS dispatch of a native method. That is the live check.
 */
import { COMPOSER_ADDON_ID, CompositionSchema, DeclaredDevices, DeviceType } from '@camstack/types'
import type { AddonApi, ComposerApplyInput, IEventBus, SystemEvent } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const FILTER_BUTTON = { addonId: 'homeassistant', stableId: 'button.filter_changed' }
const FILTER_BUTTON_ID = 31

interface ApiCall {
  readonly path: string
  readonly input: unknown
}

interface ItemProvider {
  readonly reset: (input: { deviceId: number; key: string }) => Promise<void>
}

const NOW = { kind: 'expression', expr: 'now', bindings: {} }

const FOUNTAIN = CompositionSchema.parse({
  target: { kind: 'new', type: DeviceType.PetFeeder },
  features: [
    {
      kind: 'fields',
      cap: 'consumables',
      fields: { lastChangedAt: NOW, lastFetchedAt: NOW },
      items: {
        filter: {
          label: 'Filter',
          fields: { status: { kind: 'expression', expr: '"ok"', bindings: {} } },
          reset: { kind: 'forward', source: FILTER_BUTTON, cap: 'button', method: 'press' },
        },
      },
    },
  ],
})

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

interface SourceCall {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
}

let registry: DeviceRegistry
let capabilities: CapabilityRegistry
let composer: Composer
let hub: FakeHub
let sourceCalls: SourceCall[]
let lines: ReturnType<typeof recordingLogger>['lines']

function applyInput(): ComposerApplyInput {
  return {
    integrationId: INTEGRATION_ID,
    storeLoaded: true,
    blocks: [
      { id: BLOCK_ID, name: 'Fountain', enabled: true, updatedAt: 1, composition: FOUNTAIN },
    ],
    restartBlockIds: [],
    unreadableBlocks: [],
  }
}

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

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  const log = recordingLogger()
  lines = log.lines
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
  hub.add(FILTER_BUTTON, FILTER_BUTTON_ID, { button: {} }, DeviceType.Button)
  sourceCalls = []
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
    callCapMethod: async (deviceId, cap, method, args) => {
      sourceCalls.push({ deviceId, cap, method, args })
    },
  })
  // The composer's own rows read empty once; the second apply's read agrees (D49).
  await drive(composer.apply(applyInput()))
  const result = await drive(composer.apply(applyInput()))
  expect(result.blocks).toEqual([{ blockId: BLOCK_ID, status: 'running' }])
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

function consumables(): ItemProvider {
  const provider = capabilities.getProviderForDevice<ItemProvider>('consumables', fountain().id)
  if (provider === null) throw new Error('the fountain serves no consumables')
  return provider
}

describe('a forward-commanded composed device', () => {
  it('marks the item that has a reset forward resettable', () => {
    expect(fountain().runtimeState.getCapState('consumables')).toMatchObject({
      items: [{ key: 'filter', resettable: true }],
    })
  })

  it('an item reset reaches the source button, with the SOURCE device id', async () => {
    await consumables().reset({ deviceId: fountain().id, key: 'filter' })
    expect(sourceCalls).toEqual([
      { deviceId: FILTER_BUTTON_ID, cap: 'button', method: 'press', args: {} },
    ])
  })

  it('a reset of an item with no command is refused by name, and calls nothing', async () => {
    await expect(
      consumables().reset({ deviceId: fountain().id, key: 'desiccant' }),
    ).rejects.toThrow(/no-command/)
    expect(sourceCalls).toEqual([])
  })

  it('a source that is gone fails the call naming it, and logs under the composed device id', async () => {
    hub.remove(FILTER_BUTTON)
    await expect(
      drive(consumables().reset({ deviceId: fountain().id, key: 'filter' })),
    ).rejects.toThrow(/homeassistant\/button\.filter_changed.*source-gone/)
    expect(sourceCalls).toEqual([])
    const refused = lines.find((l) => l.message.includes('forward command failed'))
    expect(refused?.extras?.tags).toEqual({ deviceId: fountain().id })
  })
})
