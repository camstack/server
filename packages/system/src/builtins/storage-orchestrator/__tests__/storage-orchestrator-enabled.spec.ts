/**
 * `StorageLocation.enabled` — the operator opt-in that decides whether a
 * location is a WRITE TARGET for the consumers that balance across locations
 * (recordings today; event media / backups next).
 *
 * The rule creating a location must NOT change behaviour on its own: adding a
 * second `recordings` disk in the wizard used to make the recorder start
 * striping onto it the moment it appeared. Now a newly created sibling is born
 * `enabled: false` and stays inert until the operator turns it on.
 *
 * The compat contract is the whole reason this ships without a migration:
 * `enabled` is OPTIONAL and ABSENT means ACTIVE. Every location persisted
 * before this flag existed reads back with no flag and keeps working.
 */

import type { IScopedLogger, StorageLocation } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

type LocationInput = Omit<StorageLocation, 'createdAt' | 'updatedAt'>

function makeLocation(input: { id: string; type: string; enabled?: boolean }): LocationInput {
  return {
    id: input.id,
    type: input.type,
    displayName: input.id,
    providerId: 'fake-fs',
    config: {},
    isSystem: false,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  }
}

describe('StorageLocation.enabled — creation defaults', () => {
  let service: StorageOrchestratorService

  beforeEach(() => {
    service = new StorageOrchestratorService(makeLogger(), () => [])
  })

  it('the FIRST location of a type is created enabled (nothing else can serve it)', () => {
    const first = service.upsertLocation(
      makeLocation({ id: 'recordings:default', type: 'recordings' }),
    )
    expect(first.enabled).toBe(true)
  })

  // Deleted (D383): "a location created as the type DEFAULT is enabled" —
  // `isDefault` no longer exists, so upsertLocation has no flag to force-
  // enable a create on. The only auto-enable rule left is "first location of
  // the type" (covered above); everything else is born inert (covered
  // below).
  it('a SECOND location of a type is created DISABLED — the operator opts it in', () => {
    service.upsertLocation(makeLocation({ id: 'recordings:default', type: 'recordings' }))
    const sibling = service.upsertLocation(
      makeLocation({ id: 'recordings:nas', type: 'recordings' }),
    )
    expect(sibling.enabled).toBe(false)
  })

  it('an explicit enabled:true on creation is honoured', () => {
    service.upsertLocation(makeLocation({ id: 'recordings:default', type: 'recordings' }))
    const sibling = service.upsertLocation(
      makeLocation({ id: 'recordings:nas', type: 'recordings', enabled: true }),
    )
    expect(sibling.enabled).toBe(true)
  })

  it('an explicit enabled:false on the first location is honoured (no silent override)', () => {
    const first = service.upsertLocation(
      makeLocation({ id: 'recordings:default', type: 'recordings', enabled: false }),
    )
    expect(first.enabled).toBe(false)
  })
})

