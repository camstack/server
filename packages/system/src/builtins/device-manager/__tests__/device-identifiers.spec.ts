/**
 * `device-manager.setIdentifiers` (D1059) on the REAL SQLite settings backend:
 *   - the owning provider (transport stamp = row addonId) writes, getDevice projects it
 *   - an unstamped (operator) call and another addon's call are refused, row untouched
 *   - re-registration preserves it; `null` clears it
 *   - a later boot re-reading the same values (production normalisation, a fresh
 *     `readAt`) writes and emits nothing and keeps the first `readAt`
 *   - a kind the provider could not read this time (`unread`) keeps its stored
 *     value; a kind it read and found absent is removed
 *   - a row written BEFORE the `identifiers` column existed survives the additive
 *     column (marked fields read back) and can then be declared on
 */

import type {
  AddonContext,
  DeviceIdentifiers,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { normaliseIdentifiers } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import {
  DEVICE_ROWS_COLLECTION,
  DEVICE_ROWS_COLUMNS,
  DEVICE_ROWS_INDEXES,
} from '../device-row-store.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi, readDeviceRow } from './settings-store-api.js'

const OWNER = 'provider-acme'

const DECLARED: DeviceIdentifiers = {
  mac: [{ value: 'aa:bb:cc:dd:ee:ff', origin: 'read', readAt: 1 }],
  serial: { value: 'acme:sn123', origin: 'read', readAt: 1 },
}

const SERIAL_ONLY = { value: 'acme:sn123', origin: 'read', readAt: 1 } as const

let fakeIdSeq = 700

class FakeDevice {
  online = true
  parentDeviceId: number | null = null
  features: readonly string[] = []
  type = 'sensor'
  name: string
  readonly id: number
  readonly config = {
    entries: () => [],
    get: () => undefined,
    set: vi.fn(async () => {}),
    setAll: vi.fn(async () => {}),
    onChange: () => () => {},
  }
  constructor(readonly stableId: string) {
    this.id = fakeIdSeq++
    this.name = stableId
  }
  removeDevice = vi.fn(async () => {})
}

function asDevice(d: FakeDevice): IDevice {
  return d as unknown as IDevice
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeSettings() {
  const addonStore: Record<string, unknown> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async () => ({})),
    writeDeviceStore: vi.fn(async () => {}),
    clearDeviceStore: vi.fn(async () => {}),
    readDeviceRuntimeState: vi.fn(async () => ({})),
    writeDeviceRuntimeState: vi.fn(async () => {}),
    clearDeviceRuntimeState: vi.fn(async () => {}),
  }
}

interface World {
  readonly provider: IDeviceManagerProvider
  readonly store: FakeSettingsStore
  readonly registry: DeviceRegistry
  readonly emit: ReturnType<typeof vi.fn>
}

async function setup(existing?: FakeSettingsStore): Promise<World> {
  const addon = new DeviceManagerAddon()
  const emit = vi.fn()
  const bus = { emit, subscribe: () => () => {}, getRecent: () => [] } as unknown as IEventBus
  const registry = new DeviceRegistry()
  const store = existing ?? (await makeSettingsStoreApi())
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: store.api },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings: makeSettings(),
    records,
    kernel: { deviceRegistry: registry },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')
  return { provider: first.provider as IDeviceManagerProvider, store, registry, emit }
}

async function registered(world: World, stableId: string): Promise<FakeDevice> {
  const dev = new FakeDevice(stableId)
  world.registry.register(OWNER, asDevice(dev))
  await world.provider.allocateDeviceId({ addonId: OWNER, stableId })
  await world.provider.registerDevice({
    addonId: OWNER,
    stableId,
    id: dev.id,
    type: 'sensor',
    name: stableId,
    parentDeviceId: null,
    config: {},
  })
  return dev
}

/** The input as the transport hands it to the provider: the caller stamp rides beside it. */
function stamped(
  input: Parameters<IDeviceManagerProvider['setIdentifiers']>[0],
  callerAddonId: string,
): Parameters<IDeviceManagerProvider['setIdentifiers']>[0] {
  const withStamp = { ...input, callerAddonId }
  return withStamp
}

function identifiersEvents(emit: ReturnType<typeof vi.fn>): unknown[] {
  return emit.mock.calls
    .map((c) => c[0] as { data?: { field?: string } })
    .filter((e) => e.data?.field === 'identifiers')
}

describe('setIdentifiers', () => {
  it('persists the owner declaration and projects it on getDevice', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-1')
    await world.provider.setIdentifiers(stamped({ deviceId: dev.id, identifiers: DECLARED }, OWNER))
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toEqual(DECLARED)
    expect((await world.provider.getDevice({ deviceId: dev.id }))?.identifiers).toEqual(DECLARED)
    expect(identifiersEvents(world.emit)).toHaveLength(1)
  })

  it('refuses an unstamped (operator) call and leaves the row untouched', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-2')
    await expect(
      world.provider.setIdentifiers({ deviceId: dev.id, identifiers: DECLARED }),
    ).rejects.toMatchObject({ reason: 'not-owner' })
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toBeNull()
  })

  it('refuses another addon', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-3')
    await expect(
      world.provider.setIdentifiers(
        stamped({ deviceId: dev.id, identifiers: DECLARED }, 'intruder'),
      ),
    ).rejects.toMatchObject({ reason: 'not-owner' })
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toBeNull()
  })

  it('refuses a declaration that is not normalised', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-4')
    // The type admits any string; only the schema knows the stored form.
    const raw: DeviceIdentifiers = {
      mac: [{ value: 'AA-BB-CC-DD-EE-FF', origin: 'read', readAt: 1 }],
    }
    await expect(
      world.provider.setIdentifiers(stamped({ deviceId: dev.id, identifiers: raw }, OWNER)),
    ).rejects.toMatchObject({ reason: 'invalid' })
  })

  it('survives a re-registration and clears on null', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-5')
    await world.provider.setIdentifiers(stamped({ deviceId: dev.id, identifiers: DECLARED }, OWNER))

    await world.provider.registerDevice({
      addonId: OWNER,
      stableId: 'cam-5',
      id: dev.id,
      type: 'sensor',
      name: 'renamed by the provider',
      parentDeviceId: null,
      config: {},
    })
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toEqual(DECLARED)

    await world.provider.setIdentifiers(stamped({ deviceId: dev.id, identifiers: null }, OWNER))
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toBeNull()
    expect((await world.provider.getDevice({ deviceId: dev.id }))?.identifiers).toBeUndefined()
  })
})

