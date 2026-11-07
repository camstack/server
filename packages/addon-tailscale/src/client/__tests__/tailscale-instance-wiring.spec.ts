/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
/**
 * The client addon against a fake ctx and the real in-memory records door: join writes the
 * record, logout clears the key it cleared before, auto-rejoin reads the record, and the old node
 * form writes THROUGH to the record (a key rotated there is the key the next boot rejoins with).
 * Only the CLI is faked: it records the `up` calls.
 */
import type { AddonContext, IMeshNetworkProvider, IScopedLogger } from '@camstack/types'
import { makeInMemoryRecords, meshNetworkCapability } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cliCalls = vi.hoisted(() => ({ up: [] as { authKey: string; hostname?: string }[] }))
vi.mock('../tailscale-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tailscale-cli.js')>()
  class FakeCli {
    async version() {
      return '1.78.0'
    }
    async status() {
      return { BackendState: 'NeedsLogin' }
    }
    async up(input: { authKey: string; hostname?: string }) {
      cliCalls.up.push(input)
    }
    async logout() {}
    async setPrefs() {}
  }
  return { ...actual, TailscaleCli: FakeCli }
})

import { TailscaleClientAddon } from '../tailscale.addon.js'
import { TAILNET_RECORD_ID, tailnetKind } from '../tailnet-record-kinds.js'

const logger = (): IScopedLogger =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }) as unknown as IScopedLogger

const OLD = 'tskey-auth-OLD123'
const NEW = 'tskey-auth-NEW456'

async function world(seed: { authKey?: string; hostname: string } | null) {
  const records = makeInMemoryRecords('tailscale-client')
  await records.records.declare({ tailnet: tailnetKind })
  const handle = records.records.kind(tailnetKind)
  if (seed !== null) {
    await handle.put({ id: TAILNET_RECORD_ID, data: { name: 'Tailscale', ...seed } }, { ifRev: 0 })
  }
  const stored: Record<string, unknown> = {}
  const writes: Record<string, unknown>[] = []
  const boot = async () => {
    const ctx = {
      id: 'tailscale-client',
      logger: logger(),
      records: records.records,
      addDisposer: vi.fn(),
      settings: {
        readAddonStore: vi.fn(async () => ({ ...stored })),
        readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: { ...stored } })),
        writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
          writes.push(patch)
          Object.assign(stored, patch)
        }),
      },
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      kernel: { localNodeId: 'hub' },
      api: {
        migrations: {
          declareOwner: {
            mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })),
          },
          startMigration: { mutate: vi.fn() },
          finishMigration: { mutate: vi.fn() },
        },
      },
    } as unknown as AddonContext
    const addon = new TailscaleClientAddon()
    const result = await addon.initialize(ctx)
    const registrations = Array.isArray(result) ? result : (result?.providers ?? [])
    const mesh = registrations.find((r) => r.capability.name === meshNetworkCapability.name)
    return { addon, mesh: mesh?.provider as IMeshNetworkProvider }
  }
  return { handle, writes, boot }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('TailscaleClientAddon: the tailnet instance carries the key', () => {
  const addons: TailscaleClientAddon[] = []
  afterEach(async () => {
    await settle() // a boot's deferred auto-rejoin must finish before the addon is shut down
    for (const a of addons.splice(0)) await a.shutdown()
    cliCalls.up.length = 0
  })

  it('auto-rejoin on boot reads the record, not the node settings', async () => {
    const w = await world({ authKey: OLD, hostname: 'camstack-hub' })
    addons.push((await w.boot()).addon)
    await settle()
    expect(cliCalls.up).toEqual([{ authKey: OLD, hostname: 'camstack-hub' }])
  })

  it('join writes the record, and the next boot rejoins with that key', async () => {
    const w = await world(null)
    const first = await w.boot()
    addons.push(first.addon)
    await settle()
    cliCalls.up.length = 0
    await first.mesh.join({ authKey: NEW, hostname: 'h1' })
    const row = await w.handle.getResolved(TAILNET_RECORD_ID)
    expect(row?.data).toMatchObject({ authKey: NEW, hostname: 'h1' })
    expect(JSON.stringify(w.writes)).not.toContain(NEW)
    cliCalls.up.length = 0
    addons.push((await w.boot()).addon)
    await settle()
    expect(cliCalls.up).toEqual([{ authKey: NEW, hostname: 'h1' }])
  })

  it('logout clears the key on the record and the boot after it does not rejoin', async () => {
    const w = await world({ authKey: OLD, hostname: 'camstack-hub' })
    const first = await w.boot()
    addons.push(first.addon)
    await settle()
    cliCalls.up.length = 0
    await first.mesh.logout()
    expect((await w.handle.getResolved(TAILNET_RECORD_ID))?.data.authKey).toBeUndefined()
    cliCalls.up.length = 0
    addons.push((await w.boot()).addon)
    await settle()
    expect(cliCalls.up).toEqual([])
  })

  it('a key saved through the old node form is the key auto-rejoin uses', async () => {
    const w = await world({ authKey: OLD, hostname: 'camstack-hub' })
    const first = await w.boot()
    addons.push(first.addon)
    await settle()
    cliCalls.up.length = 0
    await first.addon.updateScopedSettings('node', 'mesh-network', { authKey: NEW })
    expect((await w.handle.getResolved(TAILNET_RECORD_ID))?.data.authKey).toBe(NEW)
    expect(JSON.stringify(w.writes)).not.toContain(NEW)
    cliCalls.up.length = 0
    addons.push((await w.boot()).addon)
    await settle()
    expect(cliCalls.up).toEqual([{ authKey: NEW, hostname: 'camstack-hub' }])
  })

  it('the old form shows the hostname of the record, never the key, and an empty key keeps it', async () => {
    const w = await world({ authKey: OLD, hostname: 'camstack-hub' })
    const first = await w.boot()
    addons.push(first.addon)
    const form = await first.addon.getScopedSettingsSchema('node', 'mesh-network')
    expect(JSON.stringify(form)).not.toContain(OLD)
    expect(JSON.stringify(form)).toContain('camstack-hub')
    await first.addon.updateScopedSettings('node', 'mesh-network', {
      authKey: '',
      hostname: 'renamed',
    })
    expect((await w.handle.getResolved(TAILNET_RECORD_ID))?.data).toMatchObject({
      authKey: OLD,
      hostname: 'renamed',
    })
  })
})
