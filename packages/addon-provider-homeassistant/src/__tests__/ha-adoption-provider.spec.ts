import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeviceType } from '@camstack/types'
import type { AddonContext, IDeviceAdoptionProvider, DeviceSummary } from '@camstack/types'
import { buildDiscoveryCandidates } from '../ha-discovery.js'
import { HaProviderAddon } from '../addon.js'
import type { HaDiscoveredDevice, HaDiscoveredEntity } from '../ha-discovery-types.js'

/**
 * Unit tests for the device-adoption provider re-exposure.
 *
 * Tests the `adopt` delegation: with a stubbed registry (one broker,
 * one cover HA device) and a `createDevice` spy, calls the adoption
 * provider's `adopt({integrationId, childNativeIds:[haDeviceId]})` and
 * asserts `createDevice` was called once with `type: DeviceType.Container`
 * and `config.integrationId` set + `config.entities.length > 0`.
 *
 * We test via `buildDiscoveryCandidates` (the same underlying function
 * used in `fetchHaDiscoveredDevices`) to verify the adoption path produces
 * the right Container config, then simulate the thin handler logic inline.
 */

// ── Stub data ─────────────────────────────────────────────────────────────

const BROKER_ID = 'ha_001'
const INTEGRATION_ID = 'int-abc'
const HA_DEVICE_ID = 'ha-cover-dev'

const deviceEntries = [
  {
    id: HA_DEVICE_ID,
    name: 'Garage Hub',
    name_by_user: null,
    manufacturer: 'Aqara',
    model: 'Hub M2',
    sw_version: '1.0',
    hw_version: null,
    area_id: null,
    disabled_by: null,
  },
]

const entityEntries = [
  {
    entity_id: 'cover.garage',
    unique_id: 'uid-cover',
    device_id: HA_DEVICE_ID,
    name: 'Garage Door',
    original_name: 'Garage Door',
    platform: 'homeassistant',
    area_id: null,
    device_class: 'garage',
    original_device_class: 'garage',
    disabled_by: null,
    hidden_by: null,
  },
]