describe('setIdentifiers across boots', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** What a provider sends on a boot: production normalisation, the clock as it is. */
  function bootRead(mac: string | null, serial: string) {
    return normaliseIdentifiers({ mac, serial: { manufacturer: 'acme', serial } }).identifiers
  }

  it('a later boot re-reading the same values writes nothing, emits nothing, keeps the first readAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const world = await setup()
    const dev = await registered(world, 'cam-boot-1')
    await world.provider.setIdentifiers(
      stamped({ deviceId: dev.id, identifiers: bootRead('AA:BB:CC:DD:EE:FF', 'SN1') }, OWNER),
    )
    vi.setSystemTime(90_000)
    await world.provider.setIdentifiers(
      stamped({ deviceId: dev.id, identifiers: bootRead('aa-bb-cc-dd-ee-ff', 'sn1') }, OWNER),
    )
    expect(identifiersEvents(world.emit)).toHaveLength(1)
    const row = (await readDeviceRow(world.store, dev.id)).identifiers
    expect(row).toEqual({
      mac: [{ value: 'aa:bb:cc:dd:ee:ff', origin: 'read', readAt: 1_000 }],
      serial: { value: 'acme:sn1', origin: 'read', readAt: 1_000 },
    })
  })

  it('a changed value is written with the new readAt; unchanged kinds keep theirs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const world = await setup()
    const dev = await registered(world, 'cam-boot-2')
    await world.provider.setIdentifiers(
      stamped({ deviceId: dev.id, identifiers: bootRead('AA:BB:CC:DD:EE:FF', 'SN1') }, OWNER),
    )
    vi.setSystemTime(90_000)
    await world.provider.setIdentifiers(
      stamped({ deviceId: dev.id, identifiers: bootRead('AA:BB:CC:DD:EE:01', 'SN1') }, OWNER),
    )
    expect(identifiersEvents(world.emit)).toHaveLength(2)
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toEqual({
      mac: [{ value: 'aa:bb:cc:dd:ee:01', origin: 'read', readAt: 90_000 }],
      serial: { value: 'acme:sn1', origin: 'read', readAt: 1_000 },
    })
  })

  it('keeps the stored MAC when this boot could not read it (unread)', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-boot-3')
    await world.provider.setIdentifiers(stamped({ deviceId: dev.id, identifiers: DECLARED }, OWNER))
    await world.provider.setIdentifiers(
      stamped(
        {
          deviceId: dev.id,
          identifiers: { serial: { value: 'acme:sn123', origin: 'read', readAt: 2 } },
          unread: ['mac', 'ip'],
        },
        OWNER,
      ),
    )
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toEqual(DECLARED)
    expect(identifiersEvents(world.emit)).toHaveLength(1)
  })

  it('removes a kind the provider read and found absent', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-boot-4')
    await world.provider.setIdentifiers(stamped({ deviceId: dev.id, identifiers: DECLARED }, OWNER))
    await world.provider.setIdentifiers(
      stamped({ deviceId: dev.id, identifiers: { serial: SERIAL_ONLY } }, OWNER),
    )
    expect((await readDeviceRow(world.store, dev.id)).identifiers).toEqual({ serial: SERIAL_ONLY })
  })
})

describe('the identifiers column on a populated table', () => {
  it('keeps every row written before it existed, marked fields included', async () => {
    const store = await makeSettingsStoreApi()
    // The table as the previous release declared it: no `identifiers` column.
    await store.backend.declareCollection({
      collection: DEVICE_ROWS_COLLECTION,
      columns: DEVICE_ROWS_COLUMNS.filter((c) => c.name !== 'identifiers'),
      indexes: DEVICE_ROWS_INDEXES,
    })
    await store.backend.set({
      collection: DEVICE_ROWS_COLLECTION,
      key: '41',
      value: {
        id: '41',
        deviceId: 41,
        addonId: OWNER,
        stableId: 'old-cam',
        type: 'camera',
        name: 'MARKED-old-row',
        disabled: false,
        registered: true,
        metadata: { mac: 'AA:BB:CC:DD:EE:01', marker: 'kept' },
      },
    })

    const world = await setup(store)
    const before = await world.provider.getDevice({ deviceId: 41 })
    expect(before?.name).toBe('MARKED-old-row')
    expect(before?.metadata).toEqual({ mac: 'AA:BB:CC:DD:EE:01', marker: 'kept' })
    expect(before?.identifiers).toBeUndefined()

    await world.provider.setIdentifiers(stamped({ deviceId: 41, identifiers: DECLARED }, OWNER))
    const row = await readDeviceRow(store, 41)
    expect(row.name).toBe('MARKED-old-row')
    expect(row.metadata).toEqual({ mac: 'AA:BB:CC:DD:EE:01', marker: 'kept' })
    expect(row.identifiers).toEqual(DECLARED)
  })
})
