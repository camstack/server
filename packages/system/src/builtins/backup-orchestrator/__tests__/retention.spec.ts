/**
 * Unit tests for per-destination retention (Task 11 of the storage-
 * unification refactor).
 *
 * Covers `applyRetention` (the pure split) plus a manifest-level
 * round-trip that mirrors the orchestrator's lock-protected
 * append+prune step. The full chunked-upload path is not exercised
 * here — it lands in the smoke task (Task 17).
 */
import { describe, it, expect } from 'vitest'
import {
  applyRetention,
  buildArchiveEntry,
  readLocationManifest,
  writeLocationManifest,
  type LocationBackupManifest,
  type ManifestArchiveEntry,
  type ManifestStorageApi,
} from '../manifest-store.js'

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
  deletes: string[]
  fakeDeleteFile: (location: string, relativePath: string) => void
} {
  const files = new Map<string, Uint8Array>()
  const deletes: string[] = []
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
  return {
    api: fake as unknown as ManifestStorageApi,
    files,
    deletes,
    fakeDeleteFile: (location, relativePath) => {
      deletes.push(`${location}|${relativePath}`)
      files.delete(key(location, relativePath))
    },
  }
}

function fakeArchiveManifest() {
  return {
    archiveVersion: 1 as const,
    createdAt: 0,
    dataDir: '/tmp/data',
    locations: [],
    entries: [],
    totalBytes: 0,
    totalFiles: 0,
  }
}

function makeEntry(id: string, createdAt: number): ManifestArchiveEntry {
  return buildArchiveEntry({
    id,
    filename: `${id}.tar.gz`,
    createdAt,
    sizeBytes: 1,
    manifest: fakeArchiveManifest(),
  })
}

describe('applyRetention', () => {
  it('returns all archives when count <= retention', () => {
    const archives = [makeEntry('a', 1), makeEntry('b', 2), makeEntry('c', 3)]
    const { keep, drop } = applyRetention(archives, 3)
    expect(keep.map((a) => a.id)).toEqual(['c', 'b', 'a'])
    expect(drop).toEqual([])
  })

  it('keeps newest N and drops the older overflow', () => {
    const archives = [
      makeEntry('a', 1),
      makeEntry('b', 2),
      makeEntry('c', 3),
      makeEntry('d', 4),
      makeEntry('e', 5),
    ]
    const { keep, drop } = applyRetention(archives, 3)
    expect(keep.map((a) => a.id)).toEqual(['e', 'd', 'c'])
    expect(drop.map((a) => a.id)).toEqual(['b', 'a'])
  })

  it('with retention=1 and a single archive keeps it (no-op)', () => {
    const archives = [makeEntry('a', 1)]
    const { keep, drop } = applyRetention(archives, 1)
    expect(keep.map((a) => a.id)).toEqual(['a'])
    expect(drop).toEqual([])
  })

  it('treats retention<=0 as "no pruning"', () => {
    const archives = [makeEntry('a', 1), makeEntry('b', 2)]
    expect(applyRetention(archives, 0).drop).toEqual([])
    expect(applyRetention(archives, -5).drop).toEqual([])
  })

  it('handles unsorted createdAt input correctly', () => {
    // Insert in random order; applyRetention must sort by createdAt desc.
    const archives = [makeEntry('mid', 5), makeEntry('newest', 10), makeEntry('oldest', 1)]
    const { keep } = applyRetention(archives, 1)
    expect(keep.map((a) => a.id)).toEqual(['newest'])
  })
})

