import { describe, it, expect, vi } from 'vitest'
import type { HmCustomEntity } from 'nodehomematic'
import {
  buildHmAdoptionProvider,
  type HmAdoptionFacade,
  type HmAdoptionProviderDeps,
} from '../homematic-adoption-provider.js'

// ---------------------------------------------------------------------------
// Minimal facade / registry fakes (narrow interfaces — no casts)
// ---------------------------------------------------------------------------

/** Minimal device fixture structurally compatible with HmDiscoverable. */
const switchDev = {
  address: 'ABC0001',
  type: 'HmIP-BSM',
  name: 'Living Room Switch',
  channels: [{ address: 'ABC0001:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] }],
} as const

const thermoDev = {
  address: 'ABC0002',
  type: 'HmIP-WTH-2',
  name: 'Hallway Thermostat',
  channels: [
    {
      address: 'ABC0002:1',
      index: 1,
      type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
      dataPoints: [],
    },
  ],
} as const

/** Key/remote device — adopts as an EventEmitter (not skipped). */
const remoteDev = {
  address: 'ABC0003',
  type: 'HmIP-RC8',
  name: 'Remote',
  channels: [{ address: 'ABC0003:1', index: 1, type: 'KEY_TRANSCEIVER', dataPoints: [] }],
} as const

/** Generic device (no supported channel — omitted by buildHmCandidates). */
const genericDev = {
  address: 'ABC0098',
  type: 'HmIP-XYZ',
  name: 'Unknown',
  channels: [{ address: 'ABC0098:1', index: 1, type: 'SWITCH_TRANSMITTER', dataPoints: [] }],
} as const

/** Switch device carrying a CCU room (drives the location-import path). */
const roomedDev = {
  address: 'ABC0010',
  type: 'HmIP-BSM',
  name: 'Hall Lamp',
  rooms: ['Hall'],
  channels: [{ address: 'ABC0010:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] }],
} as const

type FakeDevice =
  | typeof switchDev
  | typeof thermoDev
  | typeof remoteDev
  | typeof genericDev
  | typeof roomedDev

/** Narrow facade stub: the devices() + customEntities() methods the provider
 *  needs. Test devices carry no actuator custom entities, so `customEntities`
 *  returns `[]` (actuator specs derive only from custom entities). */
interface FakeFacade {
  devices(): FakeDevice[]
  customEntities(): readonly never[]
}

/** The registry of one running CCU integration, `int_1`, serving `facade`. */
function registryOf(facade: HmAdoptionFacade): HmAdoptionProviderDeps['registry'] {
  return {
    getFacade: (id: string) => (id === 'int_1' ? facade : null),
    list: () => ['int_1'],
    has: (id: string) => id === 'int_1',
    getName: (id: string) => (id === 'int_1' ? 'Casa CCU' : null),
  }
}

function makeRegistry(devices: FakeDevice[]): HmAdoptionProviderDeps['registry'] {
  const facade: FakeFacade = { devices: () => devices, customEntities: () => [] }
  return registryOf(facade)
}

// ---------------------------------------------------------------------------
// Dep builder
// ---------------------------------------------------------------------------

type AdoptedEntry = { readonly id: number; readonly config: Record<string, unknown> }

/** Default adoptDevice result for tests that don't override it. */
const DEFAULT_ADOPT_RESULT = { deviceId: 100, accessoryDeviceIds: [] as readonly number[] } as const

function makeDeps(
  devices: FakeDevice[] = [switchDev, thermoDev],
  adopted: AdoptedEntry[] = [],
  overrides: Partial<
    Pick<
      HmAdoptionProviderDeps,
      | 'adoptGateway'
      | 'adoptDevice'
      | 'adoptStandaloneEntity'
      | 'removeDevice'
      | 'findDeviceConfig'
      | 'listLocations'
      | 'assignLocation'
    >
  > = {},
): HmAdoptionProviderDeps {
  return {
    registry: makeRegistry(devices),
    isOnline: () => true,
    listAdopted: vi.fn(async () => adopted),
    adoptGateway: overrides.adoptGateway ?? vi.fn(async () => ({ deviceId: 50 })),
    adoptDevice: overrides.adoptDevice ?? vi.fn(async () => DEFAULT_ADOPT_RESULT),
    adoptStandaloneEntity:
      overrides.adoptStandaloneEntity ?? vi.fn(async () => ({ deviceId: 800 })),
    removeDevice: overrides.removeDevice ?? vi.fn(async () => undefined),
    findDeviceConfig: overrides.findDeviceConfig ?? vi.fn(async () => null),
    ...(overrides.listLocations !== undefined ? { listLocations: overrides.listLocations } : {}),
    ...(overrides.assignLocation !== undefined ? { assignLocation: overrides.assignLocation } : {}),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listCandidateFilters', () => {
  it('returns BOTH the default devices filter and the entities filter', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const { filters } = await provider.listCandidateFilters({ integrationId: 'int_1' })
    expect(filters).toHaveLength(2)
    expect(filters[0]).toMatchObject({ id: 'devices', label: 'Devices', isDefault: true })
    expect(filters[1]).toMatchObject({ id: 'entities', label: 'Entities' })
    expect(filters[1]?.isDefault).toBeUndefined()
  })
})

describe('listCandidates', () => {
  it('returns mapped candidates with correct totalCount and pagination', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
    })
    // The CCU box, plus switchDev and thermoDev (genericDev is filtered by buildHmCandidates)
    expect(result.totalCount).toBe(3)
    expect(result.candidates).toHaveLength(3)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(50)
  })

  it('paginates correctly — page 2 with pageSize 1', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 2,
      pageSize: 1,
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.totalCount).toBe(3)
    expect(result.page).toBe(2)
  })

  it('reflects alreadyAdopted=true when system+integrationId+hmAddress match', async () => {
    const adopted: AdoptedEntry[] = [
      {
        id: 42,
        config: { system: 'homematic', integrationId: 'int_1', hmAddress: 'ABC0001' },
      },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], adopted))
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
    })
    const found = result.candidates.find((c) => c.childNativeId === 'int_1:device:ABC0001')
    expect(found?.alreadyAdopted).toBe(true)
    expect(found?.adoptedDeviceId).toBe(42)
  })

  it('alreadyAdopted=false when the device belongs to another integration', async () => {
    const adopted: AdoptedEntry[] = [
      {
        id: 42,
        config: { system: 'homematic', integrationId: 'int_2', hmAddress: 'ABC0001' },
      },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], adopted))
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
    })
    const found = result.candidates.find((c) => c.childNativeId === 'int_1:device:ABC0001')
    expect(found?.alreadyAdopted).toBe(false)
  })

  it('filterText.search narrows by name (case-insensitive)', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filterText: { search: 'living' },
    })
    expect(result.totalCount).toBe(1)
    expect(result.candidates[0]?.childNativeId).toBe('int_1:device:ABC0001')
  })

  it('filterText.search narrows by model', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filterText: { search: 'WTH-2' },
    })
    expect(result.totalCount).toBe(1)
    expect(result.candidates[0]?.childNativeId).toBe('int_1:device:ABC0002')
  })

  it('filterText.search narrows by childNativeId', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filterText: { search: 'ABC0002' },
    })
    expect(result.totalCount).toBe(1)
    expect(result.candidates[0]?.childNativeId).toBe('int_1:device:ABC0002')
  })

  it('filterText.unadoptedOnly excludes adopted candidates', async () => {
    const adopted: AdoptedEntry[] = [
      {
        id: 99,
        config: { system: 'homematic', integrationId: 'int_1', hmAddress: 'ABC0001' },
      },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev, thermoDev], adopted))
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filterText: { unadoptedOnly: true },
    })
    expect(result.candidates.every((c) => !c.alreadyAdopted)).toBe(true)
    // the CCU box and the thermostat
    expect(result.totalCount).toBe(2)
  })

  it('filterText.adoptedOnly includes only adopted candidates', async () => {
    const adopted: AdoptedEntry[] = [
      {
        id: 99,
        config: { system: 'homematic', integrationId: 'int_1', hmAddress: 'ABC0001' },
      },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev, thermoDev], adopted))
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filterText: { adoptedOnly: true },
    })
    expect(result.candidates.every((c) => c.alreadyAdopted)).toBe(true)
    expect(result.totalCount).toBe(1)
  })
})

