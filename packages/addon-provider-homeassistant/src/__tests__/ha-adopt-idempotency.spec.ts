/**
 * Re-adopting an already-adopted candidate must be a NO-OP, not an error.
 *
 * This is the property the operator's only recourse depends on. `adopt` puts
 * the whole `childNativeIds` array behind one transport deadline; when the
 * deadline expires mid-loop the response is lost but the work continues, so the
 * operator learns nothing about which candidates landed and re-submits the same
 * list. Before this fix that retry called `kernel.devices.create` with a
 * stableId that already existed, the registry threw
 * `Device numeric id N already registered`, and — because the loop counts a
 * throw as a failure and rethrows once EVERY candidate failed — a retry in
 * which everything had already succeeded reported
 * "ha-adoption: all N adopt(s) failed". The safest possible outcome was
 * indistinguishable from total failure.
 *
 * Verified on the live hub before the fix: adopting the same candidate twice
 * produced exactly that error on the second call.
 */

import type { AddonContext, DeviceSummary, IDeviceAdoptionProvider } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HaProviderAddon } from '../addon.js'
import type { HaDiscoveredDevice, HaDiscoveredEntity } from '../ha-discovery-types.js'

const BROKER_ID = 'ha_001'
const INTEGRATION_ID = 'int-abc'
const HA_DEVICE_ID = 'ha-cover-dev'
const EXISTING_ID = 42
const EXISTING_CHILD_ID = 43
const NEW_DEVICE_ID = 7

function makeHaDevice(): HaDiscoveredDevice {
  const entity: HaDiscoveredEntity = {
    entityId: 'cover.garage',
    domain: 'cover',
    name: 'Garage Door',
    state: 'closed',
    deviceClass: 'garage',
    unitOfMeasurement: null,
    area: null,
    options: null,
    entityCategory: null,
    mappedTo: { deviceType: DeviceType.Cover, role: null, capabilities: ['cover'] },
    alreadyAdopted: false,
    adoptedCamDeviceId: null,
  }
  return {
    haDeviceId: HA_DEVICE_ID,
    name: 'Garage Hub',
    area: null,
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

interface Harness {
  readonly provider: IDeviceAdoptionProvider
  readonly createDevice: ReturnType<typeof vi.fn>
  readonly info: ReturnType<typeof vi.fn>
}

/**
 * `alreadyRegistered` decides whether the kernel already holds a top-level
 * device at the stableId `adopt` would generate — i.e. whether this call is a
 * first adopt or a retry.
 */
function makeHarness(opts: { alreadyRegistered: boolean }): Harness {
  const info = vi.fn()
  const existing = {
    id: EXISTING_ID,
    stableId: `ha:${BROKER_ID}:dev:${HA_DEVICE_ID}`,
    parentDeviceId: null,
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
  const kernel = {
    localNodeId: 'hub',
    devices: {
      create: vi.fn(async () => ({ id: NEW_DEVICE_ID })),
      getAll: vi.fn(async () => (opts.alreadyRegistered ? [existing] : [])),
      getChildren: vi.fn(async (parentId: number) =>
        parentId === EXISTING_ID ? [{ id: EXISTING_CHILD_ID }] : [],
      ),
    },
  }
  const ctx = {
    id: 'provider-homeassistant',
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info,
      debug: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel,
    api: { deviceManager: { listLocations: { query: vi.fn(async () => []) } } },
  } as unknown as AddonContext

  const addon = new HaProviderAddon()
  const internal = addon as unknown as {
    _ctx: AddonContext
    registry: { getBrokerIdByIntegrationId: (id: string) => string }
    fetchHaDiscoveredDevices: (brokerId: string) => Promise<readonly HaDiscoveredDevice[]>
    createDevice: typeof createDevice
    buildAdoptionProvider: () => IDeviceAdoptionProvider
  }
  internal._ctx = ctx
  internal.registry = { getBrokerIdByIntegrationId: () => BROKER_ID }
  internal.fetchHaDiscoveredDevices = vi.fn(async () => [makeHaDevice()])
  internal.createDevice = createDevice

  return { provider: internal.buildAdoptionProvider(), createDevice, info }
}

describe('ha-adoption: re-adopting an already-adopted candidate', () => {
  it('creates the device on the FIRST adopt', async () => {
    const h = makeHarness({ alreadyRegistered: false })
    const res = await h.provider.adopt({
      integrationId: INTEGRATION_ID,
      childNativeIds: [HA_DEVICE_ID],
    })
    expect(h.createDevice).toHaveBeenCalledTimes(1)
    expect(res.adopted).toEqual([
      { childNativeId: HA_DEVICE_ID, parentDeviceId: NEW_DEVICE_ID, accessoryDeviceIds: [] },
    ])
  })

  it('returns the EXISTING device on a retry — no throw, no second create', async () => {
    const h = makeHarness({ alreadyRegistered: true })
    const res = await h.provider.adopt({
      integrationId: INTEGRATION_ID,
      childNativeIds: [HA_DEVICE_ID],
    })
    // No duplicate: the kernel is never asked to create a second device.
    expect(h.createDevice).not.toHaveBeenCalled()
    // And the caller gets a usable answer, not "all 1 adopt(s) failed".
    expect(res.adopted).toEqual([
      {
        childNativeId: HA_DEVICE_ID,
        parentDeviceId: EXISTING_ID,
        accessoryDeviceIds: [EXISTING_CHILD_ID],
      },
    ])
  })

  it('logs the skip with the numeric deviceId tag', async () => {
    const h = makeHarness({ alreadyRegistered: true })
    await h.provider.adopt({ integrationId: INTEGRATION_ID, childNativeIds: [HA_DEVICE_ID] })
    const line = h.info.mock.calls.find(
      (c: readonly unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('already adopted'),
    )
    expect(line, 'a skipped candidate must not be silent').toBeDefined()
    const meta = line?.[1] as { tags?: Record<string, unknown> } | undefined
    expect(meta?.tags?.deviceId).toBe(EXISTING_ID)
  })

  it('logs every candidate that LANDS, with its numeric deviceId', async () => {
    const h = makeHarness({ alreadyRegistered: false })
    await h.provider.adopt({ integrationId: INTEGRATION_ID, childNativeIds: [HA_DEVICE_ID] })
    const line = h.info.mock.calls.find(
      (c: readonly unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('candidate adopted'),
    )
    expect(
      line,
      'the log is the ONLY record of which candidates landed when the caller times out',
    ).toBeDefined()
    const meta = line?.[1] as { tags?: Record<string, unknown> } | undefined
    expect(meta?.tags?.deviceId).toBe(NEW_DEVICE_ID)
  })
})