describe('manifest-level retention round-trip', () => {
  /**
   * Mirror of the orchestrator's lock-protected append+prune step:
   * read → append → applyRetention → delete drops via storage cap →
   * write trimmed manifest.
   */
  async function appendAndPrune(
    api: ManifestStorageApi,
    locationId: string,
    entry: ManifestArchiveEntry,
    retentionCount: number,
    deleteFile: (location: string, relativePath: string) => void,
  ): Promise<void> {
    const manifest = await readLocationManifest(api, locationId)
    const appended = [...manifest.archives, entry]
    const { keep, drop } = applyRetention(appended, retentionCount)
    for (const stale of drop) {
      deleteFile(locationId, stale.filename)
    }
    const next: LocationBackupManifest = { version: 1, archives: keep }
    await writeLocationManifest(api, locationId, next)
  }

  it('after 5 writes with retention 3, only the newest 3 remain', async () => {
    const fixture = makeFakeStorage()
    // Pre-populate the archive files so retention can "delete" them.
    fixture.files.set('backups:default|a.tar.gz', new Uint8Array([1]))
    fixture.files.set('backups:default|b.tar.gz', new Uint8Array([1]))
    fixture.files.set('backups:default|c.tar.gz', new Uint8Array([1]))
    fixture.files.set('backups:default|d.tar.gz', new Uint8Array([1]))
    fixture.files.set('backups:default|e.tar.gz', new Uint8Array([1]))

    for (let i = 0; i < 5; i++) {
      const id = ['a', 'b', 'c', 'd', 'e'][i]!
      await appendAndPrune(
        fixture.api,
        'backups:default',
        makeEntry(id, i + 1),
        3,
        fixture.fakeDeleteFile,
      )
    }

    const final = await readLocationManifest(fixture.api, 'backups:default')
    expect(final.archives.map((a) => a.id)).toEqual(['e', 'd', 'c'])

    // 'a' and 'b' deletes were issued.
    expect(fixture.deletes).toContain('backups:default|a.tar.gz')
    expect(fixture.deletes).toContain('backups:default|b.tar.gz')
    expect(fixture.files.has('backups:default|a.tar.gz')).toBe(false)
    expect(fixture.files.has('backups:default|b.tar.gz')).toBe(false)
    expect(fixture.files.has('backups:default|c.tar.gz')).toBe(true)
  })

  it('retention 1 with a single archive issues no deletes', async () => {
    const fixture = makeFakeStorage()
    fixture.files.set('backups:default|a.tar.gz', new Uint8Array([1]))
    await appendAndPrune(
      fixture.api,
      'backups:default',
      makeEntry('a', 1),
      1,
      fixture.fakeDeleteFile,
    )
    const final = await readLocationManifest(fixture.api, 'backups:default')
    expect(final.archives.map((a) => a.id)).toEqual(['a'])
    expect(fixture.deletes).toEqual([])
  })

  it('per-destination retention is independent — A:3 and B:7 keep independently', async () => {
    const fixture = makeFakeStorage()
    // Seed all the archive files for both locations.
    for (const loc of ['backups:a', 'backups:b']) {
      for (let i = 1; i <= 5; i++) {
        fixture.files.set(`${loc}|x${i}.tar.gz`, new Uint8Array([1]))
      }
    }

    // 5 writes at retention 3 against `backups:a`.
    for (let i = 1; i <= 5; i++) {
      await appendAndPrune(
        fixture.api,
        'backups:a',
        makeEntry(`x${i}`, i),
        3,
        fixture.fakeDeleteFile,
      )
    }
    // 5 writes at retention 7 against `backups:b` (no pruning yet).
    for (let i = 1; i <= 5; i++) {
      await appendAndPrune(
        fixture.api,
        'backups:b',
        makeEntry(`x${i}`, i),
        7,
        fixture.fakeDeleteFile,
      )
    }

    const a = await readLocationManifest(fixture.api, 'backups:a')
    const b = await readLocationManifest(fixture.api, 'backups:b')
    expect(a.archives).toHaveLength(3)
    expect(b.archives).toHaveLength(5)
    expect(a.archives.map((e) => e.id)).toEqual(['x5', 'x4', 'x3'])
    expect(b.archives.map((e) => e.id)).toEqual(['x5', 'x4', 'x3', 'x2', 'x1'])
  })
})
