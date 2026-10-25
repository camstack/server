import { describe, it, expect, vi } from 'vitest'
import {
  DeviceType,
  type DeviceConstructor,
  type DeviceContext,
  type IDevice,
  type IDeviceRuntimeState,
  type SavedDevice,
} from '@camstack/types'
import {
  isContainerEntityChildSaved,
  isStandaloneEntitySaved,
  partitionRestoreDevices,
  standaloneEntityDeviceClass,
} from '../ha-standalone-entity.js'
import { HaSwitchDevice } from '../devices/ha-switch-device.js'
import { HaLightDevice } from '../devices/ha-light-device.js'
import { HaBaseChildDevice } from '../ha-base-child-device.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A persisted top-level STANDALONE entity device row (entityId, no haDeviceId,
 *  parentDeviceId === null) as `restoreDevices` receives it on boot. */
function standaloneSaved(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 501,
    stableId: 'ha:ha_001:entity:switch.kitchen',
    type: DeviceType.Switch,
    name: 'Kitchen Switch',
    location: null,
    disabled: false,
    parentDeviceId: null,
    config: {
      system: 'homeassistant',
      brokerId: 'ha_001',
      entityId: 'switch.kitchen',
      capabilities: ['switch'],
    },
    ...overrides,
  }
}

/** A persisted top-level CONTAINER device row (haDeviceId, no entityId). */
function containerSaved(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 601,
    stableId: 'ha:ha_001:dev:ha-dev-001',
    type: DeviceType.Container,
    name: 'Aqara Hub',
    location: null,
    disabled: false,
    parentDeviceId: null,
    config: {
      system: 'homeassistant',
      brokerId: 'ha_001',
      haDeviceId: 'ha-dev-001',
      entities: [],
    },
    ...overrides,
  }
}

/** A persisted Container ACCESSORY-CHILD row (entityId, no haDeviceId, has a
 *  parent) — one HA entity spawned under its `HaContainerDevice` parent. */
function containerChildSaved(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 700,
    stableId: 'ha:ha_001:dev:ha-dev-001-switch.x',
    type: DeviceType.Switch,
    name: 'Switch X',
    location: null,
    disabled: false,
    parentDeviceId: 601,
    config: {
      brokerId: 'ha_001',
      entityId: 'switch.x',
      capabilities: ['switch'],
    },
    ...overrides,
  }
}

/** A persisted EVENT-EMITTER entity child of a Container (Case 1): an
 *  `event.*` entity spawned under its parent. `type === EventEmitter` — the one
 *  child type that IS in `deviceClasses` (mapped to the Case-2 aggregator), so
 *  it must be partitioned OUT of the default pass. */
function eventEntityChildSaved(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 488,
    stableId: 'ha:ha_001:dev:ha-dev-002-event.tapparella_hall_ch1',
    type: DeviceType.EventEmitter,
    name: 'Tapparella Hall CH1',
    location: null,
    disabled: false,
    parentDeviceId: 488,
    config: {
      brokerId: 'ha_001',
      entityId: 'event.tapparella_hall_ch1',
      capabilities: ['event-emitter'],
    },
    ...overrides,
  }
}

/** A persisted top-level per-broker EVENT-BUS aggregator row (Case 2):
 *  `kind:'event-bus'`, no entityId, no parent. Restored via the default pass
 *  (`deviceClasses[EventEmitter] = HaEventBusDevice`). */
function eventBusAggregatorSaved(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 7,
    stableId: 'ha:ha_001:events',
    type: DeviceType.EventEmitter,
    name: 'Home Assistant Events',
    location: null,
    disabled: false,
    parentDeviceId: null,
    config: {
      system: 'homeassistant',
      brokerId: 'ha_001',
      kind: 'event-bus',
    },
    ...overrides,
  }
}

// ── isStandaloneEntitySaved ──────────────────────────────────────────────────

