/**
 * Unit tests for the per-location manifest helpers (Task 10 of the
 * storage-unification refactor).
 *
 * Exercises:
 *   - First-time read returns the empty manifest (file doesn't exist).
 *   - Read → mutate → write round-trips JSON correctly.
 *   - Bogus / corrupt manifest files degrade gracefully.
 *   - `LocationManifestLock` serializes intra-location reads while
 *     allowing inter-location parallelism.
 */
import { describe, it, expect } from 'vitest'
import {
  readLocationManifest,
  writeLocationManifest,
  parseManifestBytes,
  buildArchiveEntry,
  LocationManifestLock,
  MANIFESTS_FILENAME,
  type ManifestStorageApi,
  type LocationBackupManifest,
} from '../manifest-store.js'

/**
 * Tiny fake of the `storage` cap surface — only the three methods the
 * manifest helpers touch. Backed by an in-memory `Map<string,
 * Uint8Array>` keyed by `${location}|${path}`.
 */
/**
 * The real `AddonApi['storage']` exposes hundreds of generated tRPC
 * properties via the typed link chain — far more than the manifest
 * helpers consume. We build the fake against a duck-typed shape and
 * pass it as `unknown` through `ManifestStorageApi` so vitest doesn't
 * have to satisfy the full generated type tree.
 */
interface FakeStorageMethods {
  readonly read: {
    query: (input: { location: string; relativePath: string }) => Promise<Uint8Array>
  }
  readonly write: {
    mutate: (input: { location: string; relativePath: string; data: Uint8Array }) => Promise<void>
  }
  readonly exists: {
    query: (input: { location: string; relativePath: string }) => Promise<boolean>
  }
}

function makeFakeStorage(): {
  api: ManifestStorageApi
  files: Map<string, Uint8Array>
} {
  const files = new Map<string, Uint8Array>()
  const key = (loc: string, p: string): string => `${loc}|${p}`
  const fake: FakeStorageMethods = {
    read: {
      query: async ({ location, relativePath }) => {
        const data = files.get(key(location, relativePath))
        if (!data) throw new Error(`fake storage: ${location}/${relativePath} missing`)
        return data
      },
    },
    write: {
      mutate: async ({ location, relativePath, data }) => {
        files.set(key(location, relativePath), data)
      },
    },
    exists: {
      query: async ({ location, relativePath }) => {
        return files.has(key(location, relativePath))
      },
    },
  }
  // Bridge the duck-typed fake into the generated `ManifestStorageApi`
  // shape via `unknown`. Documented type boundary — production code is
  // typed end-to-end through `ctx.api.storage`.
  const api = fake as unknown as ManifestStorageApi
  return { api, files }
}

function fakeArchiveManifest() {
  return {
    archiveVersion: 1 as const,
    createdAt: 1_700_000_000_000,
    dataDir: '/tmp/data',
    locations: ['config.yaml'],
    entries: [{ path: 'config.yaml', kind: 'file' as const, sizeBytes: 100, mtime: 0 }],
    totalBytes: 100,
    totalFiles: 1,
  }
}

