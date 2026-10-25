import { describe, it, expect, vi } from 'vitest'
import { DeviceType, DeviceFeature, type IDeviceRuntimeState } from '@camstack/types'
import { HaContainerDevice } from '../ha-container-device.js'
import { HaPowerMeterDevice } from '../ha-power-meter-device.js'
import { HaEnumSensorDevice } from '../ha-enum-sensor-device.js'
import { deriveChildLayout } from '../../ha-container-reconcile.js'

/** Build a minimal DeviceContext stub for HaContainerDevice. */
function buildCtx(
  persistedConfig: Record<string, unknown>,
  id = 1,
): import('@camstack/types').DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null

  return {
    id,
    stableId: `ha:container:${id}`,
    parentDeviceId: null,
    deviceMeta: {
      id,
      stableId: `ha:container:${id}`,
      type: DeviceType.Container,
      name: 'Test HA Device',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-container-test' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
      deviceManager: {
        setMetadata: { mutate: vi.fn(async () => {}) },
        setChildLayout: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
      addContext: vi.fn(),
      with: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext
}

describe('HaContainerDevice.getAccessoryChildren', () => {
  it('returns one spec per entity with correct stableIdSuffix, meta, and config', () => {
    const brokerId = 'broker-abc'
    const integrationId = 'integration-xyz'
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId,
      haDeviceId: 'ha-dev-001',
      integrationId,
      entities: [
        {
          entityId: 'cover.garage_door',
          deviceType: DeviceType.Cover,
          capabilities: ['cover'],
        },
        {
          entityId: 'sensor.temperature',
          deviceType: DeviceType.Sensor,
          capabilities: ['temperature-sensor'],
        },
      ],
    })

    const device = new HaContainerDevice(ctx)
    const children = device.getAccessoryChildren()

    expect(children).toHaveLength(2)

    // First child — cover
    const coverSpec = children[0]!
    expect(coverSpec.stableIdSuffix).toBe('cover.garage_door')
    expect(coverSpec.meta.type).toBe(DeviceType.Cover)
    expect(coverSpec.meta.integrationId).toBe(integrationId)
    expect(coverSpec.config).toMatchObject({
      brokerId,
      entityId: 'cover.garage_door',
      capabilities: ['cover'],
    })

    // Second child — temperature sensor
    const sensorSpec = children[1]!
    expect(sensorSpec.stableIdSuffix).toBe('sensor.temperature')
    expect(sensorSpec.meta.type).toBe(DeviceType.Sensor)
    expect(sensorSpec.meta.integrationId).toBe(integrationId)
    expect(sensorSpec.config).toMatchObject({
      brokerId,
      entityId: 'sensor.temperature',
      capabilities: ['temperature-sensor'],
    })
  })

  it('advertises Resyncable so the generic Re-sync button is offered on the container', () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-resyncable',
      entities: [],
    })

    const device = new HaContainerDevice(ctx)
    expect(device.features).toContain(DeviceFeature.Resyncable)
  })

  it('returns empty array when entities list is empty', () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-002',
      entities: [],
    })

    const device = new HaContainerDevice(ctx)
    expect(device.getAccessoryChildren()).toHaveLength(0)
  })

  it('omits integrationId from meta when not present in config', () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-003',
      entities: [
        {
          entityId: 'switch.light',
          deviceType: DeviceType.Switch,
          capabilities: ['switch'],
        },
      ],
    })

    const device = new HaContainerDevice(ctx)
    const [spec] = device.getAccessoryChildren()
    expect(spec!.meta).not.toHaveProperty('integrationId')
  })

  it('uses friendly name as child meta.name when entity has a name field', () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-005',
      entities: [
        {
          entityId: 'cover.tapparella_camera_da_letto',
          deviceType: DeviceType.Cover,
          capabilities: ['cover'],
          name: 'Tapparella bedroom',
        },
      ],
    })

    const device = new HaContainerDevice(ctx)
    const [spec] = device.getAccessoryChildren()
    expect(spec!.meta.name).toBe('Tapparella bedroom')
  })

  it('falls back to entityId as child meta.name when entity has no name field', () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-006',
      entities: [
        {
          entityId: 'cover.garage_door',
          deviceType: DeviceType.Cover,
          capabilities: ['cover'],
        },
      ],
    })

    const device = new HaContainerDevice(ctx)
    const [spec] = device.getAccessoryChildren()
    expect(spec!.meta.name).toBe('cover.garage_door')
  })

  it('propagates role from entity to child spec meta', () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-007',
      integrationId: 'integration-xyz',
      entities: [
        {
          entityId: 'sensor.temperature',
          deviceType: DeviceType.Sensor,
          capabilities: ['temperature-sensor'],
          role: 'numeric-sensor',
        },
        {
          entityId: 'binary_sensor.motion',
          deviceType: DeviceType.Sensor,
          capabilities: ['motion-sensor'],
          role: 'binary-sensor',
        },
        {
          entityId: 'switch.light',
          deviceType: DeviceType.Switch,
          capabilities: ['switch'],
          // no role — should be omitted from meta
        },
      ],
    })

    const device = new HaContainerDevice(ctx)
    const children = device.getAccessoryChildren()

    expect(children).toHaveLength(3)

    // Entity with role — role must appear in meta
    expect(children[0]!.meta.role).toBe('numeric-sensor')
    expect(children[1]!.meta.role).toBe('binary-sensor')
    // Entity without role — role must be absent from meta (not explicit null)
    expect(children[2]!.meta).not.toHaveProperty('role')
  })

  it('factory function produces an IDevice instance using pickHaChildClass', () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-004',
      entities: [
        {
          entityId: 'cover.front_gate',
          deviceType: DeviceType.Cover,
          capabilities: ['cover'],
        },
      ],
    })

    const device = new HaContainerDevice(ctx)
    const [spec] = device.getAccessoryChildren()

    // Build a child context matching what the factory will receive
    const childCtx = buildCtx(
      { brokerId: 'broker-abc', entityId: 'cover.front_gate', capabilities: ['cover'] },
      99,
    )
    // Override type so HaBaseChildDevice reads Cover from meta
    ;(childCtx as unknown as { deviceMeta: { type: DeviceType } }).deviceMeta.type =
      DeviceType.Cover

    const child = spec!.factory(childCtx)
    expect(child).toBeDefined()
    expect(
      typeof (child as unknown as { getAccessoryChildren: unknown }).getAccessoryChildren,
    ).toBe('function')
  })

  it('factory derives the concrete child class from the CHILD ctx config capabilities (enables generic re-sync rebuild into a new class)', () => {
    // The entity was adopted as an enum-sensor. After a re-sync persists new
    // capabilities (e.g. HA reclassified it as a power meter), the kernel rebuilds
    // the live child via THIS factory with the updated config. The factory must
    // pick the class from the child ctx config, not the stale closed-over caps.
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-resync',
      entities: [
        {
          entityId: 'sensor.plug_power',
          deviceType: DeviceType.Sensor,
          capabilities: ['enum-sensor'],
        },
      ],
    })

    const device = new HaContainerDevice(ctx)
    const [spec] = device.getAccessoryChildren()

    // Rebuild ctx carries the NEW mapping-derived capabilities.
    const rebuiltCtx = buildCtx(
      { brokerId: 'broker-abc', entityId: 'sensor.plug_power', capabilities: ['power-meter'] },
      42,
    )
    ;(rebuiltCtx as unknown as { deviceMeta: { type: DeviceType } }).deviceMeta.type =
      DeviceType.Sensor

    const rebuilt = spec!.factory(rebuiltCtx)
    expect(rebuilt).toBeInstanceOf(HaPowerMeterDevice)
    expect(rebuilt).not.toBeInstanceOf(HaEnumSensorDevice)
  })

  it('getAccessoryChildren reflects a live config.setAll update to entities[] (re-sync durability)', async () => {
    const ctx = buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-live',
      entities: [
        { entityId: 'sensor.a', deviceType: DeviceType.Sensor, capabilities: ['enum-sensor'] },
      ],
    })
    const device = new HaContainerDevice(ctx)
    expect(device.getAccessoryChildren().map((s) => s.stableIdSuffix)).toEqual(['sensor.a'])

    // A re-sync persisted a second entity onto the Container's config.
    await device.config.setAll({
      entities: [
        { entityId: 'sensor.a', deviceType: DeviceType.Sensor, capabilities: ['enum-sensor'] },
        {
          entityId: 'sensor.b',
          deviceType: DeviceType.Sensor,
          capabilities: ['temperature-sensor'],
        },
      ],
    })

    expect(device.getAccessoryChildren().map((s) => s.stableIdSuffix)).toEqual([
      'sensor.a',
      'sensor.b',
    ])
  })
})

