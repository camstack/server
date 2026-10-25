/**
 * End-to-end-ish lifecycle regression guard for HA container + child devices.
 *
 * Drives the REAL classes (HaContainerDevice + child classes via pickHaChildClass)
 * against stubbed DeviceContext dependencies.  The only mocked parts are the
 * kernel seams: registerNativeCap spy, api.broker.publish spy, eventBus,
 * runtimeState, and logger.
 *
 * Regression: device 240 — cover.open returned "Capability cover provider not
 * available" because the cover native-cap binding never got registered through
 * the device lifecycle.  These tests assert the cover cap is registered on
 * initial adopt AND after a simulated restore.
 */
import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaContainerDevice } from '../devices/ha-container-device.js'
import type { AccessoryChildSpec } from '@camstack/types'

// ── Stub factory ─────────────────────────────────────────────────────────────

/**
 * Build a minimal DeviceContext stub for a container device.
 * Mirror the pattern from ha-container-device.spec.ts.
 */
function buildContainerCtx(
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
      broker: { publish: { mutate: vi.fn() } },
      deviceManager: { setMetadata: { mutate: vi.fn(async () => {}) } },
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

/**
 * Build a child DeviceContext stub for a child accessory device.
 * Accepts config + meta from an AccessoryChildSpec and wires up the
 * registerNativeCap spy to both install the schema and record cap names.
 */
function buildChildCtx(
  spec: AccessoryChildSpec,
  childId: number,
): {
  ctx: import('@camstack/types').DeviceContext
  registeredCaps: string[]
  publishMutate: ReturnType<typeof vi.fn>
} {
  const registeredCaps: string[] = []
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const publishMutate = vi.fn()

  const ctx = {
    id: childId,
    stableId: `ha:child:${childId}`,
    parentDeviceId: 1,
    deviceMeta: {
      id: childId,
      stableId: `ha:child:${childId}`,
      type: spec.meta.type,
      name: spec.meta.name ?? String(childId),
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: spec.config,
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
      registeredCaps.push(cap.name)
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: { publish: { mutate: publishMutate } },
      deviceManager: { setMetadata: { mutate: vi.fn(async () => {}) } },
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

  return { ctx, registeredCaps, publishMutate }
}

// ── spawn helper ─────────────────────────────────────────────────────────────

/**
 * Mimics what the kernel does when it adopts or restores a container device:
 * 1. Construct HaContainerDevice from the container context.
 * 2. Call getAccessoryChildren() to get the specs.
 * 3. For each spec, build a child context and invoke spec.factory(childCtx).
 *
 * Returns the per-child {registeredCaps, publishMutate, device} map keyed by entityId.
 */
function spawn(containerCtx: import('@camstack/types').DeviceContext): Map<
  string,
  {
    registeredCaps: string[]
    publishMutate: ReturnType<typeof vi.fn>
    device: import('@camstack/types').IDevice
  }
> {
  const container = new HaContainerDevice(containerCtx)
  const children = container.getAccessoryChildren()

  const result = new Map<
    string,
    {
      registeredCaps: string[]
      publishMutate: ReturnType<typeof vi.fn>
      device: import('@camstack/types').IDevice
    }
  >()
  let childId = 100
  for (const spec of children) {
    const { ctx, registeredCaps, publishMutate } = buildChildCtx(spec, childId++)
    const device = spec.factory(ctx)
    result.set(spec.stableIdSuffix, { registeredCaps, publishMutate, device })
  }
  return result
}

// ── Shared persisted config ───────────────────────────────────────────────────

const CONTAINER_PERSISTED_CONFIG = {
  system: 'homeassistant',
  brokerId: 'broker-ha-01',
  haDeviceId: 'ha-device-240',
  integrationId: 'integration-xyz',
  entities: [
    {
      entityId: 'cover.tapparella_kitchen',
      deviceType: DeviceType.Cover,
      capabilities: ['cover'],
    },
    {
      entityId: 'sensor.temperature_kitchen',
      deviceType: DeviceType.Sensor,
      capabilities: ['temperature-sensor'],
    },
  ],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HA lifecycle e2e — cover cap registration regression guard', () => {
  it('adopt → cover cap and temperature-sensor cap are registered', () => {
    // Simulate initial adopt: kernel constructs container + children fresh.
    const containerCtx = buildContainerCtx(CONTAINER_PERSISTED_CONFIG, 240)
    const children = spawn(containerCtx)

    const coverEntry = children.get('cover.tapparella_kitchen')
    const sensorEntry = children.get('sensor.temperature_kitchen')

    expect(coverEntry, 'cover child must be spawned').toBeDefined()
    expect(sensorEntry, 'sensor child must be spawned').toBeDefined()

    // The cover native cap MUST be registered — this was the prod bug for device 240.
    expect(coverEntry!.registeredCaps).toContain('cover')
    // The sensor cap must also be registered.
    expect(sensorEntry!.registeredCaps).toContain('temperature-sensor')
  })

  it('restore → cover cap is re-registered from the same persistedConfig (regression guard for device-240)', () => {
    // Simulate a reboot: the kernel restores from DB by re-constructing
    // HaContainerDevice with the same persisted config blob.
    // We build a FRESH context (new stubs, new vitest fn instances) to
    // confirm the registration happens every time, not just once.
    const freshContainerCtx = buildContainerCtx(CONTAINER_PERSISTED_CONFIG, 240)
    const children = spawn(freshContainerCtx)

    const coverEntry = children.get('cover.tapparella_kitchen')
    expect(coverEntry, 'cover child must be re-spawned on restore').toBeDefined()

    // If this fails, the cover provider is NOT wired after reboot → device-240 bug reproduced.
    expect(coverEntry!.registeredCaps).toContain('cover')
  })

  it('cover command path → open() publishes the correct HA service call', async () => {
    const containerCtx = buildContainerCtx(CONTAINER_PERSISTED_CONFIG, 240)
    const children = spawn(containerCtx)
    const coverEntry = children.get('cover.tapparella_kitchen')
    expect(coverEntry, 'cover child must be spawned').toBeDefined()

    // Retrieve the registered cover provider from the ctx.registerNativeCap spy.
    // The factory spy is the mock registered on the child ctx.
    // The coverCapability object was passed as first arg; the second arg is the provider.
    // We need to find the call where cap.name === 'cover' and invoke provider.open().
    const registerCalls = (
      coverEntry!.device as unknown as {
        ctx: { registerNativeCap: ReturnType<typeof vi.fn> }
      }
    ).ctx.registerNativeCap.mock.calls as Array<[{ name: string }, { open: () => Promise<void> }]>

    const coverCall = registerCalls.find(([cap]) => cap.name === 'cover')
    expect(coverCall, 'registerNativeCap must have been called with a cover cap').toBeDefined()

    const coverProvider = coverCall![1]
    await coverProvider.open()

    expect(coverEntry!.publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha-01',
        target: expect.objectContaining({
          domain: 'cover',
          service: 'open_cover',
          entityId: 'cover.tapparella_kitchen',
        }),
      }),
    )
  })
})