describe('getCandidate', () => {
  it('returns the matching candidate by childNativeId', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const cand = await provider.getCandidate({
      integrationId: 'int_1',
      childNativeId: 'int_1:device:ABC0002',
    })
    expect(cand).not.toBeNull()
    expect(cand?.childNativeId).toBe('int_1:device:ABC0002')
    expect(cand?.name).toBe('Hallway Thermostat')
  })

  it('returns null when childNativeId is not found', async () => {
    const provider = buildHmAdoptionProvider(makeDeps())
    const cand = await provider.getCandidate({
      integrationId: 'int_1',
      childNativeId: 'int_1:device:UNKNOWN',
    })
    expect(cand).toBeNull()
  })
})

describe('getStatus', () => {
  it('aggregates candidateCount and adoptedCount across all integrations', async () => {
    const adopted: AdoptedEntry[] = [
      { id: 1, config: { system: 'homematic', integrationId: 'int_1', hmAddress: 'ABC0001' } },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev, thermoDev], adopted))
    const status = await provider.getStatus({ deviceId: 0 })

    expect(status).not.toBeNull()
    // the CCU box + switchDev + thermoDev; genericDev is excluded
    expect(status?.candidateCount).toBe(3)
    // 1 device with system=homematic
    expect(status?.adoptedCount).toBe(1)
    expect(typeof status?.lastDiscoveryAt).toBe('number')
    expect(status?.lastError).toBeNull()
  })

  it('excludes non-homematic entries from adoptedCount', async () => {
    const adopted: AdoptedEntry[] = [
      { id: 1, config: { system: 'mqtt', integrationId: 'int_1', hmAddress: 'ABC0001' } },
      { id: 2, config: { system: 'homematic', integrationId: 'int_1', hmAddress: 'ABC0002' } },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], adopted))
    const status = await provider.getStatus({ deviceId: 0 })
    expect(status?.adoptedCount).toBe(1)
  })
})

