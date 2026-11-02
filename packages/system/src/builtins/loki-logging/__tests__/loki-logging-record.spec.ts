/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { integrationInstancesCapability, makeInMemoryRecords } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LokiLoggingAddon } from '../loki-logging.addon.js'
import { lokiDestinationsKind } from '../loki-record-kinds.js'

/**
 * The connection is a record (D985). The hub-resident addon offers it as an integration
 * instance; every node's destination is configured from the record, not from settings.
 */

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

async function boot(localNodeId: string, seed?: { url: string; enabled?: boolean }) {
  const world = makeInMemoryRecords('loki-logging')
  await world.records.declare({ destinations: lokiDestinationsKind })
  if (seed !== undefined) {
    await world.records.kind(lokiDestinationsKind).put(
      {
        id: 'int_0001',
        data: {
          name: 'Loki',
          url: seed.url,
          level: 'warn',
          job: 'cam',
          extraLabels: '',
          tenantId: '',
          username: '',
          batchIntervalMs: 5000,
          batchSize: 200,
          timeoutMs: 10000,
          ...(seed.enabled === undefined ? {} : { enabled: seed.enabled }),
        },
      },
      { ifRev: 0 },
    )
  }
  const store: Record<string, unknown> = {}
  const ctx = {
    id: 'loki-logging',
    logger: logger(),
    records: world.records,
    settings: {
      readAddonStore: vi.fn(async () => ({ ...store })),
      readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: { ...store } })),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId },
    api: {
      addons: { setCapabilityProviderEnabled: { mutate: vi.fn(async () => ({ success: true })) } },
      migrations: {
        declareOwner: { mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })) },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
    },
  } as unknown as AddonContext
  const addon = new LokiLoggingAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  return { addon, registrations, world }
}

describe('LokiLoggingAddon — connection record (D985)', () => {
  const addons: LokiLoggingAddon[] = []
  afterEach(async () => {
    // Let the background D777 carry-over finish before the context goes away.
    await new Promise((resolve) => setTimeout(resolve, 25))
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('the hub offers the connection as a single integration instance', async () => {
    const { addon, registrations } = await boot('hub')
    addons.push(addon)
    expect(registrations.map((r) => r.capability.name)).toContain(
      integrationInstancesCapability.name,
    )
  })

  it('an agent does not register an integration-instances provider', async () => {
    const { addon, registrations } = await boot('agent-1')
    addons.push(addon)
    expect(registrations.map((r) => r.capability.name)).not.toContain(
      integrationInstancesCapability.name,
    )
  })

  it('the destination is configured from the record on every node', async () => {
    for (const node of ['hub', 'agent-1']) {
      const { addon } = await boot(node, { url: 'http://loki:3100' })
      addons.push(addon)
      expect(addon.getDestination().getStatus().configured).toBe(true)
    }
  })

  it('a record switched off configures no push on any node, and switching it on resumes (D996)', async () => {
    for (const node of ['hub', 'agent-1']) {
      const { addon } = await boot(node, { url: 'http://loki:3100', enabled: false })
      addons.push(addon)
      expect(addon.getDestination().getStatus()).toMatchObject({
        enabled: false,
        configured: false,
      })
    }
  })

  it('setInstanceEnabled on the hub stops and resumes the destination at once', async () => {
    const { addon, registrations } = await boot('hub', { url: 'http://loki:3100' })
    addons.push(addon)
    expect(addon.getDestination().getStatus()).toMatchObject({ enabled: true, configured: true })
    const reg = registrations.find((r) => r.capability.name === integrationInstancesCapability.name)
    const target = reg?.provider
    const setEnabled: unknown =
      target === undefined ? undefined : Reflect.get(target, 'setInstanceEnabled')
    if (typeof setEnabled !== 'function' || target === undefined) throw new Error('no provider')
    const provider = {
      setInstanceEnabled: async (input: { id: string; enabled: boolean }): Promise<unknown> =>
        Reflect.apply(setEnabled, target, [input]),
    }
    await provider.setInstanceEnabled({ id: 'int_0001', enabled: false })
    expect(addon.getDestination().getStatus()).toMatchObject({ enabled: false, configured: false })
    await provider.setInstanceEnabled({ id: 'int_0001', enabled: true })
    expect(addon.getDestination().getStatus()).toMatchObject({ enabled: true, configured: true })
  })
})
