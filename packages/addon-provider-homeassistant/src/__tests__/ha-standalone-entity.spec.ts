import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type DeviceContext, type IDeviceRuntimeState } from '@camstack/types'
import {
  buildStandaloneEntityCandidates,
  buildStandaloneEntityConfig,
  entityToStandaloneCandidate,
  generateStandaloneEntityStableId,
  standaloneEntityDeviceClass,
} from '../ha-standalone-entity.js'
import { HaSwitchDevice } from '../devices/ha-switch-device.js'
import { HaLightDevice } from '../devices/ha-light-device.js'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { pickHaChildClass } from '../ha-child-class-factory.js'
import { readHaSource } from '../ha-device-source.js'
import type { HaDiscoveredEntity } from '../ha-discovery-types.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

function switchEntity(overrides: Partial<HaDiscoveredEntity> = {}): HaDiscoveredEntity {
  return {
    entityId: 'switch.kitchen',
    domain: 'switch',
    name: 'Kitchen Switch',
    state: 'on',
    deviceClass: null,
    unitOfMeasurement: null,
    area: null,
    options: null,
    entityCategory: null,
    mappedTo: {
      deviceType: DeviceType.Switch,
      role: null,
      capabilities: ['switch'],
    },
    alreadyAdopted: false,
    adoptedCamDeviceId: null,
    ...overrides,
  }
}

function lightEntity(): HaDiscoveredEntity {
  return {
    entityId: 'light.lamp',
    domain: 'light',
    name: 'Lamp',
    state: 'on',
    deviceClass: null,
    unitOfMeasurement: null,
    area: null,
    options: null,
    entityCategory: null,
    mappedTo: {
      deviceType: DeviceType.Light,
      role: null,
      capabilities: ['switch', 'brightness'],
    },
    alreadyAdopted: false,
    adoptedCamDeviceId: null,
  }
}

// ── generateStandaloneEntityStableId ────────────────────────────────────────

describe('generateStandaloneEntityStableId', () => {
  it('uses the :entity: infix (collision-free vs :dev:)', () => {
    expect(generateStandaloneEntityStableId('ha_001', 'switch.kitchen')).toBe(
      'ha:ha_001:entity:switch.kitchen',
    )
  })
  it('differs from the container :dev: stableId for the same broker', () => {
    const entity = generateStandaloneEntityStableId('ha_001', 'switch.kitchen')
    const container = 'ha:ha_001:dev:switch.kitchen'
    expect(entity).not.toBe(container)
  })
})

// ── entityToStandaloneCandidate ─────────────────────────────────────────────

describe('entityToStandaloneCandidate', () => {
  it('produces a flat candidate (childNativeId=entityId, capabilities, no children)', () => {
    const c = entityToStandaloneCandidate(switchEntity(), false)
    expect(c.childNativeId).toBe('switch.kitchen')
    expect(c.name).toBe('Kitchen Switch')
    expect(c.type).toBe(DeviceType.Switch)
    expect(c.capabilities).toEqual(['switch'])
    expect((c as Record<string, unknown>)['children']).toBeUndefined()
    expect(c.sourceInfo?.id).toBe('switch.kitchen')
    expect(c.sourceInfo?.system).toBe('homeassistant')
  })
  it('threads alreadyAdopted through', () => {
    expect(entityToStandaloneCandidate(switchEntity(), true).alreadyAdopted).toBe(true)
    expect(entityToStandaloneCandidate(switchEntity(), false).alreadyAdopted).toBe(false)
  })
  it('marks unavailable state offline', () => {
    expect(entityToStandaloneCandidate(switchEntity({ state: 'unavailable' }), false).status).toBe(
      'offline',
    )
  })
  it('carries entity.area as metadata.externalLocation', () => {
    const c = entityToStandaloneCandidate(switchEntity({ area: 'Kitchen' }), false)
    expect((c.metadata as Record<string, unknown>)['externalLocation']).toBe('Kitchen')
  })
  it('omits metadata.externalLocation when entity.area is null', () => {
    const c = entityToStandaloneCandidate(switchEntity(), false)
    expect((c.metadata as Record<string, unknown>)['externalLocation']).toBeUndefined()
  })
})

// ── buildStandaloneEntityConfig ─────────────────────────────────────────────

