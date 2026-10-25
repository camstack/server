/**
 * A repoint of a SINGLE location that shares its physical root with another
 * class (2026-10-20: `homekitClips:default` shared `/recordings/recordings` with
 * `eventMedia:default`; repointing it carried and DELETED ~8.6k event-media
 * files while a `relocateMedia` job was moving the same files).
 *
 * Two properties, both asserted through the real `LocationRepointer` over a
 * fake shared root that holds BOTH classes' files:
 *  (a) the repoint copies and deletes only its own class subtree;
 *  (b) it is mutually exclusive with a mover on the same physical root.
 */
import type { IScopedLogger, StorageLocation, StorageMigrationMover } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { LocationRepointer, RepointRefusedError } from '../location-repointer.js'
import type { RepointMoveIo } from '../location-repoint-move.js'

const SHARED_ROOT = '/recordings/recordings'
const NEW_ROOT = '/mnt/nas/clips'

const EVENT_FILES = {
  '101/events/2026-10-20/a.jpg': 'event-a',
  '101/events/2026-10-20/b.jpg': 'event-b',
  '102/events/2026-10-20/c.mp4': 'event-c',
}
const FOOTAGE_FILES = {
  '101/high/2026-10-20/seg1.mp4': 'high-1',
  '101/low/2026-10-20/seg2.mp4': 'low-1',
}
const CLIP_FILES = {
  'homekit-clips/101/clip1.mp4': 'clip-1',
  'homekit-clips/101/clip1.jpg': 'thumb-1',
}

function logger(): IScopedLogger {
  const l = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  l.child.mockReturnValue(l)
  l.withTags.mockReturnValue(l)
  // Documented type boundary: the repointer only calls these levels.
  return l as unknown as IScopedLogger
}

function row(id: string, type: string, basePath: string): StorageLocation {
  // Documented type boundary: only the fields the repointer reads.
  return {
    id,
    type,
    config: { basePath },
    mode: 'active',
  } as unknown as StorageLocation
}

interface World {
  readonly source: Map<string, string>
  readonly destination: Map<string, string>
  readonly deleted: string[]
}

function world(files: Record<string, string>): { io: RepointMoveIo; w: World } {
  const source = new Map(Object.entries(files))
  const destination = new Map<string, string>()
  const deleted: string[] = []
  const io: RepointMoveIo = {
    list: async (prefix) => {
      const depth = prefix === undefined ? 0 : prefix.split('/').length
      const names = new Set<string>()
      for (const key of source.keys()) {
        if (prefix !== undefined && !key.startsWith(`${prefix}/`)) continue
        const parts = key.split('/')
        if (parts.length > depth) names.add(parts.slice(0, depth + 1).join('/'))
      }
      return [...names]
    },
    read: async (p) => {
      const body = source.get(p)
      if (body === undefined) throw new Error(`EISDIR ${p}`)
      return Buffer.from(body)
    },
    write: async (p, data) => {
      destination.set(p, data.toString())
    },
    readBack: async (p) => Buffer.from(destination.get(p) ?? ''),
    deleteSource: async (p) => {
      deleted.push(p)
      source.delete(p)
    },
  }
  return { io, w: { source, destination, deleted } }
}

const CLIPS = row('homekitClips:default', 'homekitClips', SHARED_ROOT)
const EVENTS = row('eventMedia:default', 'eventMedia', SHARED_ROOT)
const NEXT = { id: CLIPS.id, type: CLIPS.type, config: { basePath: NEW_ROOT } }

function make(opts: {
  files: Record<string, string>
  movers?: () => Promise<readonly StorageMigrationMover[]>
}) {
  const { io, w } = world(opts.files)
  const locations = [CLIPS, EVENTS]
  const repointer = new LocationRepointer({
    logger: logger(),
    resolveKey: async (basePath) => basePath,
    locationBasePath: (id) => {
      const found = locations.find((l) => l.id === id)
      const bp = found?.config['basePath']
      return typeof bp === 'string' ? bp : null
    },
    locationIdsOfType: (type) => locations.filter((l) => l.type === type).map((l) => l.id),
    listMovers: opts.movers ?? (async () => []),
    ioFor: async () => io,
  })
  return { repointer, w }
}