describe('manifest-store', () => {
  describe('readLocationManifest', () => {
    it('returns empty manifest when the file does not exist', async () => {
      const { api } = makeFakeStorage()
      const m = await readLocationManifest(api, 'backups:default')
      expect(m).toEqual({ version: 1, archives: [] })
    })

    it('returns empty manifest when the file is corrupt JSON', async () => {
      const { api, files } = makeFakeStorage()
      files.set(
        `backups:default|${MANIFESTS_FILENAME}`,
        new TextEncoder().encode('{not valid json'),
      )
      const m = await readLocationManifest(api, 'backups:default')
      expect(m).toEqual({ version: 1, archives: [] })
    })

    it('round-trips a written manifest', async () => {
      const { api } = makeFakeStorage()
      const manifest: LocationBackupManifest = {
        version: 1,
        archives: [
          buildArchiveEntry({
            id: 'abc',
            filename: 'abc.tar.gz',
            createdAt: 1_700_000_000_000,
            sizeBytes: 12345,
            label: 'auto-daily',
            manifest: fakeArchiveManifest(),
          }),
        ],
      }
      await writeLocationManifest(api, 'backups:default', manifest)
      const out = await readLocationManifest(api, 'backups:default')
      expect(out).toEqual(manifest)
    })

    it('drops malformed archive rows but keeps valid siblings', async () => {
      const bad = JSON.stringify({
        version: 1,
        archives: [
          { id: 'abc' /* missing filename + createdAt */ },
          {
            id: 'def',
            filename: 'def.tar.gz',
            createdAt: 1_700_000_000_001,
            sizeBytes: 999,
            manifest: fakeArchiveManifest(),
          },
        ],
      })
      const m = parseManifestBytes(new TextEncoder().encode(bad))
      expect(m.archives).toHaveLength(1)
      expect(m.archives[0]?.id).toBe('def')
    })
  })

  describe('append flow (read → modify → write)', () => {
    it('appends a new archive entry and persists it', async () => {
      const { api } = makeFakeStorage()

      // First boot — manifest doesn't exist.
      const m0 = await readLocationManifest(api, 'backups:default')
      expect(m0.archives).toHaveLength(0)

      // Append the first archive.
      const entry1 = buildArchiveEntry({
        id: 'a-1',
        filename: 'a-1.tar.gz',
        createdAt: 1,
        sizeBytes: 10,
        manifest: fakeArchiveManifest(),
      })
      await writeLocationManifest(api, 'backups:default', {
        version: 1,
        archives: [...m0.archives, entry1],
      })

      // Append a second archive.
      const m1 = await readLocationManifest(api, 'backups:default')
      const entry2 = buildArchiveEntry({
        id: 'a-2',
        filename: 'a-2.tar.gz',
        createdAt: 2,
        sizeBytes: 20,
        label: 'auto-daily',
        manifest: fakeArchiveManifest(),
      })
      await writeLocationManifest(api, 'backups:default', {
        version: 1,
        archives: [...m1.archives, entry2],
      })

      const final = await readLocationManifest(api, 'backups:default')
      expect(final.archives.map((a) => a.id)).toEqual(['a-1', 'a-2'])
      expect(final.archives[1]?.label).toBe('auto-daily')
    })

    it('different locations have independent manifests', async () => {
      const { api } = makeFakeStorage()
      await writeLocationManifest(api, 'backups:a', {
        version: 1,
        archives: [
          buildArchiveEntry({
            id: 'on-a',
            filename: 'on-a.tar.gz',
            createdAt: 0,
            sizeBytes: 1,
            manifest: fakeArchiveManifest(),
          }),
        ],
      })
      await writeLocationManifest(api, 'backups:b', {
        version: 1,
        archives: [
          buildArchiveEntry({
            id: 'on-b',
            filename: 'on-b.tar.gz',
            createdAt: 0,
            sizeBytes: 1,
            manifest: fakeArchiveManifest(),
          }),
        ],
      })

      const a = await readLocationManifest(api, 'backups:a')
      const b = await readLocationManifest(api, 'backups:b')
      expect(a.archives[0]?.id).toBe('on-a')
      expect(b.archives[0]?.id).toBe('on-b')
    })
  })

  describe('LocationManifestLock', () => {
    it('serializes operations within a single location', async () => {
      const lock = new LocationManifestLock()
      const order: string[] = []
      const slow = (label: string, ms: number) => async () => {
        order.push(`start:${label}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end:${label}`)
        return label
      }

      const p1 = lock.run('backups:default', slow('first', 30))
      const p2 = lock.run('backups:default', slow('second', 5))
      await Promise.all([p1, p2])
      // The second call must NOT start until the first ends.
      expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
    })

    it('runs operations on different locations in parallel', async () => {
      const lock = new LocationManifestLock()
      const order: string[] = []
      const slow = (label: string, ms: number) => async () => {
        order.push(`start:${label}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end:${label}`)
      }

      const p1 = lock.run('backups:a', slow('a-1', 30))
      const p2 = lock.run('backups:b', slow('b-1', 5))
      await Promise.all([p1, p2])
      // b-1 starts AND ends before a-1 ends — confirms parallelism.
      expect(order.indexOf('end:b-1')).toBeLessThan(order.indexOf('end:a-1'))
    })

    it('propagates rejections without locking the chain', async () => {
      const lock = new LocationManifestLock()
      await expect(
        lock.run('loc', async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      // Subsequent runs on the same location still proceed.
      const result = await lock.run('loc', async () => 'ok')
      expect(result).toBe('ok')
    })
  })
})