describe('refresh', () => {
  it('returns status scoped to the integration', async () => {
    const adopted: AdoptedEntry[] = [
      { id: 1, config: { system: 'homematic', integrationId: 'int_1', hmAddress: 'ABC0001' } },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev, thermoDev], adopted))
    const status = await provider.refresh({ integrationId: 'int_1' })
    expect(status.candidateCount).toBe(3)
    expect(status.adoptedCount).toBe(1)
    expect(status.lastError).toBeNull()
    expect(typeof status.lastDiscoveryAt).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Write side: adopt / release / resync
// ---------------------------------------------------------------------------

describe('adopt', () => {
  it('adopts 2 addresses, calls adoptDevice with correct args, returns entries', async () => {
    let callCount = 0
    const adoptDevice = vi.fn(
      async (_input: Parameters<HmAdoptionProviderDeps['adoptDevice']>[0]) => {
        callCount++
        return { deviceId: 100 + callCount, accessoryDeviceIds: [] as readonly number[] }
      },
    )
    const provider = buildHmAdoptionProvider(makeDeps([switchDev, thermoDev], [], { adoptDevice }))

    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:device:ABC0001', 'int_1:device:ABC0002'],
      perCandidate: { 'int_1:device:ABC0001': { name: 'My Switch' } },
    })

    expect(adoptDevice).toHaveBeenCalledTimes(2)

    // First call: switch with perCandidate name override
    expect(adoptDevice).toHaveBeenNthCalledWith(1, {
      hmAddress: 'ABC0001',
      integrationId: 'int_1',
      type: 'switch',
      name: 'My Switch',
    })

    // Second call: thermostat uses device.name (no override)
    expect(adoptDevice).toHaveBeenNthCalledWith(2, {
      hmAddress: 'ABC0002',
      integrationId: 'int_1',
      type: 'thermostat',
      name: 'Hallway Thermostat',
    })

    expect(result.adopted).toHaveLength(2)
    expect(result.adopted[0]).toMatchObject({
      childNativeId: 'int_1:device:ABC0001',
      parentDeviceId: 101,
      accessoryDeviceIds: [],
    })
    expect(result.adopted[1]).toMatchObject({
      childNativeId: 'int_1:device:ABC0002',
      parentDeviceId: 102,
      accessoryDeviceIds: [],
    })
  })

  it('returns the real accessoryDeviceIds the Container spawned (parent + children)', async () => {
    // The addon wires adoptDevice to create a Container and fetch its
    // auto-spawned accessory children; the provider must thread the returned
    // ids back verbatim onto the adopted entry.
    const adoptDevice = vi.fn(async () => ({
      deviceId: 700,
      accessoryDeviceIds: [701, 702, 703] as readonly number[],
    }))
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], [], { adoptDevice }))

    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:device:ABC0001'],
    })

    expect(result.adopted).toHaveLength(1)
    expect(result.adopted[0]).toMatchObject({
      childNativeId: 'int_1:device:ABC0001',
      parentDeviceId: 700,
      accessoryDeviceIds: [701, 702, 703],
    })
  })

  it('skips an unknown address but adopts the known one (partial success)', async () => {
    const adoptDevice = vi.fn(async () => ({
      deviceId: 200,
      accessoryDeviceIds: [] as readonly number[],
    }))
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], [], { adoptDevice }))

    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:device:UNKNOWN_ADDR', 'int_1:device:ABC0001'],
    })

    expect(adoptDevice).toHaveBeenCalledTimes(1)
    expect(result.adopted).toHaveLength(1)
    expect(result.adopted[0]?.childNativeId).toBe('int_1:device:ABC0001')
  })

  it('throws when ALL addresses fail (unknown addresses)', async () => {
    const provider = buildHmAdoptionProvider(makeDeps([switchDev]))
    await expect(
      provider.adopt({
        integrationId: 'int_1',
        childNativeIds: ['int_1:device:UNKNOWN_1', 'int_1:device:UNKNOWN_2'],
      }),
    ).rejects.toThrow('homematic adopt: all 2 adopt(s) failed')
  })

  it('throws when ALL addresses fail (adoptDevice throws)', async () => {
    const adoptDevice = vi.fn(async () => {
      throw new Error('kernel error')
    })
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], [], { adoptDevice }))
    await expect(
      provider.adopt({ integrationId: 'int_1', childNativeIds: ['int_1:device:ABC0001'] }),
    ).rejects.toThrow('homematic adopt: all 1 adopt(s) failed')
  })

  it('skips a Generic-type device (no supported channels)', async () => {
    const adoptDevice = vi.fn(async () => ({
      deviceId: 300,
      accessoryDeviceIds: [] as readonly number[],
    }))
    const provider = buildHmAdoptionProvider(makeDeps([genericDev], [], { adoptDevice }))
    await expect(
      provider.adopt({ integrationId: 'int_1', childNativeIds: ['int_1:device:ABC0098'] }),
    ).rejects.toThrow('homematic adopt: all 1 adopt(s) failed')
    expect(adoptDevice).not.toHaveBeenCalled()
  })

  it('adopts a key/remote device as an EventEmitter (only Generic is skipped)', async () => {
    const adoptDevice = vi.fn(async () => ({
      deviceId: 301,
      accessoryDeviceIds: [] as readonly number[],
    }))
    const provider = buildHmAdoptionProvider(makeDeps([remoteDev], [], { adoptDevice }))
    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:device:ABC0003'],
    })
    expect(adoptDevice).toHaveBeenCalledTimes(1)
    expect(adoptDevice).toHaveBeenCalledWith({
      hmAddress: 'ABC0003',
      integrationId: 'int_1',
      type: 'event-emitter',
      name: 'Remote',
    })
    expect(result.adopted).toHaveLength(1)
    expect(result.adopted[0]?.childNativeId).toBe('int_1:device:ABC0003')
  })

  it('throws when the integration has no running session', async () => {
    const deps = makeDeps([switchDev])
    // Override registry to always return null facade
    const provider = buildHmAdoptionProvider({
      ...deps,
      registry: {
        getFacade: (_id: string) => null,
        list: () => [],
        has: () => false,
        getName: () => null,
      },
    })
    await expect(
      provider.adopt({ integrationId: 'int_1', childNativeIds: ['int_1:device:ABC0001'] }),
    ).rejects.toThrow('homematic adopt: integration int_1 is not running')
  })

  it('imports the device room as a location when importLocations is true', async () => {
    const adoptDevice = vi.fn(async () => ({
      deviceId: 500,
      accessoryDeviceIds: [] as readonly number[],
    }))
    const listLocations = vi.fn(async (): Promise<readonly string[]> => [])
    const assignLocation = vi.fn(
      async (
        _deviceId: number,
        _externalLocation: string,
        _known: readonly string[],
      ): Promise<readonly string[]> => ['Hall'],
    )
    const provider = buildHmAdoptionProvider(
      makeDeps([roomedDev], [], { adoptDevice, listLocations, assignLocation }),
    )

    await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:device:ABC0010'],
      importLocations: true,
    })

    expect(listLocations).toHaveBeenCalledOnce()
    expect(assignLocation).toHaveBeenCalledOnce()
    expect(assignLocation).toHaveBeenCalledWith(500, 'Hall', [])
  })

  it('does NOT import a location when importLocations is absent', async () => {
    const adoptDevice = vi.fn(async () => ({
      deviceId: 501,
      accessoryDeviceIds: [] as readonly number[],
    }))
    const listLocations = vi.fn(async (): Promise<readonly string[]> => [])
    const assignLocation = vi.fn(
      async (
        _deviceId: number,
        _externalLocation: string,
        known: readonly string[],
      ): Promise<readonly string[]> => known,
    )
    const provider = buildHmAdoptionProvider(
      makeDeps([roomedDev], [], { adoptDevice, listLocations, assignLocation }),
    )

    await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:device:ABC0010'],
    })

    expect(listLocations).not.toHaveBeenCalled()
    expect(assignLocation).not.toHaveBeenCalled()
  })

  it('skips location import for a device that has no room', async () => {
    const adoptDevice = vi.fn(async () => ({
      deviceId: 502,
      accessoryDeviceIds: [] as readonly number[],
    }))
    const listLocations = vi.fn(async (): Promise<readonly string[]> => [])
    const assignLocation = vi.fn(
      async (
        _deviceId: number,
        _externalLocation: string,
        known: readonly string[],
      ): Promise<readonly string[]> => known,
    )
    const provider = buildHmAdoptionProvider(
      makeDeps([switchDev], [], { adoptDevice, listLocations, assignLocation }),
    )

    await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:device:ABC0001'],
      importLocations: true,
    })

    // Registry is still fetched once, but no room → no assignLocation call.
    expect(listLocations).toHaveBeenCalledOnce()
    expect(assignLocation).not.toHaveBeenCalled()
  })
})