describe('StorageLocation.enabled — updates never flip it silently', () => {
  let service: StorageOrchestratorService

  beforeEach(() => {
    service = new StorageOrchestratorService(makeLogger(), () => [])
  })

  it('an update that OMITS enabled preserves the stored value', () => {
    service.upsertLocation(makeLocation({ id: 'recordings:default', type: 'recordings' }))
    service.upsertLocation(makeLocation({ id: 'recordings:nas', type: 'recordings' }))
    service.upsertLocation(
      makeLocation({ id: 'recordings:nas', type: 'recordings', enabled: true }),
    )

    // A later edit (rename, path change) carries no `enabled` — the opt-in must survive it.
    const renamed = service.upsertLocation({
      ...makeLocation({ id: 'recordings:nas', type: 'recordings' }),
      displayName: 'NAS archive',
    })
    expect(renamed.enabled).toBe(true)
  })

  it('an update can explicitly disable a location (drain)', () => {
    service.upsertLocation(makeLocation({ id: 'recordings:default', type: 'recordings' }))
    service.upsertLocation(
      makeLocation({ id: 'recordings:nas', type: 'recordings', enabled: true }),
    )
    const drained = service.upsertLocation(
      makeLocation({ id: 'recordings:nas', type: 'recordings', enabled: false }),
    )
    expect(drained.enabled).toBe(false)
  })

  it('a legacy (flagless) row is stamped enabled:true at hydrate, and a later update that omits enabled preserves it', async () => {
    // A row persisted before `__enabled` existed carries no flag on disk.
    // `initialize()` now runs the D383 write-set migration: it stamps a
    // flagless row `enabled: true` ONCE, at boot, so absence stops existing
    // rather than being re-derived on every read (see `migrateOntoTheWriteSet`
    // in storage-orchestrator.service.ts). What survives from the original
    // contract is the second half: an unrelated edit AFTER that must not flip
    // a live write target — stamping `false` here would silently stop a live
    // recorder.
    const rows: StorageLocation[] = [
      {
        ...makeLocation({ id: 'recordings:legacy', type: 'recordings' }),
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const legacyService = new StorageOrchestratorService(makeLogger(), () => [], {
      loadAll: async () => rows,
      upsert: async () => undefined,
      delete: async () => undefined,
    })
    await legacyService.initialize()
    expect(legacyService.listLocations()[0]?.enabled).toBe(true)

    const updated = legacyService.upsertLocation({
      ...makeLocation({ id: 'recordings:legacy', type: 'recordings' }),
      displayName: 'Legacy',
    })
    expect(updated.enabled).toBe(true)
  })
})

describe('StorageLocation.enabled — last writable of a write-serving type', () => {
  let service: StorageOrchestratorService

  beforeEach(() => {
    service = new StorageOrchestratorService(makeLogger(), () => [])
  })

  it('refuses to disable the last enabled location of recordings', () => {
    service.upsertLocation(makeLocation({ id: 'recordings:default', type: 'recordings' }))
    expect(() =>
      service.upsertLocation(
        makeLocation({ id: 'recordings:default', type: 'recordings', enabled: false }),
      ),
    ).toThrow(/last enabled/)
  })

  it('allows disabling a location when another location of the type is enabled', () => {
    service.upsertLocation(makeLocation({ id: 'recordings:default', type: 'recordings' }))
    service.upsertLocation(
      makeLocation({ id: 'recordings:nas', type: 'recordings', enabled: true }),
    )
    const drained = service.upsertLocation(
      makeLocation({
        id: 'recordings:default',
        type: 'recordings',
        enabled: false,
      }),
    )
    expect(drained.enabled).toBe(false)
  })

  it('allows disabling the last backups location — zero destinations is legal', () => {
    service.upsertLocation(makeLocation({ id: 'backups:default', type: 'backups' }))
    const off = service.upsertLocation(
      makeLocation({ id: 'backups:default', type: 'backups', enabled: false }),
    )
    expect(off.enabled).toBe(false)
  })
})

// Was "StorageLocation.enabled — setDefaultLocations still force-enables its
// target". `setDefaultLocations(Map<type, locationId>)` is retired (D383) —
// `setWriteTargets(Map<locationId, boolean>)` replaces it as one compensated
// commit: the caller names exactly which locations join the pool and which
// leave it, rather than the orchestrator inferring a demotion.
describe('StorageLocation.enabled — setWriteTargets changes the pool as one commit', () => {
  let service: StorageOrchestratorService

  beforeEach(() => {
    service = new StorageOrchestratorService(makeLogger(), () => [])
  })

  it('setWriteTargets enables the location it names and disables the one it retires', async () => {
    service.upsertLocation(makeLocation({ id: 'recordings:default', type: 'recordings' }))
    service.upsertLocation(makeLocation({ id: 'recordings:nas', type: 'recordings' }))
    expect(service.listLocations().find((l) => l.id === 'recordings:nas')?.enabled).toBe(false)

    await service.setWriteTargets(
      new Map([
        ['recordings:nas', true],
        ['recordings:default', false],
      ]),
    )

    const nas = service.listLocations().find((l) => l.id === 'recordings:nas')
    const def = service.listLocations().find((l) => l.id === 'recordings:default')
    expect(nas?.enabled).toBe(true)
    expect(def?.enabled).toBe(false)
  })
})
