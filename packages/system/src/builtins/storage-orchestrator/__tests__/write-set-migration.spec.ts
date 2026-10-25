/**
 * The migration onto the enabled write set, and what a bare type ref means once
 * the default is gone (D383).
 *
 * The default was DELETED, not demoted, so two things have to be true on the
 * first boot of the new build against an old store, and stay true on every boot
 * after it:
 *
 *   - a location persisted before `enabled` existed comes back as an explicit
 *     `enabled: true`. Absence meant active, so this preserves behaviour
 *     exactly — and it makes "the initial locations are enabled" a fact in the
 *     store instead of an interpretation every reader has to repeat;
 *   - nothing an operator said explicitly is reversed, and no configuration is
 *     lost in the process.
 *
 * The bare-type ref (`storage.write({ location: 'eventMedia' })`) used to
 * resolve through the default. It now resolves to the sole location of the
 * type, or — transitionally, so pre-migration rows that stamped no locationId
 * stay readable — to the `<type>:default`-SLUGGED row, which is a name and can
 * never be repointed out from under those bytes.
 */

import type { IScopedLogger, StorageLocation } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ILocationStore, PersistedStorageLocation } from '../location-store.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

interface Logged {
  readonly warns: string[]
  readonly logger: IScopedLogger
}

function makeLogger(): Logged {
  const warns: string[] = []
  const logger = {
    error: vi.fn((msg: string) => warns.push(msg)),
    warn: vi.fn((msg: string) => warns.push(msg)),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
  return { warns, logger }
}

function row(input: {
  id: string
  type: string
  enabled?: boolean
  isDefault?: boolean
  config?: Record<string, unknown>
}): PersistedStorageLocation {
  return {
    id: input.id,
    type: input.type,
    displayName: input.id,
    providerId: 'fake-fs',
    config: input.config ?? { basePath: `/mnt/${input.id}` },
    isSystem: false,
    createdAt: 1,
    updatedAt: 1,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
  }
}

function makeStore(seed: readonly PersistedStorageLocation[]): {
  readonly store: ILocationStore
  readonly rows: Map<string, StorageLocation>
} {
  const rows = new Map<string, StorageLocation>(seed.map((l) => [l.id, l]))
  const store: ILocationStore = {
    loadAll: async () => [...seed],
    upsert: async (loc) => {
      rows.set(loc.id, loc)
    },
    delete: async (id) => {
      rows.delete(id)
    },
  }
  return { store, rows }
}

/** Let the fire-and-forget mirror writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('boot migration onto the enabled write set', () => {
  it('stamps a legacy flagless row enabled — absence stops existing', async () => {
    const { store, rows } = makeStore([
      row({ id: 'recordings:default', type: 'recordings', isDefault: true }),
    ])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()
    await settle()

    expect(service.getLocationById('recordings:default')?.enabled).toBe(true)
    expect(rows.get('recordings:default')?.enabled).toBe(true)
  })

  it('never reverses an explicit opt-out, and never loses configuration', async () => {
    const { store, rows } = makeStore([
      row({ id: 'recordings:default', type: 'recordings', enabled: true }),
      row({
        id: 'recordings:retired',
        type: 'recordings',
        enabled: false,
        config: { basePath: '/mnt/old', minFreePercent: 25 },
      }),
    ])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()
    await settle()

    const retired = service.getLocationById('recordings:retired')
    expect(retired?.enabled).toBe(false)
    expect(retired?.config['minFreePercent']).toBe(25)
    expect(rows.get('recordings:retired')?.enabled).toBe(false)
  })

  it('is idempotent — a second boot over its own output changes nothing', async () => {
    const { store, rows } = makeStore([
      row({ id: 'eventMedia:default', type: 'eventMedia', isDefault: true }),
      row({ id: 'eventMedia:ssd', type: 'eventMedia', enabled: false }),
    ])
    const first = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await first.initialize()
    await settle()
    const afterFirst = [...rows.values()].map((l) => `${l.id}=${String(l.enabled)}`).toSorted()

    const second = new StorageOrchestratorService(
      makeLogger().logger,
      () => [],
      makeStore([...rows.values()].map((l) => ({ ...l }))).store,
    )
    await second.initialize()
    await settle()

    expect(second.writeTargets('eventMedia').map((l) => l.id)).toEqual(['eventMedia:default'])
    expect(afterFirst).toEqual(['eventMedia:default=true', 'eventMedia:ssd=false'])
  })

  it('re-enables one location — loudly — when a type would boot with no write target', async () => {
    const { store } = makeStore([
      row({ id: 'recordings:default', type: 'recordings', enabled: false, isDefault: true }),
      row({ id: 'recordings:hgst', type: 'recordings', enabled: false }),
    ])
    const logged = makeLogger()
    const service = new StorageOrchestratorService(logged.logger, () => [], store)
    await service.initialize()
    await settle()

    // The legacy default is the one it picks back up: it is the row whose bytes
    // the class has been writing all along.
    expect(service.writeTargets('recordings').map((l) => l.id)).toEqual(['recordings:default'])
    expect(logged.warns.some((w) => w.includes('NO enabled location'))).toBe(true)
  })
})

describe('writeTargets — the pool replaces the default', () => {
  it('answers with every enabled location of the type, in id order', async () => {
    const { store } = makeStore([
      row({ id: 'recordings:hgst', type: 'recordings', enabled: true }),
      row({ id: 'recordings:default', type: 'recordings', enabled: true }),
      row({ id: 'recordings:retired', type: 'recordings', enabled: false }),
    ])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()

    expect(service.writeTargets('recordings').map((l) => l.id)).toEqual([
      'recordings:default',
      'recordings:hgst',
    ])
  })

  it('setWriteTargets moves the pool as ONE commit and leaves the rest of it alone', async () => {
    const { store, rows } = makeStore([
      row({ id: 'recordings:default', type: 'recordings', enabled: true }),
      row({ id: 'recordings:keep', type: 'recordings', enabled: true }),
      row({ id: 'recordings:hgst', type: 'recordings', enabled: false }),
    ])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()

    await service.setWriteTargets(
      new Map([
        ['recordings:hgst', true],
        ['recordings:default', false],
      ]),
    )

    expect(service.writeTargets('recordings').map((l) => l.id)).toEqual([
      'recordings:hgst',
      'recordings:keep',
    ])
    expect(rows.get('recordings:hgst')?.enabled).toBe(true)
    expect(rows.get('recordings:default')?.enabled).toBe(false)
  })

  it('refuses a commit that would leave a write-serving type with nothing enabled', async () => {
    const { store } = makeStore([
      row({ id: 'recordings:default', type: 'recordings', enabled: true }),
      row({ id: 'recordings:hgst', type: 'recordings', enabled: false }),
    ])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()

    await expect(service.setWriteTargets(new Map([['recordings:default', false]]))).rejects.toThrow(
      /no enabled location/,
    )
    expect(service.writeTargets('recordings')).toHaveLength(1)
  })
})

describe('bare-type refs without a default', () => {
  it('resolves to the SOLE location of the type', async () => {
    const { store } = makeStore([row({ id: 'data:default', type: 'data', enabled: true })])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()

    expect(service.resolveRef('data').id).toBe('data:default')
  })

  it('resolves to the `:default`-SLUGGED row when a type has several, and says it is deprecated', async () => {
    const { store } = makeStore([
      row({ id: 'eventMedia:default', type: 'eventMedia', enabled: false }),
      row({ id: 'eventMedia:ssd', type: 'eventMedia', enabled: true }),
    ])
    const logged = makeLogger()
    const service = new StorageOrchestratorService(logged.logger, () => [], store)
    await service.initialize()

    // Deliberately the DISABLED one: legacy rows that stamped no locationId
    // have their bytes there, and narrowing a READ is the worse bug.
    expect(service.resolveRef('eventMedia').id).toBe('eventMedia:default')
    expect(logged.warns.some((w) => w.includes('DEPRECATED bare-type ref'))).toBe(true)
  })

  it('refuses an ambiguous bare ref, naming the candidates', async () => {
    const { store } = makeStore([
      row({ id: 'backups:nas', type: 'backups', enabled: true }),
      row({ id: 'backups:usb', type: 'backups', enabled: true }),
    ])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()

    expect(() => service.resolveRef('backups')).toThrow(/backups:nas, backups:usb/)
  })

  it('refuses a bare ref for a type with no location at all', async () => {
    const { store } = makeStore([])
    const service = new StorageOrchestratorService(makeLogger().logger, () => [], store)
    await service.initialize()

    expect(() => service.resolveRef('backups')).toThrow(/No storage location configured/)
  })
})