describe('release', () => {
  it('calls removeDevice with the given camDeviceId', async () => {
    const removeDevice = vi.fn(async (_id: number) => undefined)
    const provider = buildHmAdoptionProvider(makeDeps([], [], { removeDevice }))
    await provider.release({ integrationId: 'int_1', camDeviceId: 42 })
    expect(removeDevice).toHaveBeenCalledOnce()
    expect(removeDevice).toHaveBeenCalledWith(42)
  })
})

describe('resync', () => {
  it('returns {changed:false, rebuiltChildren:0} when device + live HmDevice exist', async () => {
    const findDeviceConfig = vi.fn(async (_id: number) => ({
      system: 'homematic',
      integrationId: 'int_1',
      hmAddress: 'ABC0001',
    }))
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], [], { findDeviceConfig }))
    const result = await provider.resync({ camDeviceId: 77 })
    expect(result).toEqual({ changed: false, rebuiltChildren: 0 })
  })

  it('throws when device config is not found', async () => {
    const findDeviceConfig = vi.fn(async (_id: number) => null)
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], [], { findDeviceConfig }))
    await expect(provider.resync({ camDeviceId: 99 })).rejects.toThrow(
      'homematic resync: device 99 not found',
    )
  })

  it('throws when config.system is not homematic', async () => {
    const findDeviceConfig = vi.fn(async (_id: number) => ({
      system: 'mqtt',
      integrationId: 'int_1',
      hmAddress: 'ABC0001',
    }))
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], [], { findDeviceConfig }))
    await expect(provider.resync({ camDeviceId: 55 })).rejects.toThrow(
      'homematic resync: device 55 is not a Homematic device',
    )
  })

  it('throws when the live HmDevice is gone from the CCU', async () => {
    const findDeviceConfig = vi.fn(async (_id: number) => ({
      system: 'homematic',
      integrationId: 'int_1',
      hmAddress: 'REMOVED_DEVICE',
    }))
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], [], { findDeviceConfig }))
    await expect(provider.resync({ camDeviceId: 11 })).rejects.toThrow(
      'homematic resync: device REMOVED_DEVICE no longer present on integration int_1',
    )
  })
})

