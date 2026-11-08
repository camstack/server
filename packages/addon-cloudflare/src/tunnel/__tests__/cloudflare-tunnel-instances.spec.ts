/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import {
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  makeInMemoryRecords,
  networkAccessCapability,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ensureCloudflared = vi.hoisted(() =>
  vi.fn(async (): Promise<string> => {
    throw new Error('no cloudflared in a spec')
  }),
)
vi.mock('../ensure-cloudflared.js', () => ({ ensureCloudflared }))

import { CloudflareTunnelAddon } from '../cloudflare-tunnel.addon.js'
import {
  CLOUDFLARE_TUNNEL_DEFAULT_BODY,
  CLOUDFLARE_TUNNEL_RECORD_ID,
  type CloudflareTunnelBody,
  cloudflareTunnelsKind,
} from '../tunnel-record-kinds.js'

function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

async function boot(seed: Partial<CloudflareTunnelBody> | null) {
  const world = makeInMemoryRecords('cloudflare-tunnel')
  await world.records.declare({ tunnels: cloudflareTunnelsKind })
  const handle = world.records.kind(cloudflareTunnelsKind)
  if (seed !== null) {
    await handle.put(
      {
        id: CLOUDFLARE_TUNNEL_RECORD_ID,
        data: { ...CLOUDFLARE_TUNNEL_DEFAULT_BODY, name: 'Cloudflare tunnel', ...seed },
      },
      { ifRev: 0 },
    )
  }
  const ctx = {
    id: 'cloudflare-tunnel',
    logger: logger(),
    records: world.records,
    dataDir: '/tmp/cloudflare-tunnel-spec',
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: {} })),
      writeAddonStore: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub' },
    api: {
      localNetwork: { getPreferred: { query: vi.fn(async () => null) } },
      migrations: {
        declareOwner: { mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })) },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
    },
  } as unknown as AddonContext
  const addon = new CloudflareTunnelAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const instances = registrations.find(
    (r) => r.capability.name === integrationInstancesCapability.name,
  )
  return {
    addon,
    capabilities: registrations.map((r) => r.capability.name),
    instances: instances?.provider as IIntegrationInstancesProvider,
  }
}

const NAMED = {
  mode: 'custom' as const,
  customHostname: 'cam.example.com',
  customTunnelToken: 'jwt-SECRET',
  customApiToken: 'api-SECRET',
}

describe('CloudflareTunnelAddon: the tunnel is an integration instance (D996)', () => {
  const addons: CloudflareTunnelAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
    ensureCloudflared.mockClear()
  })

  it('registers network-access and integration-instances, one single-instance record', async () => {
    const w = await boot(NAMED)
    addons.push(w.addon)
    expect(w.capabilities).toEqual([
      networkAccessCapability.name,
      integrationInstancesCapability.name,
    ])
    await expect(w.instances.describe()).resolves.toEqual({
      instanceMode: 'single',
      kind: 'tunnels',
      canTest: false,
      role: 'services',
      kinds: [expect.objectContaining({ id: 'tunnels', functionCap: 'network-access' })],
    })
    expect((await w.instances.listInstances()).map((i) => i.id)).toEqual(['cloudflare-tunnel'])
  })

  it('starts a configured record at boot, and not a switched-off one', async () => {
    const on = await boot(NAMED)
    addons.push(on.addon)
    await vi.waitFor(() => expect(ensureCloudflared).toHaveBeenCalled())

    ensureCloudflared.mockClear()
    const off = await boot({ ...NAMED, enabled: false })
    addons.push(off.addon)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ensureCloudflared).not.toHaveBeenCalled()
  })

  it('switching the record on starts the tunnel; the switch is the record, not a setting', async () => {
    const w = await boot({ ...NAMED, enabled: false })
    addons.push(w.addon)
    expect(ensureCloudflared).not.toHaveBeenCalled()
    await w.instances.setInstanceEnabled({ id: CLOUDFLARE_TUNNEL_RECORD_ID, enabled: true })
    await vi.waitFor(() => expect(ensureCloudflared).toHaveBeenCalled())
  })

  it('neither token leaves the record through the instance view', async () => {
    const w = await boot(NAMED)
    addons.push(w.addon)
    const shown = JSON.stringify([
      await w.instances.listInstances(),
      await w.instances.getInstance({ id: CLOUDFLARE_TUNNEL_RECORD_ID }),
    ])
    expect(shown).not.toContain('jwt-SECRET')
    expect(shown).not.toContain('api-SECRET')
  })
})