describe('isStandaloneEntitySaved', () => {
  it('recognises a top-level entity row (entityId, no haDeviceId, no parent)', () => {
    expect(isStandaloneEntitySaved(standaloneSaved())).toBe(true)
  })
  it('rejects a Container row (haDeviceId, no entityId)', () => {
    expect(isStandaloneEntitySaved(containerSaved())).toBe(false)
  })
  it('rejects an accessory child row (has a parent)', () => {
    expect(isStandaloneEntitySaved(standaloneSaved({ parentDeviceId: 601 }))).toBe(false)
  })
  it('rejects a non-HA row (no brokerId source)', () => {
    expect(isStandaloneEntitySaved(standaloneSaved({ config: { foo: 'bar' } }))).toBe(false)
  })
  it('rejects a row carrying BOTH entityId and haDeviceId (Container-shaped)', () => {
    const saved = standaloneSaved({
      config: {
        system: 'homeassistant',
        brokerId: 'ha_001',
        entityId: 'switch.kitchen',
        haDeviceId: 'ha-dev-001',
        capabilities: ['switch'],
      },
    })
    expect(isStandaloneEntitySaved(saved)).toBe(false)
  })
})

// ── isContainerEntityChildSaved ──────────────────────────────────────────────

describe('isContainerEntityChildSaved', () => {
  it('recognises a switch entity child of a Container (entityId, parent, no haDeviceId)', () => {
    expect(isContainerEntityChildSaved(containerChildSaved())).toBe(true)
  })
  it('recognises an EventEmitter entity child (the regression case)', () => {
    expect(isContainerEntityChildSaved(eventEntityChildSaved())).toBe(true)
  })
  it('rejects the top-level event-bus aggregator (no parent, no entityId)', () => {
    expect(isContainerEntityChildSaved(eventBusAggregatorSaved())).toBe(false)
  })
  it('rejects a top-level standalone entity row (no parent)', () => {
    expect(isContainerEntityChildSaved(standaloneSaved())).toBe(false)
  })
  it('rejects a Container parent row (no entityId)', () => {
    expect(isContainerEntityChildSaved(containerSaved())).toBe(false)
  })
})

// ── partitionRestoreDevices ──────────────────────────────────────────────────

describe('partitionRestoreDevices', () => {
  it('splits standalone, container children, and the rest into three buckets', () => {
    const { standalone, containerChildren, rest } = partitionRestoreDevices([
      standaloneSaved(),
      containerSaved(),
      containerChildSaved(),
    ])
    expect(standalone.map((s) => s.id)).toEqual([501])
    expect(containerChildren.map((s) => s.id)).toEqual([700])
    // Only the Container parent stays in the default-pass bucket.
    expect(rest.map((s) => s.id)).toEqual([601])
  })

  it('routes an EventEmitter entity child to containerChildren, the aggregator to rest', () => {
    // The exact collision the bug report describes: both rows are
    // `DeviceType.EventEmitter`. The entity child (has parent + entityId) must
    // be OWNED by the Container reconcile (containerChildren), while the
    // top-level aggregator (kind:'event-bus') stays on the default pass (rest →
    // HaEventBusDevice via deviceClasses[EventEmitter]).
    const { standalone, containerChildren, rest } = partitionRestoreDevices([
      eventEntityChildSaved(),
      eventBusAggregatorSaved(),
      containerSaved(),
    ])
    expect(standalone).toEqual([])
    expect(containerChildren.map((s) => s.id)).toEqual([488])
    expect(rest.map((s) => s.id)).toEqual([7, 601])
  })

  it('returns empty standalone/containerChildren lists when there are none', () => {
    const { standalone, containerChildren, rest } = partitionRestoreDevices([containerSaved()])
    expect(standalone).toEqual([])
    expect(containerChildren).toEqual([])
    expect(rest.map((s) => s.id)).toEqual([601])
  })
})