// ---------------------------------------------------------------------------
// Entities granularity (filter: 'entities')
// ---------------------------------------------------------------------------

const ENTITY_ADDR = 'ENT0001'

/** A switch device with a MAINTENANCE channel (voltage diagnostic) + firmware
 *  descriptor + one switch custom entity. Yields: act-<chan> + maint-voltage +
 *  update entity specs. */
const entityRichDevice = {
  address: ENTITY_ADDR,
  type: 'HmIP-BSM',
  name: 'Living Switch',
  rooms: ['Hall'],
  firmware: '1.0.0',
  updatable: true,
  channels: [
    { address: `${ENTITY_ADDR}:3`, index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
    {
      address: `${ENTITY_ADDR}:0`,
      index: 0,
      type: 'MAINTENANCE',
      dataPoints: [
        {
          id: 'dp:low_bat',
          parameter: 'LOW_BAT',
          type: 'BOOL',
          value: false,
          readable: true,
          writable: false,
          hasEvents: true,
        },
        {
          id: 'dp:operating_voltage',
          parameter: 'OPERATING_VOLTAGE',
          type: 'FLOAT',
          value: 2.9,
          unit: 'V',
          readable: true,
          writable: false,
          hasEvents: true,
        },
      ],
    },
  ],
} as const

type EntityFakeDevice = typeof entityRichDevice

/** One switch custom entity for the rich device. Widened through `unknown` at
 *  this single boundary (the library's `HmSwitch` carries extra runtime fields
 *  the spec derivation never reads), mirroring the container test convention. */
function switchCustomEntity(): HmCustomEntity {
  return {
    kind: 'switch',
    device: ENTITY_ADDR,
    channel: `${ENTITY_ADDR}:3`,
  } as unknown as HmCustomEntity
}

/** Registry whose facade also returns the device's switch custom entity. */
function makeEntityRegistry(
  devices: EntityFakeDevice[],
  customEntities: HmCustomEntity[],
): HmAdoptionProviderDeps['registry'] {
  return registryOf({ devices: () => devices, customEntities: () => customEntities })
}

function makeEntityDeps(
  adopted: AdoptedEntry[] = [],
  overrides: Partial<
    Pick<HmAdoptionProviderDeps, 'adoptStandaloneEntity' | 'listLocations' | 'assignLocation'>
  > = {},
): HmAdoptionProviderDeps {
  return {
    registry: makeEntityRegistry([entityRichDevice], [switchCustomEntity()]),
    isOnline: () => true,
    listAdopted: vi.fn(async () => adopted),
    adoptGateway: vi.fn(async () => ({ deviceId: 50 })),
    adoptDevice: vi.fn(async () => DEFAULT_ADOPT_RESULT),
    adoptStandaloneEntity:
      overrides.adoptStandaloneEntity ?? vi.fn(async () => ({ deviceId: 800 })),
    removeDevice: vi.fn(async () => undefined),
    findDeviceConfig: vi.fn(async () => null),
    ...(overrides.listLocations !== undefined ? { listLocations: overrides.listLocations } : {}),
    ...(overrides.assignLocation !== undefined ? { assignLocation: overrides.assignLocation } : {}),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  }
}

const ACT_NATIVE_ID = `int_1:entity:${ENTITY_ADDR}#act-${ENTITY_ADDR}:3`
const VOLTAGE_NATIVE_ID = `int_1:entity:${ENTITY_ADDR}#maint-voltage`
const UPDATE_NATIVE_ID = `int_1:entity:${ENTITY_ADDR}#update`

describe('listCandidates (entities granularity)', () => {
  it('returns a FLAT per-entity candidate list — one per derived spec', async () => {
    const provider = buildHmAdoptionProvider(makeEntityDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filter: 'entities',
    })
    const ids = result.candidates.map((c) => c.childNativeId)
    // Switch actuator + voltage diagnostic + firmware update (no sensor — the
    // switch channel is an actuator cap, skipped in the sensor loop).
    expect(ids).toContain(ACT_NATIVE_ID)
    expect(ids).toContain(VOLTAGE_NATIVE_ID)
    expect(ids).toContain(UPDATE_NATIVE_ID)
    expect(result.totalCount).toBe(3)
    // Candidates are flat (no children).
    expect(result.candidates.every((c) => c.children === undefined)).toBe(true)
  })

  it('carries the spec deviceType + capabilities + composed name onto each candidate', async () => {
    const provider = buildHmAdoptionProvider(makeEntityDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filter: 'entities',
    })
    const act = result.candidates.find((c) => c.childNativeId === ACT_NATIVE_ID)
    expect(act?.type).toBe('switch')
    expect(act?.capabilities).toContain('switch')
    expect(act?.name).toContain('Living Switch')
  })

  it('marks alreadyAdopted by matching <hmAddress>#<hmEntityKey> on a standalone device', async () => {
    const adopted: AdoptedEntry[] = [
      {
        id: 55,
        config: {
          system: 'homematic',
          integrationId: 'int_1',
          hmAddress: ENTITY_ADDR,
          hmEntityKey: 'maint-voltage',
        },
      },
    ]
    const provider = buildHmAdoptionProvider(makeEntityDeps(adopted))
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filter: 'entities',
    })
    const voltage = result.candidates.find((c) => c.childNativeId === VOLTAGE_NATIVE_ID)
    expect(voltage?.alreadyAdopted).toBe(true)
    expect(voltage?.adoptedDeviceId).toBe(55)
    // A Container adoption (no hmEntityKey) does NOT mark an entity adopted.
    const act = result.candidates.find((c) => c.childNativeId === ACT_NATIVE_ID)
    expect(act?.alreadyAdopted).toBe(false)
  })

  it('does NOT mark an entity adopted from a Container row (no hmEntityKey)', async () => {
    const adopted: AdoptedEntry[] = [
      { id: 9, config: { system: 'homematic', integrationId: 'int_1', hmAddress: ENTITY_ADDR } },
    ]
    const provider = buildHmAdoptionProvider(makeEntityDeps(adopted))
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
      filter: 'entities',
    })
    expect(result.candidates.every((c) => !c.alreadyAdopted)).toBe(true)
  })

  it('default (devices) filter still returns device candidates', async () => {
    const provider = buildHmAdoptionProvider(makeEntityDeps())
    const result = await provider.listCandidates({
      integrationId: 'int_1',
      page: 1,
      pageSize: 50,
    })
    // The CCU box first, then ONE device candidate, namespaced under the integration.
    expect(result.candidates.map((c) => c.childNativeId)).toEqual([
      'int_1:gateway',
      `int_1:device:${ENTITY_ADDR}`,
    ])
  })
})

