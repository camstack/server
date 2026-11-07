/**
 * The allowlist filters the address book the mDNS advert is built from, and its writes are state
 * writes (no onConfigChanged). So the keys local-network keeps for itself must re-announce the
 * hub through the real advertiser: the published `address` follows the allowlist.
 */
import type { NetworkInterfaceInfo } from 'node:os'
import type { HubMdnsAnnouncement } from '../hub-mdns.js'
import type { ILocalNetworkProvider, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubAddonContext } from './addon-context-stub.js'
import { makeMigrationsApi } from './migrations-api.js'
import { LocalNetworkAddon } from '../local-network.addon.js'

const published: HubMdnsAnnouncement[] = []

vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({
    publish: async (announcement: HubMdnsAnnouncement) => {
      published.push(announcement)
      return { stop: async () => undefined }
    },
  }),
}))

const LAN_A = '192.168.1.10'
const LAN_B = '10.0.0.5'

function nic(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  }
}

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    networkInterfaces: () => ({ en0: [nic(LAN_A)], en1: [nic(LAN_B)] }),
  }
})

function makeLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

async function start(store: Record<string, unknown>): Promise<ILocalNetworkProvider> {
  const ctx = stubAddonContext({
    id: 'local-network',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/local-network-mdns-spec',
    kernel: { localNodeId: 'hub' },
    api: makeMigrationsApi(),
    settings: {
      readAddonStore: vi.fn(async () => ({ ...store })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({ port: 4443 })),
      setSection: vi.fn(async () => undefined),
    },
  })
  const addon = new LocalNetworkAddon()
  addons.push(addon)
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const registered = registrations.find((r) => r.capability.name === 'local-network')
  if (registered === undefined) throw new Error('local-network provider not registered')
  // Documented type boundary: the registration carries the provider untyped.
  return registered.provider as ILocalNetworkProvider
}

const addons: LocalNetworkAddon[] = []

describe('local-network: the stored-key writes re-announce the hub over mDNS', () => {
  beforeEach(() => {
    published.length = 0
  })
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('setAllowedAddresses moves the advertised address to the newly allowed one', async () => {
    const provider = await start({ bootSeeded: true, allowedAddresses: [LAN_A] })
    expect(published.at(-1)?.address).toBe(LAN_A)

    await provider.setAllowedAddresses({ addresses: [LAN_B] })

    expect(published.at(-1)?.address).toBe(LAN_B)
  })

  it('resetAllowlistToBestMatch re-announces the reseeded address', async () => {
    const provider = await start({ bootSeeded: true, allowedAddresses: [LAN_A] })
    await provider.setAllowedAddresses({ addresses: [LAN_B] })
    expect(published.at(-1)?.address).toBe(LAN_B)

    const { addresses } = await provider.resetAllowlistToBestMatch()

    const seeded = addresses[0]
    expect(seeded).toBeDefined()
    expect(published.at(-1)?.address).toBe(seeded)
    expect(seeded).not.toBe(LAN_B)
  })
})
