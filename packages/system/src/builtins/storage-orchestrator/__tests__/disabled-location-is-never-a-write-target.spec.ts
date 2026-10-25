/**
 * `StorageLocation.enabled` is the write switch — for the paths that reach a
 * write target through the WRITE SET, too.
 *
 * ## D383 — this file used to pin a different invariant
 *
 * Before D383 every bare-type storage ref resolved through
 * `getDefaultLocation`/a flagged `isDefault` default, and the hazard this file
 * existed to catch was a hand-edited row that arrived `isDefault: true,
 * enabled: false` — a "default" nothing routed writes away from, silently
 * pointing a drain (and every bare-type write) at a disabled disk.
 *
 * `isDefault` is retired. There is no default to flag any more: a WRITE path
 * (the migration coordinator's `writeTargets(type)`, the drain destination
 * picker) reads the enabled POOL directly, and it structurally cannot select a
 * disabled location — `writeTargets` filters on `isLocationEnabled` before
 * anything else touches the result. The old hazard is gone by construction,
 * not by a new check, so the tests that pinned it are deleted below with a
 * note (see `git log` / D383 for the retired assertions).
 *
 * What still deserves pinning under the new model:
 *   - the boot migration (`migrateOntoTheWriteSet`) must LOUDLY repair a type
 *     that hydrates with NO enabled location — silence there is exactly the
 *     "nowhere to write" failure this file's spirit is about;
 *   - `setWriteTargets` (the `setDefaultLocations` replacement) enables the
 *     location it is told to enable;
 *   - the coordinator's `drain()` still carries its own defensive refusal for
 *     a destination that went disabled between planning and dispatch (a
 *     concurrent operator edit racing the async residue census) — covered
 *     directly rather than through the now-impossible hydrate scenario.
 */
import type {
  IScopedLogger,
  RelocateJob,
  StorageLocation,
  StorageMigrationJob,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { ILocationStore } from '../location-store.js'
import {
  type FootageMigrationParticipant,
  type LeaseParticipant,
  type MediaMigrationParticipant,
  StorageMigrationCoordinator,
} from '../storage-migration-coordinator.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
}