describe('HaContainerDevice.persistChildLayout (childLayout I/O + best-effort swallow)', () => {
  function buildContainerCtx(): import('@camstack/types').DeviceContext {
    return buildCtx({
      system: 'homeassistant',
      brokerId: 'broker-abc',
      haDeviceId: 'ha-dev-layout',
      entities: [
        { entityId: 'switch.relay', deviceType: DeviceType.Switch, capabilities: ['switch'] },
        {
          entityId: 'sensor.signal',
          deviceType: DeviceType.Sensor,
          capabilities: ['enum-sensor'],
          entityCategory: 'diagnostic',
        },
        {
          entityId: 'number.threshold',
          deviceType: DeviceType.Sensor,
          capabilities: ['numeric-sensor'],
          entityCategory: 'config',
        },
      ],
    })
  }

  it('calls setChildLayout with the derived childLayout for the container current entities', async () => {
    const ctx = buildContainerCtx()
    const device = new HaContainerDevice(ctx)

    await device.persistChildLayout()

    const setChildLayout = ctx.api.deviceManager.setChildLayout.mutate
    expect(setChildLayout).toHaveBeenCalledTimes(1)
    expect(setChildLayout).toHaveBeenCalledWith({
      deviceId: device.id,
      childLayout: deriveChildLayout(device.config.values.entities),
    })
  })

  it('swallows (does not throw) when setChildLayout.mutate rejects, and logs a warning', async () => {
    const ctx = buildContainerCtx()
    ;(
      ctx.api.deviceManager.setChildLayout.mutate as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('hub unreachable'))
    const device = new HaContainerDevice(ctx)

    await expect(device.persistChildLayout()).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('onActivate persists the layout and never throws even when setChildLayout.mutate rejects', async () => {
    const ctx = buildContainerCtx()
    ;(
      ctx.api.deviceManager.setChildLayout.mutate as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('hub unreachable'))
    const device = new HaContainerDevice(ctx)

    await expect(device.onActivate()).resolves.toBeUndefined()
    expect(ctx.api.deviceManager.setChildLayout.mutate).toHaveBeenCalled()
  })
})
