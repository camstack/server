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
} from '@dominevo/types'
import { normaliseIdentifiers } from '@dominevo/types'
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

async function registered(world: World, stableId: string, owner = OWNER): Promise<FakeDevice> {
  const dev = new FakeDevice(stableId)
  world.registry.register(owner, asDevice(dev))
  await world.provider.allocateDeviceId({ addonId: owner, stableId })
  await world.provider.registerDevice({
    addonId: owner,
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

  it('projects the stored declaration on loadMeta too', async () => {
    const world = await setup()
    const dev = await registered(world, 'cam-1')
    await world.provider.setIdentifiers(stamped({ deviceId: dev.id, identifiers: DECLARED }, OWNER))
    expect((await world.provider.loadMeta({ deviceId: dev.id }))?.identifiers).toEqual(DECLARED)
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

describe('setAttachedIdentifiers (D1063)', () => {
  const PORT_OWNER = 'provider-switch'
  const CLIENT: DeviceIdentifiers = normaliseIdentifiers(
    { mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.7' },
    { readAt: 1 },
  ).identifiers

  it('writes its own column: the device identifiers stay untouched', async () => {
    const world = await setup()
    const dev = await registered(world, 'port-1', PORT_OWNER)
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: dev.id, identifiers: CLIENT }, PORT_OWNER),
    )
    const row = await readDeviceRow(world.store, dev.id)
    expect(row.attachedIdentifiers).toEqual(CLIENT)
    expect(row.identifiers ?? null).toBeNull()
    expect((await world.provider.getDevice({ deviceId: dev.id }))?.attachedIdentifiers).toEqual(
      CLIENT,
    )
  })

  it('keeps the stored client MAC when this read could not see one (unread)', async () => {
    const world = await setup()
    const dev = await registered(world, 'port-2', PORT_OWNER)
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: dev.id, identifiers: CLIENT }, PORT_OWNER),
    )
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: dev.id, identifiers: {}, unread: ['mac', 'ip'] }, PORT_OWNER),
    )
    expect((await readDeviceRow(world.store, dev.id)).attachedIdentifiers).toEqual(CLIENT)
  })

  it('a kept (unread) client is stored as RETAINED, and a fresh read clears that', async () => {
    const world = await setup()
    const dev = await registered(world, 'port-r', PORT_OWNER)
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: dev.id, identifiers: CLIENT }, PORT_OWNER),
    )
    expect((await readDeviceRow(world.store, dev.id)).attachedRetained ?? null).toBeNull()
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: dev.id, identifiers: {}, unread: ['mac', 'ip'] }, PORT_OWNER),
    )
    expect((await readDeviceRow(world.store, dev.id)).attachedRetained).toEqual(['ip', 'mac'])
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: dev.id, identifiers: CLIENT }, PORT_OWNER),
    )
    expect((await readDeviceRow(world.store, dev.id)).attachedRetained ?? null).toBeNull()
  })

  it('a camera moved from port 7 to port 9: the port that only RETAINS its MAC loses the link, the fresh port takes it', async () => {
    const world = await setup()
    const camera = await registered(world, 'cam-moved')
    await world.provider.setIdentifiers(
      stamped({ deviceId: camera.id, identifiers: CLIENT }, OWNER),
    )
    const port7 = await registered(world, 'port-7', PORT_OWNER)
    const port9 = await registered(world, 'port-9', PORT_OWNER)
    await world.provider.setRole({ deviceId: port7.id, role: 'poe-port' })
    await world.provider.setRole({ deviceId: port9.id, role: 'poe-port' })
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: port7.id, identifiers: CLIENT }, PORT_OWNER),
    )
    const linksOf = async () => {
      const read = await world.provider.listIdentityLinks({ deviceId: camera.id })
      return read.status === 'answered' ? read.links.map((l) => [l.a.deviceId, l.state]) : []
    }
    await vi.waitFor(async () => expect(await linksOf()).toEqual([[port7.id, 'linked']]))
    // Port 7 has no client now: it keeps the MAC, unread. Port 9 reads it fresh.
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: port7.id, identifiers: {}, unread: ['mac', 'ip'] }, PORT_OWNER),
    )
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: port9.id, identifiers: CLIENT }, PORT_OWNER),
    )
    await vi.waitFor(async () => expect(await linksOf()).toEqual([[port9.id, 'linked']]))
  })

  it('two ports that both FRESHLY report the camera stay a proposal; the first link is kept', async () => {
    const world = await setup()
    const camera = await registered(world, 'cam-twice')
    await world.provider.setIdentifiers(
      stamped({ deviceId: camera.id, identifiers: CLIENT }, OWNER),
    )
    const port7 = await registered(world, 'port-7b', PORT_OWNER)
    const port9 = await registered(world, 'port-9b', PORT_OWNER)
    await world.provider.setRole({ deviceId: port7.id, role: 'poe-port' })
    await world.provider.setRole({ deviceId: port9.id, role: 'poe-port' })
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: port7.id, identifiers: CLIENT }, PORT_OWNER),
    )
    const linksOf = async () => {
      const read = await world.provider.listIdentityLinks({ deviceId: camera.id })
      return read.status === 'answered'
        ? read.links.map((l) => [l.a.deviceId, l.state]).sort((x, y) => Number(x[0]) - Number(y[0]))
        : []
    }
    await vi.waitFor(async () => expect(await linksOf()).toEqual([[port7.id, 'linked']]))
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: port9.id, identifiers: CLIENT }, PORT_OWNER),
    )
    await vi.waitFor(async () =>
      expect(await linksOf()).toEqual([
        [port7.id, 'linked'],
        [port9.id, 'proposed'],
      ]),
    )
  })

  it('a port whose client is a camera of another integration links them, and the link answers', async () => {
    const world = await setup()
    const camera = await registered(world, 'cam-link')
    await world.provider.setIdentifiers(
      stamped({ deviceId: camera.id, identifiers: CLIENT }, OWNER),
    )
    const port = await registered(world, 'port-3', PORT_OWNER)
    await world.provider.setRole({ deviceId: port.id, role: 'poe-port' })
    await world.provider.setAttachedIdentifiers(
      stamped({ deviceId: port.id, identifiers: CLIENT }, PORT_OWNER),
    )
    await vi.waitFor(async () => {
      const read = await world.provider.listIdentityLinks({ deviceId: camera.id })
      expect(read.status === 'answered' ? read.links.map((l) => [l.kind, l.state]) : []).toEqual([
        ['poe-power', 'linked'],
      ])
    })
  })
})