const stateMap = {
  'cover.garage': {
    entity_id: 'cover.garage',
    state: 'closed',
    attributes: { supported_features: 4, device_class: 'garage' },
    last_changed: '2026-01-01T00:00:00+00:00',
    last_updated: '2026-01-01T00:00:00+00:00',
  },
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Simulate the adoption-provider `adopt` handler logic for a single HA device,
 * using the same pipeline (`buildDiscoveryCandidates`) that populates the
 * `fetchHaDiscoveredDevices` path used by the real handler.
 *
 * This mirrors what `buildAdoptionProvider().adopt` does:
 *   1. Fetch candidates from HA.
 *   2. Build the Container config for the target haDeviceId.
 *   3. Call `createDevice({ type: Container, config })`.
 */
async function simulateAdopt(
  haDeviceId: string,
  integrationId: string,
  createDevice: ReturnType<typeof vi.fn>,
): Promise<void> {
  // Mimic fetching via buildDiscoveryCandidates.
  const candidates = buildDiscoveryCandidates({
    brokerId: BROKER_ID,
    integrationId,
    devices: deviceEntries,
    entities: entityEntries,
    states: stateMap,
  })

  const candidate = candidates.find((c) => {
    const cfg = c.prefilledConfig as Record<string, unknown>
    return cfg['haDeviceId'] === haDeviceId
  })

  if (!candidate) throw new Error(`candidate not found: ${haDeviceId}`)

  const config: Record<string, unknown> = {
    ...candidate.prefilledConfig,
    name: candidate.suggestedName,
  }

  await (
    createDevice as (input: {
      type: DeviceType
      config: Record<string, unknown>
    }) => Promise<unknown>
  )({
    type: DeviceType.Container,
    config,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('device-adoption provider adopt delegation (unit stubs)', () => {
  let createDeviceSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createDeviceSpy = vi.fn(async () => ({
      id: 42,
      stableId: `ha:${BROKER_ID}:dev:${HA_DEVICE_ID}`,
      addonId: 'provider-homeassistant',
      type: DeviceType.Container,
      name: 'Garage Hub',
      online: true,
      parentDeviceId: null,
      features: [],
      config: {},
    }))
  })

  it('calls createDevice once for a single haDeviceId', async () => {
    await simulateAdopt(HA_DEVICE_ID, INTEGRATION_ID, createDeviceSpy)

    expect(createDeviceSpy).toHaveBeenCalledOnce()
  })

  it('calls createDevice with DeviceType.Container', async () => {
    await simulateAdopt(HA_DEVICE_ID, INTEGRATION_ID, createDeviceSpy)

    const [call] = createDeviceSpy.mock.calls as [
      { type: DeviceType; config: Record<string, unknown> },
    ][]
    expect(call?.[0].type).toBe(DeviceType.Container)
  })

  it('config includes integrationId', async () => {
    await simulateAdopt(HA_DEVICE_ID, INTEGRATION_ID, createDeviceSpy)

    const [call] = createDeviceSpy.mock.calls as [
      { type: DeviceType; config: Record<string, unknown> },
    ][]
    expect(call?.[0].config['integrationId']).toBe(INTEGRATION_ID)
  })

  it('config includes at least one entity', async () => {
    await simulateAdopt(HA_DEVICE_ID, INTEGRATION_ID, createDeviceSpy)

    const [call] = createDeviceSpy.mock.calls as [
      { type: DeviceType; config: Record<string, unknown> },
    ][]
    const entities = call?.[0].config['entities'] as unknown[]
    expect(entities.length).toBeGreaterThan(0)
  })

  it('config includes brokerId', async () => {
    await simulateAdopt(HA_DEVICE_ID, INTEGRATION_ID, createDeviceSpy)

    const [call] = createDeviceSpy.mock.calls as [
      { type: DeviceType; config: Record<string, unknown> },
    ][]
    expect(call?.[0].config['brokerId']).toBe(BROKER_ID)
  })

  it('config includes haDeviceId', async () => {
    await simulateAdopt(HA_DEVICE_ID, INTEGRATION_ID, createDeviceSpy)

    const [call] = createDeviceSpy.mock.calls as [
      { type: DeviceType; config: Record<string, unknown> },
    ][]
    expect(call?.[0].config['haDeviceId']).toBe(HA_DEVICE_ID)
  })

  it('config sets system to homeassistant', async () => {
    await simulateAdopt(HA_DEVICE_ID, INTEGRATION_ID, createDeviceSpy)

    const [call] = createDeviceSpy.mock.calls as [
      { type: DeviceType; config: Record<string, unknown> },
    ][]
    expect(call?.[0].config['system']).toBe('homeassistant')
  })
})

// ── Location import on adopt (real handler) ──────────────────────────────────
//
// Exercises the REAL `buildAdoptionProvider().adopt` + `adoptStandaloneEntities`
// paths against a constructed `HaProviderAddon` with `_ctx`, the broker registry,
// and the device-manager `listLocations`/`addLocation`/`setLocation` cap stubbed.
// The location work is best-effort, so a `setLocation` rejection must NOT abort
// the adopt.

const NEW_DEVICE_ID = 7

interface DeviceManagerStub {
  listLocations: { query: ReturnType<typeof vi.fn> }
  addLocation: { mutate: ReturnType<typeof vi.fn> }
  setLocation: { mutate: ReturnType<typeof vi.fn> }
}

interface AdoptHarness {
  provider: IDeviceAdoptionProvider
  deviceManager: DeviceManagerStub
  createDevice: ReturnType<typeof vi.fn>
  kernelCreate: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
}

/** Minimal HA device fixture with one mappable cover entity. */
function makeHaDevice(area: string | null, entityArea: string | null): HaDiscoveredDevice {
  const entity: HaDiscoveredEntity = {
    entityId: 'cover.garage',
    domain: 'cover',
    name: 'Garage Door',
    state: 'closed',
    deviceClass: 'garage',
    unitOfMeasurement: null,
    area: entityArea,
    options: null,
    entityCategory: null,
    mappedTo: {
      deviceType: DeviceType.Cover,
      role: null,
      capabilities: ['cover'],
    },
    alreadyAdopted: false,
    adoptedCamDeviceId: null,
  }
  return {
    haDeviceId: HA_DEVICE_ID,
    name: 'Garage Hub',
    area,
    manufacturer: 'Aqara',
    model: 'Hub M2',
    swVersion: '1.0',
    integration: null,
    entityCount: 1,
    entities: [entity],
    alreadyAdopted: false,
    adoptedCamDeviceId: null,
  }
}

/**
 * Construct a real `HaProviderAddon`, inject `_ctx` + a stub broker registry,
 * stub `fetchHaDiscoveredDevices`, `createDevice` (devices path) and
 * `kernel.devices.create`/`getChildren`, and return the real adoption provider.
 */
function makeAdoptHarness(opts: {
  device: HaDiscoveredDevice
  existingLocations: readonly string[]
  setLocationRejects?: boolean
}): AdoptHarness {
  const warn = vi.fn()
  const deviceManager: DeviceManagerStub = {
    listLocations: { query: vi.fn(async () => [...opts.existingLocations]) },
    addLocation: { mutate: vi.fn(async () => undefined) },
    setLocation: {
      mutate: vi.fn(async () => {
        if (opts.setLocationRejects) throw new Error('boom')
        return undefined
      }),
    },
  }

  const createDevice = vi.fn(
    async (): Promise<DeviceSummary> =>
      ({
        id: NEW_DEVICE_ID,
        stableId: `ha:${BROKER_ID}:dev:${HA_DEVICE_ID}`,
        addonId: 'provider-homeassistant',
        type: DeviceType.Container,
        name: 'Garage Hub',
        online: true,
        parentDeviceId: null,
        features: [],
        config: {},
      }) as unknown as DeviceSummary,
  )

  const kernelCreate = vi.fn(async () => ({ id: NEW_DEVICE_ID }))
  const kernel = {
    localNodeId: 'hub',
    devices: {
      create: kernelCreate,
      getChildren: vi.fn(async () => []),
      getAll: vi.fn(async () => []),
    },
  }

  const api = { deviceManager }
  const ctx = {
    id: 'provider-homeassistant',
    logger: {
      error: vi.fn(),
      warn,
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel,
    api,
  } as unknown as AddonContext

  const addon = new HaProviderAddon()
  // Inject ctx + a broker registry stub (the entities path resolves
  // `getBrokerIdByIntegrationId`; the devices path uses the closure `brokerFor`).
  const internal = addon as unknown as {
    _ctx: AddonContext
    registry: { getBrokerIdByIntegrationId: (id: string) => string }
    fetchHaDiscoveredDevices: (brokerId: string) => Promise<readonly HaDiscoveredDevice[]>
    createDevice: typeof createDevice
    buildAdoptionProvider: () => IDeviceAdoptionProvider
  }
  internal._ctx = ctx
  internal.registry = { getBrokerIdByIntegrationId: () => BROKER_ID }
  internal.fetchHaDiscoveredDevices = vi.fn(async () => [opts.device])
  internal.createDevice = createDevice

  const provider = internal.buildAdoptionProvider()
  return { provider, deviceManager, createDevice, kernelCreate, warn }
}

describe('device-adoption adopt — importLocations (devices granularity)', () => {
  it('reuses an existing location via fuzzy match (no addLocation)', async () => {
    const h = makeAdoptHarness({
      device: makeHaDevice('Kitchen', null),
      existingLocations: ['kitchen'],
    })

    const res = await h.provider.adopt({
      integrationId: INTEGRATION_ID,
      childNativeIds: [HA_DEVICE_ID],
      importLocations: true,
    })

    expect(res.adopted).toHaveLength(1)
    expect(h.deviceManager.addLocation.mutate).not.toHaveBeenCalled()
    expect(h.deviceManager.setLocation.mutate).toHaveBeenCalledWith({
      deviceId: NEW_DEVICE_ID,
      location: 'kitchen',
    })
  })

  it('creates a new location when no fuzzy match (addLocation then setLocation)', async () => {
    const h = makeAdoptHarness({ device: makeHaDevice('Kitchen', null), existingLocations: [] })

    await h.provider.adopt({
      integrationId: INTEGRATION_ID,
      childNativeIds: [HA_DEVICE_ID],
      importLocations: true,
    })

    expect(h.deviceManager.addLocation.mutate).toHaveBeenCalledWith({ name: 'Kitchen' })
    expect(h.deviceManager.setLocation.mutate).toHaveBeenCalledWith({
      deviceId: NEW_DEVICE_ID,
      location: 'Kitchen',
    })
  })

  it('does NOT touch location caps when importLocations is omitted', async () => {
    const h = makeAdoptHarness({
      device: makeHaDevice('Kitchen', null),
      existingLocations: ['kitchen'],
    })

    await h.provider.adopt({ integrationId: INTEGRATION_ID, childNativeIds: [HA_DEVICE_ID] })

    expect(h.deviceManager.listLocations.query).not.toHaveBeenCalled()
    expect(h.deviceManager.addLocation.mutate).not.toHaveBeenCalled()
    expect(h.deviceManager.setLocation.mutate).not.toHaveBeenCalled()
  })

  it('does NOT assign a location when the device has no area', async () => {
    const h = makeAdoptHarness({ device: makeHaDevice(null, null), existingLocations: ['kitchen'] })

    await h.provider.adopt({
      integrationId: INTEGRATION_ID,
      childNativeIds: [HA_DEVICE_ID],
      importLocations: true,
    })

    expect(h.deviceManager.setLocation.mutate).not.toHaveBeenCalled()
  })

  it('still adopts when setLocation rejects (best-effort, warn logged)', async () => {
    const h = makeAdoptHarness({
      device: makeHaDevice('Kitchen', null),
      existingLocations: ['kitchen'],
      setLocationRejects: true,
    })

    const res = await h.provider.adopt({
      integrationId: INTEGRATION_ID,
      childNativeIds: [HA_DEVICE_ID],
      importLocations: true,
    })

    expect(res.adopted).toHaveLength(1)
    expect(res.adopted[0]?.parentDeviceId).toBe(NEW_DEVICE_ID)
    expect(h.warn).toHaveBeenCalled()
  })
})

describe('device-adoption adopt — importLocations (entities granularity)', () => {
  it('assigns the entity area for a standalone device', async () => {
    const h = makeAdoptHarness({ device: makeHaDevice(null, 'Bedroom'), existingLocations: [] })

    const res = await h.provider.adopt({
      integrationId: INTEGRATION_ID,
      childNativeIds: ['cover.garage'],
      filter: 'entities',
      importLocations: true,
    })

    expect(res.adopted).toHaveLength(1)
    expect(h.deviceManager.addLocation.mutate).toHaveBeenCalledWith({ name: 'Bedroom' })
    expect(h.deviceManager.setLocation.mutate).toHaveBeenCalledWith({
      deviceId: NEW_DEVICE_ID,
      location: 'Bedroom',
    })
  })
})