function makeLogger(lines: LoggedLine[]): IScopedLogger {
  const record =
    (level: LoggedLine['level']) =>
    (message: string, opts?: { meta?: Record<string, unknown> }): void => {
      lines.push({ level, message, meta: opts?.meta ?? {} })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger as unknown as IScopedLogger
}

function row(input: { id: string; type: string; enabled?: boolean }): StorageLocation {
  return {
    id: input.id,
    type: input.type,
    displayName: input.id,
    providerId: 'fs',
    config: {},
    isSystem: false,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A store that hands back exactly the rows given — the hand-edited-DB shape. */
function storeOf(rows: readonly StorageLocation[]): ILocationStore {
  return {
    loadAll: async () => rows,
    upsert: async () => undefined,
    delete: async () => undefined,
  }
}

function unusedFootageParticipant(): FootageMigrationParticipant {
  const refuse = (): never => {
    throw new Error('participant reached — the drain should have been refused first')
  }
  return {
    pause: async () => refuse(),
    resume: async () => refuse(),
    startMove: async () => refuse(),
    startDrain: async () => refuse(),
    getMove: async () => refuse(),
    cancelMove: async () => refuse(),
    refresh: async () => refuse(),
    listMovers: async () => [] as readonly RelocateJob[],
    // The census IS reached — a drain must first learn there is residue.
    residue: async () => ({ segments: 12, bytes: 1_000 }),
  }
}

function unusedMediaParticipant(): MediaMigrationParticipant {
  const refuse = (): never => {
    throw new Error('participant reached — the drain should have been refused first')
  }
  return {
    pause: async () => refuse(),
    resume: async () => refuse(),
    startMove: async () => refuse(),
    startDrain: async () => refuse(),
    // "Nothing unstamped, and I KNOW it" — the D312 shape, where an absent
    // answer (`rows: null` / `total: null`) refuses instead of reading as zero.
    // This fixture must say the KNOWN-empty thing, or the drain would be
    // refused by the count and the test would pass without exercising the
    // `enabled` refusal it exists to prove.
    countUnstamped: async () => ({
      media: { present: false, rows: 0 },
      retrainFrames: { present: false, rows: 0 },
      anyPresent: false,
      total: 0,
    }),
    getMove: async () => refuse(),
    cancelMove: async () => refuse(),
    refresh: async () => refuse(),
    listMovers: async () => [] as readonly RelocateJob[],
    residue: async () => ({ rows: 0 }),
  }
}

function unusedLeaseParticipant(): LeaseParticipant {
  const refuse = (): never => {
    throw new Error('participant reached — the drain should have been refused first')
  }
  return { pause: async () => refuse(), resume: async () => refuse() }
}

function coordinatorOver(locations: StorageOrchestratorService): StorageMigrationCoordinator {
  let state: StorageMigrationJob | null = null
  return new StorageMigrationCoordinator({
    locations,
    state: {
      get: async () => state,
      set: async (value) => {
        state = value
      },
    },
    participants: {
      pipeline: unusedLeaseParticipant(),
      recorder: unusedFootageParticipant(),
      analytics: unusedMediaParticipant(),
    },
    now: () => 1,
    newId: () => 'migration-1',
    pollMs: 0,
  })
}

// Deleted (D383): "the type default is no longer force-enabled (API surface)"
// — both tests in it drove `getDefaultLocation`/`setDefaultLocations`, which
// are retired. "upsertLocation honours disabling a flagged-default when
// another location is enabled" is now covered, translated onto `enabled` and
// `writeTargets`, by storage-orchestrator-enabled.spec.ts's "allows disabling
// a location when another location of the type is enabled". "setDefaultLocations
// enables the location it repoints onto" is the same file's "setWriteTargets
// enables the location it names and disables the one it retires".

describe('write-set repair at hydrate (the successor of "the hydrate hole")', () => {
  it('a type with no enabled location gets one re-enabled at hydrate, loudly', async () => {
    // Both rows persisted disabled — nothing left in the write set. Silence
    // here is exactly the "nowhere to write" failure this file exists to
    // catch; `migrateOntoTheWriteSet`'s repair pass must re-enable one and say
    // so at `warn`, not bury it in the boot log.
    const lines: LoggedLine[] = []
    const service = new StorageOrchestratorService(makeLogger(lines), () => [])
    await service.attachStore(
      storeOf([
        row({ id: 'recordings:old', type: 'recordings', enabled: false }),
        row({ id: 'recordings:new', type: 'recordings', enabled: false }),
      ]),
    )
    // No legacy default and no `:default`-slugged row among these two, so the
    // repair falls back to the lexicographically-first id — `recordings:new`.
    const shout = lines.find(
      (l) => l.level === 'warn' && String(l.meta['id'] ?? '') === 'recordings:new',
    )
    expect(shout).toBeDefined()
    expect(shout?.message).toMatch(/no enabled location/i)
    expect(service.writeTargets('recordings').map((l) => l.id)).toEqual(['recordings:new'])
  })

  it('does not shout when a type already has an enabled location, or for a legacy flagless row', async () => {
    const lines: LoggedLine[] = []
    const service = new StorageOrchestratorService(makeLogger(lines), () => [])
    await service.attachStore(
      storeOf([
        row({ id: 'recordings:old', type: 'recordings', enabled: true }),
        row({ id: 'recordings:new', type: 'recordings', enabled: false }),
        // Legacy, flagless: absent means ACTIVE and must not read as disabled,
        // so this type never enters the "nothing enabled" repair branch either.
        row({ id: 'backups:default', type: 'backups' }),
      ]),
    )
    expect(lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([])
  })
})

describe('drain refuses a destination that goes disabled between planning and dispatch', () => {
  it('refuses when the write-target census races a concurrent disable', async () => {
    // Under D383 `writeTargets` cannot SELECT a disabled location as the drain
    // destination — it filters on `enabled` before anything else touches the
    // result (`residue()` skips every CURRENT write-set member, not just the
    // first, so the old "hydrate hands the coordinator a disabled default"
    // scenario is now unreachable). What is still reachable — and what
    // `drain()` still carries a defensive check for — is an operator
    // disabling the target through the async gap of the residue census
    // itself. Simulated here by having the recorder's `residue()` call flip
    // the target off as a side effect, exactly where a concurrent
    // `upsertLocation` would land in production.
    const service = new StorageOrchestratorService(makeLogger([]), () => [])
    // `:old` starts OUTSIDE the write set (holds the residue to drain);
    // `:new` is the write-set member `residue()` picks as target (first by
    // id). `:zzz` is a second enabled sibling that exists ONLY so the
    // concurrent disable below is legal — `recordings` is a write-serving
    // type and `upsertLocation` refuses to drop its last enabled location, so
    // without a sibling the simulated race would itself be refused rather
    // than landing.
    service.upsertLocation(row({ id: 'recordings:old', type: 'recordings', enabled: false }))
    service.upsertLocation(row({ id: 'recordings:new', type: 'recordings', enabled: true }))
    service.upsertLocation(row({ id: 'recordings:zzz', type: 'recordings', enabled: true }))
    expect(service.writeTargets('recordings').map((l) => l.id)).toEqual([
      'recordings:new',
      'recordings:zzz',
    ])

    let state: StorageMigrationJob | null = null
    const coordinator = new StorageMigrationCoordinator({
      locations: service,
      state: {
        get: async () => state,
        set: async (value) => {
          state = value
        },
      },
      participants: {
        pipeline: unusedLeaseParticipant(),
        recorder: {
          ...unusedFootageParticipant(),
          residue: async () => {
            const target = service.getLocationById('recordings:new')
            if (target) {
              const { createdAt: _c, updatedAt: _u, capacity: _cap, ...rest } = target
              service.upsertLocation({ ...rest, enabled: false })
            }
            return { segments: 12, bytes: 1_000 }
          },
        },
        analytics: unusedMediaParticipant(),
      },
      now: () => 1,
      newId: () => 'migration-1',
      pollMs: 0,
    })

    await expect(coordinator.drain({ classes: ['recordings'] })).rejects.toThrow(
      // D385: the state has a NAME now, so the refusal names it instead of
      // saying "disabled" for two different things.
      /recordings:new.*not a write target|not a write target.*recordings:new/is,
    )
  })

  it('still drains normally when the destination stays enabled throughout', async () => {
    const service = new StorageOrchestratorService(makeLogger([]), () => [])
    service.upsertLocation(row({ id: 'recordings:old', type: 'recordings', enabled: false }))
    service.upsertLocation(row({ id: 'recordings:new', type: 'recordings', enabled: true }))
    const coordinator = coordinatorOver(service)
    // Same fixture as the refusal above, minus the concurrent disable — the
    // refusal is about `enabled` and nothing else.
    await expect(coordinator.drain({ classes: ['recordings'] })).resolves.toBe('migration-1')
  })
})