// ── restore round-trip via the dispatcher (mirrors the create path) ───────────
//
// `onRestoreDevices` restores each standalone row via
// `kernel.devices.create(stableId, standaloneEntityDeviceClass, {})`. The
// kernel `create` primitive ALWAYS captures a rebuild factory keyed by the
// passed class (device-cap-proxy.ts), so passing the dispatcher means a
// post-restore `applyDerivedSpec` re-derives the concrete class via
// `pickHaChildClass(config.capabilities)` — exactly like the create path.
//
// We simulate the kernel `create`/rebuild contract: `create` instantiates
// `new DeviceClass(ctxFromPersistedConfig)` and stores a rebuild closure that
// re-instantiates from a merged config.

interface CreatedDevice {
  readonly id: number
  readonly device: IDevice
}

interface FakeKernel {
  create: (
    stableId: string,
    DeviceClass: DeviceConstructor<IDevice>,
    config: Record<string, unknown>,
  ) => CreatedDevice
  rebuild: (deviceId: number, mergedConfig: Record<string, unknown>) => IDevice
}

/** Minimal DeviceContext stub the dispatcher + HaBaseChildDevice constructor
 *  need on the restore path: a persistedConfig blob + deviceMeta.type. */
function makeRestoreCtx(config: Record<string, unknown>): DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  return {
    id: 100,
    stableId: typeof config['__stableId'] === 'string' ? config['__stableId'] : 'ha:b:entity:x',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Switch,
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

/** Minimal stand-in for the kernel `create` + `applyDerivedSpec` rebuild
 *  contract, so the test can assert the restored concrete class + that the
 *  rebuild factory re-derives on a capability drift. */
function makeFakeKernel(persisted: Record<number, Record<string, unknown>>): FakeKernel {
  const factories = new Map<number, (merged: Record<string, unknown>) => IDevice>()
  let nextId = 900
  const create = (
    stableId: string,
    DeviceClass: DeviceConstructor<IDevice>,
    _config: Record<string, unknown>,
  ): CreatedDevice => {
    const id = nextId++
    const restoreConfig = Object.values(persisted).find((c) => c['__stableId'] === stableId) ?? {}
    const device = new DeviceClass(makeRestoreCtx(restoreConfig))
    factories.set(id, (merged) => new DeviceClass(makeRestoreCtx(merged)))
    return { id, device }
  }
  return {
    create,
    rebuild: (deviceId, mergedConfig) => {
      const f = factories.get(deviceId)
      if (!f) throw new Error('no rebuild factory')
      return f(mergedConfig)
    },
  }
}

describe('standalone restore — concrete class + rebuild factory', () => {
  it('restores a switch entity as the concrete HaSwitchDevice (not Container, not skipped)', () => {
    const restoreConfig = {
      __stableId: 'ha:ha_001:entity:switch.kitchen',
      brokerId: 'ha_001',
      entityId: 'switch.kitchen',
      capabilities: ['switch'],
    }
    const kernel = makeFakeKernel({ 0: restoreConfig })
    const result = kernel.create('ha:ha_001:entity:switch.kitchen', standaloneEntityDeviceClass, {})
    expect(result.device).toBeInstanceOf(HaSwitchDevice)
    expect(result.device).toBeInstanceOf(HaBaseChildDevice)
  })

  it('the captured rebuild factory re-derives the light class on a capability drift', () => {
    const restoreConfig = {
      __stableId: 'ha:ha_001:entity:light.lamp',
      brokerId: 'ha_001',
      entityId: 'light.lamp',
      capabilities: ['switch'],
    }
    const kernel = makeFakeKernel({ 0: restoreConfig })
    const result = kernel.create('ha:ha_001:entity:light.lamp', standaloneEntityDeviceClass, {})
    // Originally a plain switch.
    expect(result.device).toBeInstanceOf(HaSwitchDevice)
    // applyDerivedSpec merges new caps and rebuilds via the captured factory.
    const rebuilt = kernel.rebuild(result.id, {
      brokerId: 'ha_001',
      entityId: 'light.lamp',
      capabilities: ['switch', 'brightness'],
    })
    expect(rebuilt).toBeInstanceOf(HaLightDevice)
    expect(rebuilt).not.toBeInstanceOf(HaSwitchDevice)
  })
})
