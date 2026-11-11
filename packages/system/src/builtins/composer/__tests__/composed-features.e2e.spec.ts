// packages/system/src/builtins/composer/__tests__/composed-features.e2e.spec.ts
/**
 * A composed device carries its FEATURES like a regular device (a driver sets
 * them on its own device; the composer is the driver of a composed one): the
 * flags are what its bound caps stand for (`featuresOfBoundCaps`), through the
 * REAL device registry and `DeclaredDevices`. A wrapper cap (`timed-run`) is
 * bound by core-blocks, not by the composition, so it arrives through the
 * bindings: after the apply that built the device, after a bindings change, and
 * gone again when the cap is unbound.
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
const BLOCK_ID = 'stove'

const NOW = { kind: 'expression', expr: 'now', bindings: {} }

const STOVE = CompositionSchema.parse({
  target: { kind: 'new', type: DeviceType.Fan },
  features: [
    {
      kind: 'fields',
      cap: 'consumables',
      fields: { lastChangedAt: NOW, lastFetchedAt: NOW },
      items: {
        filter: {
          label: 'Filter',
          fields: {
            status: { kind: 'expression', expr: '"ok"', bindings: {} },
          },
        },
      },
    },
  ],
})

function makeApi(): AddonApi {
  let nextId = 5391
  const allocated = new Map<string, number>()
  const answer = (ns: string, method: string, input: unknown): unknown => {
    if (ns !== 'deviceManager') return undefined
    if (method === 'allocateDeviceId') {
      const stableId = isRecord(input) ? String(input['stableId']) : ''
      const id = allocated.get(stableId) ?? nextId++
      allocated.set(stableId, id)
      return { id }
    }
    if (method === 'getBindings') return { deviceId: 0, entries: [] }
    if (method === 'loadRuntimeState') return {}
    if (method === 'getChildrenBatch') {
      const ids = isRecord(input) ? input['parentDeviceIds'] : []
      return Object.fromEntries((Array.isArray(ids) ? ids : []).map((id) => [String(id), []]))
    }
    return undefined
  }
  const leaf = (ns: string, method: string) => {
    const call = async (input: unknown): Promise<unknown> => answer(ns, method, input)
    return { mutate: vi.fn(call), query: vi.fn(call) }
  }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, ns) =>
      typeof ns !== 'string'
        ? undefined
        : new Proxy(
            {},
            {
              get: (_u, method) => (typeof method === 'string' ? leaf(ns, method) : undefined),
            },
          ),
  }
  // Documented type boundary: a test double at the AddonApi boundary, as forward-device.e2e.spec.ts.
  return new Proxy({}, handler) as unknown as AddonApi
}

const bus: IEventBus = {
  emit: (_e: SystemEvent) => undefined,
  subscribe: () => () => undefined,
  getRecent: () => [],
}

let registry: DeviceRegistry
let composer: Composer
let boundCaps: readonly string[]

function applyInput(): ComposerApplyInput {
  return {
    integrationId: INTEGRATION_ID,
    storeLoaded: true,
    blocks: [
      {
        id: BLOCK_ID,
        name: 'Stove',
        enabled: true,
        updatedAt: 1,
        composition: STOVE,
      },
    ],
    restartBlockIds: [],
    unreadableBlocks: [],
  }
}

async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  const done = () => {
    settled = true
  }
  promise.then(done, done)
  for (let turn = 0; !settled; turn++) {
    if (turn >= 5) throw new Error('drive: not settled after 5 zero-delay turns')
    await vi.advanceTimersByTimeAsync(0)
  }
  return promise
}

function stove() {
  const device = registry
    .getAllForAddon(COMPOSER_ADDON_ID)
    .find((d) => d.stableId === `composed-${BLOCK_ID}`)
  if (device === undefined || !isComposedDevice(device))
    throw new Error('the stove device is not registered')
  return device
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
  boundCaps = ['switch', 'running-state']
  const log = recordingLogger()
  registry = new DeviceRegistry()
  const devices = createBrokerDeviceManagerApi({
    api: makeApi(),
    addonId: COMPOSER_ADDON_ID,
    nodeId: 'hub/composer',
    logger: log.logger,
    eventBus: bus,
    registry,
    capabilityRegistry: new CapabilityRegistry(log.logger),
  })
  const hub = new FakeHub()
  const listOwnDevices = async () =>
    registry.getAllForAddon(COMPOSER_ADDON_ID).map((d) => ({
      id: d.id,
      stableId: d.stableId,
      integrationId: INTEGRATION_ID,
    }))
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
    boundCapNames: async () => boundCaps,
  })
  await drive(composer.apply(applyInput()))
  await drive(composer.apply(applyInput()))
})

afterEach(() => {
  composer.shutdown()
  vi.useRealTimers()
})

describe('the features of a composed device', () => {
  it('carry only the bound switch while no other feature cap is bound', () => {
    expect(stove().features).toEqual(['switch'])
  })

  it('carry timed-run once the wrapper binds it, and lose it when it is unbound', async () => {
    boundCaps = ['switch', 'running-state', 'timed-run']
    await drive(
      composer.onBindingsChanged({
        deviceId: stove().id,
        capName: 'timed-run',
        addonId: 'core-blocks',
        reason: 'wrapper-activated',
      }),
    )
    expect(stove().features).toEqual(['timed-run', 'switch'])

    boundCaps = ['switch', 'running-state']
    await drive(
      composer.onBindingsChanged({
        deviceId: stove().id,
        capName: 'timed-run',
        addonId: 'core-blocks',
        reason: 'wrapper-deactivated',
      }),
    )
    expect(stove().features).toEqual(['switch'])
  })

  it('are read again when the composition is applied (a hub restart binds before the apply)', async () => {
    boundCaps = ['switch', 'timed-run']
    await drive(composer.apply(applyInput()))
    expect(stove().features).toEqual(['timed-run', 'switch'])
  })

  it('ignore a bindings change of another device', async () => {
    boundCaps = ['timed-run']
    await drive(
      composer.onBindingsChanged({
        deviceId: 1,
        capName: 'timed-run',
        addonId: 'core-blocks',
        reason: 'wrapper-activated',
      }),
    )
    expect(stove().features).toEqual(['switch'])
  })
})
