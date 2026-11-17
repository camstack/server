/**
 * D1059: the Unraid server declares its SMBIOS uuid, its physical NIC MACs and its
 * flash GUID (strong), its hostname and LAN IP (weak); a VM declares its domain
 * uuid. A failed `system.info()` or `server.info()` keeps what it would have
 * read (D49); a VM list that could not be read declares nothing. The writer
 * stores what `device-manager.setIdentifiers` would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { UnraidServerIdentity, UnraidVmInfo } from '../unraid-client-contract.js'
import { createLiveUnraidClient, type UnraidApiSource } from '../unraid-client-live.js'
import {
  type UnraidIdentifierDeclaration,
  unraidServerIdentifiers,
  unraidVmIdentifiers,
} from '../unraid-identifiers.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

interface StoredWorld {
  stored: DeviceIdentifiers | null
}

async function declare(
  world: StoredWorld,
  declaration: UnraidIdentifierDeclaration | null,
): Promise<void> {
  if (declaration === null) return
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 21, logger: quiet, writer }, declaration.identifiers, {
    unread: declaration.unread,
  })
}

const TOWER: UnraidServerIdentity = {
  systemRead: true,
  machineUuid: '4C4C4544-0042-3510-8051-B7C04F4E3732',
  macs: ['AC:1F:6B:00:00:01'],
  hostname: 'Tower.local',
  serverRead: true,
  flashGuid: '0781-5571-0000-123456789ABC',
  lanIp: '192.0.2.20',
}

describe('unraidServerIdentifiers', () => {
  it('declares the machine uuid, the NIC MAC, the flash GUID, the hostname and the LAN IP', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, unraidServerIdentifiers(TOWER))
    expect(world.stored?.['machine-uuid']?.value).toBe('4c4c4544-0042-3510-8051-b7c04f4e3732')
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['ac:1f:6b:00:00:01'])
    expect(world.stored?.['vendor-uid']?.value).toBe('unraid:0781-5571-0000-123456789abc')
    expect(world.stored?.hostname?.value).toBe('tower')
    expect(world.stored?.ip?.value).toBe('192.0.2.20')
  })

  it('a failed system and server read keeps every stored value', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, unraidServerIdentifiers(TOWER))
    await declare(
      world,
      unraidServerIdentifiers({
        systemRead: false,
        machineUuid: null,
        macs: [],
        hostname: null,
        serverRead: false,
        flashGuid: null,
        lanIp: null,
      }),
    )
    expect(world.stored?.['machine-uuid']?.value).toBe('4c4c4544-0042-3510-8051-b7c04f4e3732')
    expect(world.stored?.mac?.[0]?.value).toBe('ac:1f:6b:00:00:01')
    expect(world.stored?.['vendor-uid']?.value).toBe('unraid:0781-5571-0000-123456789abc')
    expect(world.stored?.ip?.value).toBe('192.0.2.20')
  })

  it('the well-known placeholder SMBIOS uuid of unbranded boards is never an identity', async () => {
    const world: StoredWorld = { stored: null }
    await declare(
      world,
      unraidServerIdentifiers({ ...TOWER, machineUuid: '03000200-0400-0500-0006-000700080009' }),
    )
    expect(world.stored?.['machine-uuid']).toBeUndefined()
  })

  it('no snapshot identity yet declares nothing', () => {
    expect(unraidServerIdentifiers(undefined)).toBeNull()
  })
})

describe('unraidVmIdentifiers', () => {
  const vm: UnraidVmInfo = {
    id: 'srv:5E0F6A3C-1B2D-4E5F-8A9B-0C1D2E3F4A5B',
    name: 'ha',
    state: 'running',
  }

  it('declares the domain uuid (the guest SMBIOS uuid) as the machine uuid', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, unraidVmIdentifiers(vm))
    expect(world.stored?.['machine-uuid']?.value).toBe('5e0f6a3c-1b2d-4e5f-8a9b-0c1d2e3f4a5b')
  })

  it('a VM the poll could not see declares nothing, so the stored uuid stays', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, unraidVmIdentifiers(vm))
    await declare(world, unraidVmIdentifiers(null))
    expect(world.stored?.['machine-uuid']?.value).toBe('5e0f6a3c-1b2d-4e5f-8a9b-0c1d2e3f4a5b')
  })
})

describe('the live client reads the identity', () => {
  function api(over: Pick<UnraidApiSource, 'system'> & Partial<UnraidApiSource>): UnraidApiSource {
    const never = async (): Promise<never> => {
      throw new Error('not used')
    }
    return {
      array: { get: never, setState: never, parity: { start: never, cancel: never } },
      docker: {
        list: never,
        start: never,
        stop: never,
        pause: never,
        unpause: never,
        stats$: async function* () {},
      },
      vms: {
        list: never,
        start: never,
        stop: never,
        pause: never,
        resume: never,
        forceStop: never,
        reboot: never,
      },
      notifications: { warningsAndAlerts: never },
      close: async () => undefined,
      endpoint: 'http://tower.example/graphql',
      ...over,
    }
  }

  it('maps the SMBIOS uuid, the physical NIC MACs only, and the flash GUID and LAN IP', async () => {
    const client = createLiveUnraidClient(
      api({
        system: {
          versions: async () => ({}),
          cpu$: async function* () {},
          info: async () => ({
            os: { hostname: 'Tower' },
            system: { uuid: '4C4C4544-0042-3510-8051-B7C04F4E3732' },
            devices: {
              network: [
                { iface: 'eth0', mac: 'AC:1F:6B:00:00:01' },
                { iface: 'docker0', mac: '02:42:ac:11:00:01' },
                { iface: 'vnet0', mac: 'fe:54:00:00:00:01' },
              ],
            },
          }),
        },
        server: {
          info: async () => ({ guid: '0781-5571-0000-123456789ABC', lanip: '192.0.2.20' }),
        },
      }),
    )
    expect(await client.system.info?.()).toEqual({
      hostname: 'Tower',
      machineUuid: '4C4C4544-0042-3510-8051-B7C04F4E3732',
      macs: ['AC:1F:6B:00:00:01'],
    })
    expect(await client.server?.info()).toEqual({
      flashGuid: '0781-5571-0000-123456789ABC',
      lanIp: '192.0.2.20',
    })
  })
})