describe('buildStandaloneEntityConfig', () => {
  it('carries the entity-adoption proof readHaSource recognises', () => {
    const cfg = buildStandaloneEntityConfig({
      entity: switchEntity(),
      brokerId: 'ha_001',
      integrationId: 'int-1',
    })
    expect(cfg['system']).toBe('homeassistant')
    expect(cfg['brokerId']).toBe('ha_001')
    expect(cfg['entityId']).toBe('switch.kitchen')
    expect(cfg['capabilities']).toEqual(['switch'])
    expect(cfg['integrationId']).toBe('int-1')
    expect(cfg['name']).toBe('Kitchen Switch')
  })
  it('persists unit/deviceClass/options/role/features when present', () => {
    const entity = switchEntity({
      deviceClass: 'outlet',
      unitOfMeasurement: 'W',
      options: ['a', 'b'],
      mappedTo: {
        deviceType: DeviceType.Switch,
        role: null,
        capabilities: ['switch'],
        features: ['lock-open'],
      },
    })
    const cfg = buildStandaloneEntityConfig({ entity, brokerId: 'b', integrationId: undefined })
    expect(cfg['deviceClass']).toBe('outlet')
    expect(cfg['unitOfMeasurement']).toBe('W')
    expect(cfg['options']).toEqual(['a', 'b'])
    expect(cfg['features']).toEqual(['lock-open'])
    expect(cfg['integrationId']).toBeUndefined()
  })
  it('uses the name override when supplied', () => {
    const cfg = buildStandaloneEntityConfig({
      entity: switchEntity(),
      brokerId: 'b',
      name: 'Custom',
    })
    expect(cfg['name']).toBe('Custom')
  })
})

// ── buildStandaloneEntityCandidates ─────────────────────────────────────────

describe('buildStandaloneEntityCandidates', () => {
  it("flattens every device's entities into a flat candidate list (one per entity, no children)", () => {
    const haDevices = [
      { entities: [switchEntity(), lightEntity()] },
      { entities: [switchEntity({ entityId: 'switch.hall', name: 'Hall' })] },
    ]
    const candidates = buildStandaloneEntityCandidates(haDevices, new Set())
    expect(candidates).toHaveLength(3)
    expect(candidates.map((c) => c.childNativeId)).toEqual([
      'switch.kitchen',
      'light.lamp',
      'switch.hall',
    ])
    for (const c of candidates) {
      expect((c as Record<string, unknown>)['children']).toBeUndefined()
    }
  })
  it('skips entities with no CamStack mapping', () => {
    const haDevices = [
      { entities: [switchEntity(), switchEntity({ entityId: 'switch.unmapped', mappedTo: null })] },
    ]
    const candidates = buildStandaloneEntityCandidates(haDevices, new Set())
    expect(candidates.map((c) => c.childNativeId)).toEqual(['switch.kitchen'])
  })
  it('marks alreadyAdopted only for entityIds with an existing standalone device', () => {
    const haDevices = [{ entities: [switchEntity(), lightEntity()] }]
    const candidates = buildStandaloneEntityCandidates(haDevices, new Set(['light.lamp']))
    const byId = new Map(candidates.map((c) => [c.childNativeId, c.alreadyAdopted]))
    expect(byId.get('switch.kitchen')).toBe(false)
    expect(byId.get('light.lamp')).toBe(true)
  })
  it('flattens the orphan-entity synthetic bucket the same as a real device', () => {
    // fetchHaDiscoveredDevices buckets device_id=null helpers under a synthetic
    // HaDiscoveredDevice; listEntityCandidates must still surface them.
    const orphanTemp = switchEntity({
      entityId: 'sensor.min_temperature',
      name: 'Min temperature',
      domain: 'sensor',
      deviceClass: null,
      unitOfMeasurement: '°C',
      mappedTo: {
        deviceType: DeviceType.Sensor,
        role: null,
        capabilities: ['temperature-sensor'],
      },
    })
    const candidates = buildStandaloneEntityCandidates([{ entities: [orphanTemp] }], new Set())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.childNativeId).toBe('sensor.min_temperature')
    expect(candidates[0]?.capabilities).toEqual(['temperature-sensor'])
  })
})

// ── standaloneEntityDeviceClass (cap-re-derive dispatcher) ───────────────────

interface CtxHandle {
  ctx: DeviceContext
  subscribeMutate: ReturnType<typeof vi.fn>
  push: (state: Record<string, unknown>) => void
}

/** Minimal DeviceContext stub for instantiating an HA child via the dispatcher.
 *  Returns the ctx plus the broker.subscribe spy and a state-push helper. */
function makeCtxHandle(config: Record<string, unknown>, type: DeviceType): CtxHandle {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  let eventHandler: ((event: { data: unknown }) => void) | null = null
  const subscribeMutate = vi.fn(async () => ({ subscriptionId: 'sub-standalone-1' }))
  const ctx = {
    id: 100,
    stableId: 'ha:b:entity:x',
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'X',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
        eventHandler = handler
        return () => {}
      }),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: subscribeMutate },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
      deviceManager: { setMetadata: { mutate: vi.fn(async () => {}) } },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  return {
    ctx,
    subscribeMutate,
    push: (state) => {
      if (!eventHandler) throw new Error('no event handler attached')
      eventHandler({
        data: { brokerId: config['brokerId'], key: config['entityId'], payload: state },
      })
    },
  }
}

