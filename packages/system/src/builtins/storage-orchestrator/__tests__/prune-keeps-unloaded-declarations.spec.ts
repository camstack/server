/**
 * The prune never reads "its declaring addon did not load" as "nobody declares
 * it" (D49, D315).
 *
 * Dev hub 2026-11-01 06:13Z: nine addons failed to load at boot (`Cannot find
 * module`), the kernel listed declarations of the LOADED addons only, and the
 * orchestrator deleted `eventMedia:default`, `recordings:default`, … along with
 * their seed memory. When the addons were fixed nothing re-created them, and
 * every event-media write has been refused since.
 */
import type {
  StorageLocation,
  StorageLocationDeclaration,
  StorageLocationDeclarer,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ILocationStore } from '../location-store.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
const EVENT_MEDIA = { id: 'eventMedia', displayName: 'Event media', cardinality: 'multi' } as const
const LOGS = { id: 'logs', displayName: 'Logs', cardinality: 'single' } as const

function row(type: string): StorageLocation {
  return {
    id: `${type}:default`,
    type,
    displayName: type,
    providerId: 'filesystem-storage',
    config: { basePath: `/data/${type}` },
    isSystem: false,
    createdAt: 1,
    updatedAt: 1,
    mode: 'active',
  }
}

/** A store that remembers: the rows it holds and the types a default was seeded for. */
function memoryStore(rows: StorageLocation[], seeded: string[]) {
  const deleted: string[] = []
  const unmarked: string[] = []
  const store: ILocationStore = {
    loadAll: async () => rows,
    upsert: async () => {},
    delete: async (id) => {
      deleted.push(id)
    },
    loadSeededTypes: async () => [...seeded],
    markTypeSeeded: async (type) => {
      seeded.push(type)
    },
    unmarkTypeSeeded: async (type) => {
      unmarked.push(type)
      const at = seeded.indexOf(type)
      if (at >= 0) seeded.splice(at, 1)
    },
  }
  return { store, deleted, unmarked, seeded }
}

/** A registry that declares only `declared` (what the LOADED addons declare). */
function registryOf(declared: readonly StorageLocationDeclaration[]) {
  const ids = new Set(declared.map((d) => d.id))
  return {
    cardinalityOf: (id: string) => (ids.has(id) ? ('multi' as const) : null),
    accessOf: () => 'local-path' as const,
    list: () => declared,
  }
}

async function serviceWith(rows: StorageLocation[], seeded: string[]) {
  const mem = memoryStore(rows, seeded)
  const svc = new StorageOrchestratorService(logger as never, () => [], null)
  await svc.attachStore(mem.store)
  return { svc, ...mem }
}

const unloaded = (addonId: string | null, ...declarations: StorageLocationDeclaration[]) =>
  ({
    addonId,
    packageName: '@camstack/addon-x',
    loaded: false,
    declarations,
  }) as const satisfies StorageLocationDeclarer

describe('pruneUndeclaredSystemLocations', () => {
  it('KEEPS the default of a type declared by an installed addon that failed to load', async () => {
    const { svc, deleted, unmarked } = await serviceWith(
      [row('eventMedia'), row('logs')],
      ['eventMedia', 'logs'],
    )
    svc.setRegistry(registryOf([LOGS])) // eventMedia's declarer is not loaded
    svc.pruneUndeclaredSystemLocations([unloaded('pipeline-analytics', EVENT_MEDIA)])
    expect(svc.getLocationById('eventMedia:default')).toBeDefined()
    expect(deleted).toEqual([])
    expect(unmarked).toEqual([])
    expect(JSON.stringify(logger.info.mock.calls)).toContain('pipeline-analytics')
  })

  it('prunes nothing when a package could not be read at all (its declarations are unknown)', async () => {
    const { svc, deleted } = await serviceWith(
      [row('eventMedia'), row('logs')],
      ['eventMedia', 'logs'],
    )
    svc.setRegistry(registryOf([LOGS]))
    svc.pruneUndeclaredSystemLocations([unloaded(null)])
    expect(svc.getLocationById('eventMedia:default')).toBeDefined()
    expect(deleted).toEqual([])
  })

  it('prunes a type nothing installed declares, and forgets that it was seeded', async () => {
    const { svc, deleted, unmarked } = await serviceWith(
      [row('eventMedia'), row('logs')],
      ['eventMedia', 'logs'],
    )
    svc.setRegistry(registryOf([LOGS]))
    svc.pruneUndeclaredSystemLocations([])
    expect(svc.getLocationById('eventMedia:default')).toBeUndefined()
    expect(deleted).toEqual(['eventMedia:default'])
    expect(unmarked).toEqual(['eventMedia'])
  })

  it('re-seeds a pruned type when it is declared again', async () => {
    const { svc } = await serviceWith([row('eventMedia'), row('logs')], ['eventMedia', 'logs'])
    svc.setRegistry(registryOf([LOGS]))
    svc.pruneUndeclaredSystemLocations([])
    svc.setRegistry(registryOf([LOGS, EVENT_MEDIA]))
    const outcome = svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      declarations: [LOGS, EVENT_MEDIA],
    })
    expect(outcome.added).toBe(1)
    expect(svc.getLocationById('eventMedia:default')).toBeDefined()
  })

  it('does NOT re-seed a default the operator deleted', async () => {
    const { svc } = await serviceWith([row('logs')], ['eventMedia', 'logs'])
    svc.setRegistry(registryOf([LOGS, EVENT_MEDIA]))
    const outcome = svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      declarations: [LOGS, EVENT_MEDIA],
    })
    expect(outcome.added).toBe(0)
    expect(svc.getLocationById('eventMedia:default')).toBeUndefined()
  })
})