describe('adopt (entities granularity)', () => {
  it('calls adoptStandaloneEntity per entity with the spec-derived args + entity marker config', async () => {
    const adoptStandaloneEntity = vi.fn(
      async (_input: Parameters<HmAdoptionProviderDeps['adoptStandaloneEntity']>[0]) => ({
        deviceId: 900,
      }),
    )
    const provider = buildHmAdoptionProvider(makeEntityDeps([], { adoptStandaloneEntity }))

    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: [ACT_NATIVE_ID, VOLTAGE_NATIVE_ID],
      filter: 'entities',
    })

    expect(adoptStandaloneEntity).toHaveBeenCalledTimes(2)

    const firstArg = adoptStandaloneEntity.mock.calls[0]?.[0]
    expect(firstArg?.hmAddress).toBe(ENTITY_ADDR)
    expect(firstArg?.key).toBe(`act-${ENTITY_ADDR}:3`)
    expect(firstArg?.integrationId).toBe('int_1')
    expect('brokerId' in (firstArg ?? {})).toBe(false)
    expect(firstArg?.integrationId).toBe('int_1')
    expect(firstArg?.deviceType).toBe('switch')
    // Config carries the entity marker + provenance the alreadyAdopted scan reads.
    expect(firstArg?.config['system']).toBe('homematic')
    expect(firstArg?.config['integrationId']).toBe('int_1')
    expect(firstArg?.config['brokerId']).toBeUndefined()
    expect(firstArg?.config['hmAddress']).toBe(ENTITY_ADDR)
    expect(firstArg?.config['hmEntityKey']).toBe(`act-${ENTITY_ADDR}:3`)
    expect(firstArg?.config['address']).toBe(ENTITY_ADDR)

    expect(result.adopted).toHaveLength(2)
    expect(result.adopted[0]).toMatchObject({
      childNativeId: ACT_NATIVE_ID,
      parentDeviceId: 900,
      accessoryDeviceIds: [],
    })
  })

  it('skips an unknown entity key but adopts the known one (partial success)', async () => {
    const adoptStandaloneEntity = vi.fn(async () => ({ deviceId: 901 }))
    const provider = buildHmAdoptionProvider(makeEntityDeps([], { adoptStandaloneEntity }))
    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: [`int_1:entity:${ENTITY_ADDR}#nope`, UPDATE_NATIVE_ID],
      filter: 'entities',
    })
    expect(adoptStandaloneEntity).toHaveBeenCalledTimes(1)
    expect(result.adopted).toHaveLength(1)
    expect(result.adopted[0]?.childNativeId).toBe(UPDATE_NATIVE_ID)
  })

  it('throws when ALL entity ids fail', async () => {
    const provider = buildHmAdoptionProvider(makeEntityDeps())
    await expect(
      provider.adopt({
        integrationId: 'int_1',
        childNativeIds: [`int_1:entity:${ENTITY_ADDR}#nope`, 'int_1:entity:MISSING#act-x'],
        filter: 'entities',
      }),
    ).rejects.toThrow('homematic adopt: all 2 adopt(s) failed')
  })

  it('imports the device room as a location when importLocations is true', async () => {
    const adoptStandaloneEntity = vi.fn(async () => ({ deviceId: 902 }))
    const listLocations = vi.fn(async (): Promise<readonly string[]> => [])
    const assignLocation = vi.fn(
      async (_d: number, _l: string, _k: readonly string[]): Promise<readonly string[]> => ['Hall'],
    )
    const provider = buildHmAdoptionProvider(
      makeEntityDeps([], { adoptStandaloneEntity, listLocations, assignLocation }),
    )
    await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: [ACT_NATIVE_ID],
      filter: 'entities',
      importLocations: true,
    })
    expect(assignLocation).toHaveBeenCalledWith(902, 'Hall', [])
  })
})