/** Minimal DeviceContext stub for instantiating an HA child via the dispatcher. */
function makeCtx(config: Record<string, unknown>, type: DeviceType): DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  return {
    id: 100,
    stableId: 'ha:b:entity:x',
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'X',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-1' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
      deviceManager: { setMetadata: { mutate: vi.fn(async () => {}) } },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
}

describe('standaloneEntityDeviceClass — cap-re-derive dispatch', () => {
  it('instantiates the switch class for a switch entity config', () => {
    const Klass = standaloneEntityDeviceClass
    const device = new Klass(
      makeCtx(
        { brokerId: 'b', entityId: 'switch.kitchen', capabilities: ['switch'] },
        DeviceType.Switch,
      ),
    )
    expect(device).toBeInstanceOf(HaSwitchDevice)
  })
  it('re-derives the light class when capabilities drift to include brightness', () => {
    // applyDerivedSpec rebuilds via `new DeviceClass(mergedConfig)` — passing the
    // dispatcher means the merged caps pick the new class.
    const Klass = standaloneEntityDeviceClass
    const rebuilt = new Klass(
      makeCtx(
        { brokerId: 'b', entityId: 'light.lamp', capabilities: ['switch', 'brightness'] },
        DeviceType.Light,
      ),
    )
    expect(rebuilt).toBeInstanceOf(HaLightDevice)
    expect(rebuilt).not.toBeInstanceOf(HaSwitchDevice)
  })
  it('the picked class type matches pickHaChildClass for the same caps', () => {
    const caps = lightEntity().mappedTo!.capabilities
    expect(pickHaChildClass(caps)).toBe(HaLightDevice)
  })
  it('produces a parent-less HaBaseChildDevice subclass (standalone-capable)', () => {
    const Klass = standaloneEntityDeviceClass
    const device = new Klass(
      makeCtx(
        { brokerId: 'b', entityId: 'switch.kitchen', capabilities: ['switch'] },
        DeviceType.Switch,
      ),
    )
    expect(device).toBeInstanceOf(HaBaseChildDevice)
  })
})

// ── adopt(filter='entities') wiring — standalone device proof + live state ────

describe('adopt entities — standalone device proof + subscription', () => {
  it('the built config is recognised by readHaSource (entity-adoption proof)', () => {
    const config = buildStandaloneEntityConfig({
      entity: switchEntity(),
      brokerId: 'ha_001',
      integrationId: 'int-1',
    })
    const source = readHaSource(config)
    expect(source).not.toBeNull()
    expect(source?.system).toBe('homeassistant')
    expect(source?.brokerId).toBe('ha_001')
    expect(source?.entityId).toBe('switch.kitchen')
    // Standalone = NO haDeviceId (distinguishes from the Container path).
    expect(source?.haDeviceId).toBeUndefined()
  })

  it('the standalone device subscribes to its (brokerId, entityId) on onActivate', async () => {
    const config = buildStandaloneEntityConfig({ entity: switchEntity(), brokerId: 'ha_001' })
    const handle = makeCtxHandle(config, DeviceType.Switch)
    const Klass = standaloneEntityDeviceClass
    const device = new Klass(handle.ctx)
    if (!(device instanceof HaBaseChildDevice)) throw new Error('expected an HaBaseChildDevice')
    await device.onActivate()
    expect(handle.subscribeMutate).toHaveBeenCalledWith({
      brokerId: 'ha_001',
      filter: { entityIds: ['switch.kitchen'] },
    })
  })

  it('the standalone device reflects a live state push (online flips true)', () => {
    const config = buildStandaloneEntityConfig({ entity: switchEntity(), brokerId: 'ha_001' })
    const handle = makeCtxHandle(config, DeviceType.Switch)
    const Klass = standaloneEntityDeviceClass
    const device = new Klass(handle.ctx)
    handle.push({
      state: 'unavailable',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(false)
    handle.push({
      state: 'on',
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      attributes: {},
    })
    expect(device.online).toBe(true)
  })

  it('the stableId + class match the adopt result contract', () => {
    const entity = lightEntity()
    const stableId = generateStandaloneEntityStableId('ha_001', entity.entityId)
    expect(stableId).toBe('ha:ha_001:entity:light.lamp')
    // The class adopt would persist is pickHaChildClass(caps) → its deviceType.
    expect(pickHaChildClass(entity.mappedTo!.capabilities)).toBe(HaLightDevice)
  })
})
