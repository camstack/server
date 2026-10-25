/**
 * Unit tests for `StorageOrchestratorService` — the routing core of the
 * `storage-orchestrator` builtin (Task 4 of the storage-unification
 * refactor). Tests instantiate the service directly with mocked
 * `storage-provider` providers; they do NOT boot a real `BaseAddon`.
 */

import type {
  IScopedLogger,
  IStorageProviderImpl,
  StorageLocation,
  StorageProviderInfoSchema,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

type ProviderInfo = z.infer<typeof StorageProviderInfoSchema>

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

interface FakeProviderOptions {
  readonly providerId: string
}

function makeFakeProvider(opts: FakeProviderOptions): IStorageProviderImpl {
  // Mock implementation — only `getProviderInfo` is exercised in these
  // routing tests; the other methods exist purely to satisfy the
  // structural type. We don't need real I/O — Tasks 5-7 cover end-to-end
  // smoke testing once the providers are wired up.
  const provider: IStorageProviderImpl = {
    getProviderInfo: vi.fn(
      async (): Promise<ProviderInfo> => ({
        providerId: opts.providerId,
        displayName: `Fake ${opts.providerId}`,
        configSchema: {},
        nodeLocal: true,
        shouldSaveDiskSpace: true,
        minFreePercent: 10,
      }),
    ),
    testLocation: vi.fn(async () => ({ ok: true })),
    resolve: vi.fn(async () => '/tmp/fake'),
    write: vi.fn(async () => undefined),
    read: vi.fn(async () => new Uint8Array()),
    exists: vi.fn(async () => false),
    list: vi.fn(async () => [] as readonly string[]),
    delete: vi.fn(async () => undefined),
    getAvailableSpace: vi.fn(async () => null),
    beginUpload: vi.fn(async () => ({ uploadId: 'u-1' })),
    writeChunk: vi.fn(async () => undefined),
    finalizeUpload: vi.fn(async () => undefined),
    abortUpload: vi.fn(async () => undefined),
    beginDownload: vi.fn(async () => ({ downloadId: 'd-1', sizeBytes: 0 })),
    readChunk: vi.fn(async () => new Uint8Array()),
    endDownload: vi.fn(async () => undefined),
  }
  return provider
}

function makeLocation(input: {
  id: string
  type: StorageLocation['type']
  providerId: string
  isSystem?: boolean
  enabled?: boolean
}): Omit<StorageLocation, 'createdAt' | 'updatedAt'> {
  return {
    id: input.id,
    type: input.type,
    displayName: input.id,
    providerId: input.providerId,
    config: {},
    isSystem: input.isSystem ?? false,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  }
}

describe('StorageOrchestratorService', () => {
  let providers: IStorageProviderImpl[]
  let service: StorageOrchestratorService

  beforeEach(() => {
    providers = []
    service = new StorageOrchestratorService(makeLogger(), () => providers)
  })

  describe('routing by providerId', () => {
    it('returns the provider matching the location.providerId', async () => {
      const fs1 = makeFakeProvider({ providerId: 'fake-fs-1' })
      const fs2 = makeFakeProvider({ providerId: 'fake-fs-2' })
      providers = [fs1, fs2]

      service.upsertLocation(
        makeLocation({ id: 'backups:nas-a', type: 'backups', providerId: 'fake-fs-1' }),
      )
      const locB = service.upsertLocation(
        makeLocation({ id: 'backups:nas-b', type: 'backups', providerId: 'fake-fs-2' }),
      )

      const resolved = await service.getProviderFor(locB)
      const info = await resolved.getProviderInfo()
      expect(info.providerId).toBe('fake-fs-2')
    })

    it('throws when no provider matches the locations providerId', async () => {
      providers = [makeFakeProvider({ providerId: 'fake-fs-1' })]
      const loc = service.upsertLocation(
        makeLocation({
          id: 'backups:ghost',
          type: 'backups',
          providerId: 'nonexistent',
        }),
      )

      await expect(service.getProviderFor(loc)).rejects.toThrow(/nonexistent/)
    })
  })

  describe('default resolution', () => {
    it('resolveRef(<type>) returns the default location of that type', () => {
      service.upsertLocation(
        makeLocation({ id: 'backups:other', type: 'backups', providerId: 'fake-fs-1' }),
      )
      const def = service.upsertLocation(
        makeLocation({
          id: 'backups:default',
          type: 'backups',
          providerId: 'fake-fs-1',
        }),
      )

      const resolved = service.resolveRef('backups')
      expect(resolved.id).toBe(def.id)
    })

    it('resolveRef(<id>) returns the explicit instance regardless of default', () => {
      service.upsertLocation(
        makeLocation({
          id: 'backups:default',
          type: 'backups',
          providerId: 'fake-fs-1',
        }),
      )
      const explicit = service.upsertLocation(
        makeLocation({
          id: 'backups:other',
          type: 'backups',
          providerId: 'fake-fs-1',
        }),
      )

      const resolved = service.resolveRef('backups:other')
      expect(resolved.id).toBe(explicit.id)
    })

    it('resolveRef rejects unknown id with actionable message', () => {
      expect(() => service.resolveRef('backups:does-not-exist')).toThrow(/backups:does-not-exist/)
    })

    it('resolveRef rejects bare type when no default exists', () => {
      // "no default" is now "no location of the type at all" — there is no
      // default flag any more (D383), so an empty type is the only bare-type
      // ref resolveRef refuses outright (several locations resolve to the
      // `:default`-slugged row instead, see the test above).
      expect(() => service.resolveRef('backups')).toThrow(/no storage location configured/i)
    })
  })

  describe('upsertLocation', () => {
    // Deleted (D383): "atomically demotes any prior default for the same
    // type" — upsert no longer demotes siblings; `isDefault` is retired and
    // several locations of a type can be enabled (in the write set)
    // simultaneously by design. `setWriteTargets`'s enable/disable-together
    // behaviour is covered in `storage-migration-coordinator.spec.ts`.
    it('preserves createdAt across updates and bumps updatedAt', () => {
      const created = service.upsertLocation(
        makeLocation({
          id: 'backups:c',
          type: 'backups',
          providerId: 'fake-fs-1',
        }),
      )
      const updated = service.upsertLocation({
        ...makeLocation({ id: 'backups:c', type: 'backups', providerId: 'fake-fs-2' }),
      })
      expect(updated.createdAt).toBe(created.createdAt)
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
      expect(updated.providerId).toBe('fake-fs-2')
    })
  })

  describe('deleteLocation', () => {
    /** Two locations of one type, so the last-default guard never fires and the
     *  occupancy check is what is under test. */
    function seedPair(): void {
      service.upsertLocation(
        makeLocation({
          id: 'backups:default',
          type: 'backups',
          providerId: 'fake-fs-1',
        }),
      )
      service.upsertLocation(
        makeLocation({ id: 'backups:extra', type: 'backups', providerId: 'fake-fs-1' }),
      )
    }

    it('throws when removing the only location for a type', async () => {
      service.upsertLocation(
        makeLocation({
          id: 'backups:default',
          type: 'backups',
          providerId: 'fake-fs-1',
        }),
      )
      await expect(service.deleteLocation('backups:default')).rejects.toThrow(/only location/i)
    })

    it('throws when the id is unknown', async () => {
      await expect(service.deleteLocation('backups:none')).rejects.toThrow(/not found/)
    })

    it('removes a location the probe reports empty', async () => {
      seedPair()
      service.setOccupancyProbe(async () => 'empty')
      await service.deleteLocation('backups:extra')
      expect(service.listLocations().some((l) => l.id === 'backups:extra')).toBe(false)
    })

    it('REFUSES a location that still holds data', async () => {
      seedPair()
      service.setOccupancyProbe(async () => 'occupied')
      await expect(service.deleteLocation('backups:extra')).rejects.toThrow(/still holds data/)
      // The record survives, which is the point: the rows that name it keep
      // resolving instead of becoming ghost segments.
      expect(service.listLocations().some((l) => l.id === 'backups:extra')).toBe(true)
    })

    it('REFUSES a location it could not check — unknown is not empty', async () => {
      seedPair()
      service.setOccupancyProbe(async () => 'unknown')
      await expect(service.deleteLocation('backups:extra')).rejects.toThrow(/could not be checked/)
      expect(service.listLocations().some((l) => l.id === 'backups:extra')).toBe(true)
    })

    it('refuses when NO probe is wired, rather than defaulting to permit', async () => {
      seedPair()
      await expect(service.deleteLocation('backups:extra')).rejects.toThrow(/could not be checked/)
    })

    it('treats a probe that throws as unknown, never as empty', async () => {
      seedPair()
      service.setOccupancyProbe(async () => {
        throw new Error('EACCES')
      })
      await expect(service.deleteLocation('backups:extra')).rejects.toThrow(/could not be checked/)
    })

    it('force overrides both refusals — an operator must not be permanently stuck', async () => {
      seedPair()
      service.setOccupancyProbe(async () => 'occupied')
      await service.deleteLocation('backups:extra', { force: true })
      expect(service.listLocations().some((l) => l.id === 'backups:extra')).toBe(false)
    })

    // Deleted (D383): "deleting the flagged default promotes an enabled
    // sibling" — deleteLocation no longer promotes a successor onto a
    // retired default flag. There is no default to promote onto any more;
    // whatever else is enabled simply stays in the write set (see
    // `writeTargets` below and in storage-orchestrator-enabled.spec.ts).
    it('deletes a system-managed recordings location when a sibling stays enabled', async () => {
      service.upsertLocation(
        makeLocation({
          id: 'recordings:ssd',
          type: 'recordings',
          providerId: 'fake-fs-1',
          enabled: true,
        }),
      )
      service.upsertLocation(
        makeLocation({
          id: 'recordings:default',
          type: 'recordings',
          providerId: 'fake-fs-1',
          isSystem: true,
          enabled: false,
        }),
      )
      service.setOccupancyProbe(async () => 'empty')
      await service.deleteLocation('recordings:default')
      expect(service.listLocations().some((l) => l.id === 'recordings:default')).toBe(false)
    })

    it('refuses the only location of a type, even when it is not system', async () => {
      service.upsertLocation(
        makeLocation({
          id: 'recordings:only',
          type: 'recordings',
          providerId: 'fake-fs-1',
        }),
      )
      service.setOccupancyProbe(async () => 'empty')
      await expect(service.deleteLocation('recordings:only')).rejects.toThrow(/only location/i)
    })

    it('refuses the only enabled location of a type', async () => {
      service.upsertLocation(
        makeLocation({
          id: 'recordings:live',
          type: 'recordings',
          providerId: 'fake-fs-1',
          enabled: true,
        }),
      )
      service.upsertLocation(
        makeLocation({
          id: 'recordings:frozen',
          type: 'recordings',
          providerId: 'fake-fs-1',
          enabled: false,
        }),
      )
      service.setOccupancyProbe(async () => 'empty')
      await expect(service.deleteLocation('recordings:live')).rejects.toThrow(/only enabled/i)
    })

    it('force does NOT override the only-location or only-enabled guards', async () => {
      service.upsertLocation(
        makeLocation({
          id: 'recordings:only',
          type: 'recordings',
          providerId: 'fake-fs-1',
        }),
      )
      service.setOccupancyProbe(async () => 'empty')
      await expect(service.deleteLocation('recordings:only', { force: true })).rejects.toThrow(
        /only location/i,
      )
    })
  })

  describe('listLocations / writeTargets', () => {
    it('listLocations filters by type when supplied', () => {
      service.upsertLocation(
        makeLocation({ id: 'backups:a', type: 'backups', providerId: 'fake-fs-1' }),
      )
      service.upsertLocation(
        makeLocation({ id: 'cache:a', type: 'cache', providerId: 'fake-fs-1' }),
      )
      const onlyBackups = service.listLocations({ type: 'backups' })
      expect(onlyBackups).toHaveLength(1)
      expect(onlyBackups[0]?.id).toBe('backups:a')
    })

    // Was "getDefaultLocation returns null when no default exists" —
    // `getDefaultLocation` is retired (D383); `writeTargets(type)` is its
    // replacement and returns the empty pool the same way. A CREATE with an
    // explicit `enabled: false` is the one way left to land a type with a
    // location but nothing in its write set (an omitted `enabled` on the
    // first location of a type auto-enables it — see storage-orchestrator-
    // enabled.spec.ts).
    it('writeTargets returns empty when nothing is enabled for the type', () => {
      service.upsertLocation(
        makeLocation({ id: 'backups:a', type: 'backups', providerId: 'fake-fs-1', enabled: false }),
      )
      expect(service.writeTargets('backups')).toEqual([])
    })
  })
})
