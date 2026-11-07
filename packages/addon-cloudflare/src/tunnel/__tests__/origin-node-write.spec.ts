/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger, ScopedSettingsScope } from '@camstack/types'
import { makeInMemoryRecords } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ensure-cloudflared.js', () => ({
  ensureCloudflared: vi.fn(async (): Promise<string> => {
    throw new Error('no cloudflared in a spec')
  }),
}))

import { CloudflareTunnelAddon } from '../cloudflare-tunnel.addon.js'
import { cloudflareTunnelsKind } from '../tunnel-record-kinds.js'

class WatchedTunnel extends CloudflareTunnelAddon {
  readonly changes: string[] = []
  protected override async onScopedSettingsChanged(
    scope: ScopedSettingsScope,
    cap: string,
    keys: readonly string[],
  ): Promise<void> {
    this.changes.push(`${scope}:${cap}:${[...keys].sort().join(',')}`)
    await super.onScopedSettingsChanged(scope, cap, keys)
  }
}

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

describe('CloudflareTunnelAddon: the local origin is written through the node handle', () => {
  const addons: WatchedTunnel[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('lands on the key the old build wrote (`<key>@hub`), leaves its neighbours, and announces the node write', async () => {
    const world = makeInMemoryRecords('cloudflare-tunnel')
    await world.records.declare({ tunnels: cloudflareTunnelsKind })
    // The old build's rows: the origin of the hub node.
    const stored: Record<string, unknown> = {
      'localHost@hub': '10.0.0.5',
      'localPortMode@hub': 'custom',
      'localPort@hub': 8443,
    }
    const ctx = {
      id: 'cloudflare-tunnel',
      logger: logger(),
      records: world.records,
      dataDir: '/tmp/cloudflare-tunnel-spec',
      settings: {
        readAddonStore: vi.fn(async () => ({ ...stored })),
        readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: { ...stored } })),
        writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(stored, patch)
        }),
      },
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      kernel: { localNodeId: 'hub' },
      api: {
        localNetwork: { getPreferred: { query: vi.fn(async () => null) } },
        migrations: {
          declareOwner: {
            mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })),
          },
          startMigration: { mutate: vi.fn() },
          finishMigration: { mutate: vi.fn() },
        },
      },
    } as unknown as AddonContext
    const addon = new WatchedTunnel()
    addons.push(addon)
    const result = await addon.initialize(ctx)
    const handlers = result && 'actionHandlers' in result ? result.actionHandlers : undefined
    if (handlers === undefined) throw new Error('no action handlers')

    await handlers['disableCustom']?.({})

    expect(stored['localHost@hub']).toBe('')
    expect(stored['localPortMode@hub']).toBe('custom')
    expect(stored['localPort@hub']).toBe(8443)
    expect(Object.keys(stored).filter((k) => k.startsWith('localHost'))).toEqual(['localHost@hub'])
    expect(addon.changes).toContain('node:network-access:localHost')
  })
})
