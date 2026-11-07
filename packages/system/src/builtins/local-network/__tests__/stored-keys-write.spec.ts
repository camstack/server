/**
 * local-network writes the keys it keeps for itself (the allowlist, the first-boot flag, the
 * saved subnets, the address book) as bare keys of its store, as the old build did — through a
 * durable handle, not the retired addon-level write.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, ILocalNetworkProvider, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMigrationsApi } from './migrations-api.js'
import { LocalNetworkAddon } from '../local-network.addon.js'

vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({ publish: async () => ({ stop: async () => undefined }) }),
}))

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

async function start(dataDir: string, store: Record<string, unknown>) {
  const ctx = {
    id: 'local-network',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir,
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
  } as unknown as AddonContext
  const addon = new LocalNetworkAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const registered = registrations.find((r) => r.capability.name === 'local-network')
  if (registered === undefined) throw new Error('local-network provider not registered')
  // Documented type boundary: the registration carries the provider untyped.
  return registered.provider as ILocalNetworkProvider
}

describe('local-network: the keys it keeps for itself', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-network-stored-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a saved subnet list lands on the bare `scanSubnets` key and the next read sees it', async () => {
    const store: Record<string, unknown> = {
      'httpEnabled@hub': false,
      bootSeeded: true,
      unrelated: 'keep-me',
      scanSubnets: ['192.168.1.0/24'],
    }
    const provider = await start(dir, store)

    await provider.setScanSubnets({ subnets: ['10.1.0.0/24'] })

    expect(store['scanSubnets']).toEqual(['10.1.0.0/24'])
    expect(store['unrelated']).toBe('keep-me')
    expect(store['bootSeeded']).toBe(true)
    expect(await provider.getScanSubnets({})).toEqual({ subnets: ['10.1.0.0/24'] })
  })

  it('the first-boot seed writes `bootSeeded` and `allowedAddresses` as bare keys', async () => {
    const store: Record<string, unknown> = { 'httpEnabled@hub': false }
    await start(dir, store)
    expect(store['bootSeeded']).toBe(true)
    expect(Array.isArray(store['allowedAddresses'])).toBe(true)
    expect(Object.keys(store).filter((k) => k.startsWith('bootSeeded'))).toEqual(['bootSeeded'])
  })
})