// ---------------------------------------------------------------------------
// The CCU box (Gateway)
// ---------------------------------------------------------------------------

describe('the CCU box as a Gateway', () => {
  it('is the first candidate, a Gateway named after the integration, offering only the WebUI link', async () => {
    const provider = buildHmAdoptionProvider(makeDeps([switchDev]))
    const result = await provider.listCandidates({ integrationId: 'int_1', page: 1, pageSize: 50 })
    const [first, second] = result.candidates
    expect(first).toMatchObject({
      childNativeId: 'int_1:gateway',
      type: 'gateway',
      name: 'Casa CCU',
      status: 'online',
      capabilities: ['device-admin-link'],
    })
    expect(second?.childNativeId).toBe('int_1:device:ABC0001')
  })

  it('reports the box offline while its session is down', async () => {
    const provider = buildHmAdoptionProvider({ ...makeDeps([switchDev]), isOnline: () => false })
    const cand = await provider.getCandidate({
      integrationId: 'int_1',
      childNativeId: 'int_1:gateway',
    })
    expect(cand?.status).toBe('offline')
  })

  it('is marked adopted from a gateway row, and a gateway row does not mark any product adopted', async () => {
    const adopted: AdoptedEntry[] = [
      {
        id: 61,
        config: { system: 'homematic', integrationId: 'int_1', nativeId: 'int_1:gateway' },
      },
    ]
    const provider = buildHmAdoptionProvider(makeDeps([switchDev], adopted))
    const result = await provider.listCandidates({ integrationId: 'int_1', page: 1, pageSize: 50 })
    expect(result.candidates.find((c) => c.childNativeId === 'int_1:gateway')).toMatchObject({
      alreadyAdopted: true,
      adoptedDeviceId: 61,
    })
    expect(
      result.candidates.find((c) => c.childNativeId === 'int_1:device:ABC0001')?.alreadyAdopted,
    ).toBe(false)
  })

  it('adopts the box through adoptGateway, as a sibling with no accessories', async () => {
    const adoptGateway = vi.fn(
      async (_input: Parameters<HmAdoptionProviderDeps['adoptGateway']>[0]) => ({ deviceId: 70 }),
    )
    const adoptDevice = vi.fn(async () => DEFAULT_ADOPT_RESULT)
    const provider = buildHmAdoptionProvider(
      makeDeps([switchDev], [], { adoptGateway, adoptDevice }),
    )
    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:gateway'],
    })
    expect(adoptGateway).toHaveBeenCalledWith({
      integrationId: 'int_1',
      nativeId: 'int_1:gateway',
      name: 'Casa CCU',
    })
    expect(adoptDevice).not.toHaveBeenCalled()
    expect(result.adopted).toEqual([
      { childNativeId: 'int_1:gateway', parentDeviceId: 70, accessoryDeviceIds: [] },
    ])
  })

  it('adopts the box and a product in one call, both top-level', async () => {
    const provider = buildHmAdoptionProvider(makeDeps([switchDev]))
    const result = await provider.adopt({
      integrationId: 'int_1',
      childNativeIds: ['int_1:gateway', 'int_1:device:ABC0001'],
    })
    expect(result.adopted.map((a) => a.childNativeId)).toEqual([
      'int_1:gateway',
      'int_1:device:ABC0001',
    ])
  })

  it('resync of the box has nothing to re-derive and does not look for an address', async () => {
    const findDeviceConfig = vi.fn(async (_id: number) => ({
      system: 'homematic',
      integrationId: 'int_1',
      nativeId: 'int_1:gateway',
    }))
    const provider = buildHmAdoptionProvider(makeDeps([], [], { findDeviceConfig }))
    expect(await provider.resync({ camDeviceId: 70 })).toEqual({
      changed: false,
      rebuiltChildren: 0,
    })
  })
})

describe('refusals are logged', () => {
  it('warns on a malformed or foreign native id and on a missing device', async () => {
    const deps = makeDeps([switchDev])
    const provider = buildHmAdoptionProvider(deps)
    await expect(
      provider.adopt({
        integrationId: 'int_1',
        childNativeIds: ['ABC0001', 'int_2:device:ABC0001', 'int_1:device:NOPE'],
      }),
    ).rejects.toThrow('all 3 adopt(s) failed')
    const messages = vi.mocked(deps.logger.warn).mock.calls.map((c) => c[0])
    expect(messages.filter((m) => m.includes('malformed or foreign'))).toHaveLength(2)
    expect(messages.filter((m) => m.includes('device not found'))).toHaveLength(1)
  })

  it('warns when the integration is not running', async () => {
    const deps = makeDeps([switchDev])
    const provider = buildHmAdoptionProvider({
      ...deps,
      registry: { ...deps.registry, has: () => false },
    })
    await expect(
      provider.adopt({ integrationId: 'int_1', childNativeIds: ['int_1:gateway'] }),
    ).rejects.toThrow('not running')
    expect(vi.mocked(deps.logger.warn).mock.calls.some((c) => c[0].includes('not running'))).toBe(
      true,
    )
  })
})