function mover(
  state: 'running' | 'done',
  from: string,
  to: string,
  lane: 'media' | 'footage' = 'media',
): StorageMigrationMover {
  return {
    lane,
    job: {
      jobId: 'job-1',
      state,
      fromLocationId: from,
      toLocationId: to,
      deviceId: null,
      entities: [],
      filesMoved: 0,
      bytesMoved: 0,
      filesTotal: null,
      startedAt: 0,
      finishedAt: null,
      error: null,
    },
    migrationJobId: null,
    observedAt: 0,
  }
}

describe('repoint of a single location on a shared root', () => {
  it('(a) copies and deletes ONLY its own class subtree', async () => {
    const { repointer, w } = make({
      files: { ...EVENT_FILES, ...FOOTAGE_FILES, ...CLIP_FILES },
    })
    const commit = vi.fn(() => 'saved')

    const result = await repointer.run(CLIPS, NEXT, commit)

    expect(result).toBe('saved')
    expect([...w.destination.keys()].toSorted()).toEqual(Object.keys(CLIP_FILES).toSorted())
    expect(w.deleted.toSorted()).toEqual(Object.keys(CLIP_FILES).toSorted())
    // Every other class's file is still where it was, byte for byte.
    for (const [path, body] of Object.entries({
      ...EVENT_FILES,
      ...FOOTAGE_FILES,
    })) {
      expect(w.source.get(path)).toBe(body)
    }
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('(b) is refused while a relocate job touches the same physical root', async () => {
    const { repointer, w } = make({
      files: { ...EVENT_FILES, ...CLIP_FILES },
      movers: async () => [mover('running', '*', EVENTS.id)],
    })
    const commit = vi.fn()

    await expect(repointer.run(CLIPS, NEXT, commit)).rejects.toMatchObject({
      name: 'RepointRefusedError',
      reason: 'mover-active',
    })
    expect(w.destination.size).toBe(0)
    expect(w.deleted).toEqual([])
    expect(commit).not.toHaveBeenCalled()
  })

  it('(b) a FINISHED mover does not block the repoint', async () => {
    const { repointer, w } = make({
      files: CLIP_FILES,
      movers: async () => [mover('done', '*', EVENTS.id)],
    })
    await repointer.run(CLIPS, NEXT, () => undefined)
    expect(w.deleted.length).toBe(2)
  })

  it('(b) refuses when the movers cannot be listed (fail closed on a destructive path)', async () => {
    const { repointer, w } = make({
      files: CLIP_FILES,
      movers: async () => {
        throw new Error('recorder unreachable')
      },
    })
    await expect(repointer.run(CLIPS, NEXT, () => undefined)).rejects.toBeInstanceOf(
      RepointRefusedError,
    )
    expect(w.deleted).toEqual([])
  })

  it('(b, vice versa) a mover is refused while the repoint runs, and cleared after', async () => {
    const { repointer } = make({ files: CLIP_FILES })
    let duringRepoint: Awaited<ReturnType<typeof repointer.clearance>> | undefined
    await repointer.run(CLIPS, NEXT, async () => {
      duringRepoint = await repointer.clearance([EVENTS.id])
    })
    expect(duringRepoint).toMatchObject({
      clear: false,
      reason: 'repoint-active',
    })
    expect(await repointer.clearance([EVENTS.id])).toEqual({ clear: true })
  })

  it('a mover on an unrelated root is not blocked by a repoint', async () => {
    const { repointer } = make({ files: CLIP_FILES })
    let during: Awaited<ReturnType<typeof repointer.clearance>> | undefined
    await repointer.run(CLIPS, NEXT, async () => {
      during = await repointer.clearance(['recordings:elsewhere'])
    })
    expect(during).toEqual({ clear: true })
  })

  it('releases the claim when the copy fails', async () => {
    const failing = new LocationRepointer({
      logger: logger(),
      resolveKey: async (p) => p,
      locationBasePath: () => SHARED_ROOT,
      locationIdsOfType: () => [],
      listMovers: async () => [],
      ioFor: async () => {
        throw new Error('destination offline')
      },
    })
    await expect(failing.run(CLIPS, NEXT, () => undefined)).rejects.toThrow('destination offline')
    expect(await failing.clearance([CLIPS.id])).toEqual({ clear: true })
  })
})
