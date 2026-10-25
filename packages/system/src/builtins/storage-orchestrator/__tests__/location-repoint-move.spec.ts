/**
 * Re-pointing a SINGLETON location moves its bytes.
 *
 * The rule and its reason: a singleton has no second instance to drain into —
 * the cardinality guard refuses to create one — so the sanctioned "add a
 * location, drain the old one" path does not exist for it. Either the repoint
 * carries the data or the data is stranded, and on 2026-09-08 it was stranded:
 * `artifacts` moved to a new root and 320 enrolled gallery blobs stayed at the
 * old one, invisible until every face in the Review panel came back 404.
 */
import { describe, expect, it } from 'vitest'
import { moveLocationTree, type RepointMoveIo } from '../location-repoint-move.js'

interface FakeWorld {
  readonly source: Map<string, string>
  readonly destination: Map<string, string>
  readonly deleted: string[]
}

function fakeIo(
  files: Record<string, string>,
  opts: { failWrite?: string } = {},
): {
  io: RepointMoveIo
  world: FakeWorld
} {
  const source = new Map(Object.entries(files))
  const destination = new Map<string, string>()
  const deleted: string[] = []
  const childrenOf = (prefix: string | undefined): readonly string[] => {
    const depth = prefix === undefined ? 0 : prefix.split('/').length
    const names = new Set<string>()
    for (const key of source.keys()) {
      if (prefix !== undefined && !key.startsWith(`${prefix}/`)) continue
      const parts = key.split('/')
      if (parts.length <= depth) continue
      names.add(parts.slice(0, depth + 1).join('/'))
    }
    return [...names]
  }
  const io: RepointMoveIo = {
    list: async (prefix) => childrenOf(prefix),
    read: async (relativePath) => {
      const body = source.get(relativePath)
      if (body === undefined) throw new Error(`EISDIR ${relativePath}`)
      return Buffer.from(body)
    },
    write: async (relativePath, data) => {
      if (opts.failWrite === relativePath) throw new Error('disk full')
      destination.set(relativePath, data.toString())
    },
    readBack: async (relativePath) => {
      const body = destination.get(relativePath)
      if (body === undefined) throw new Error(`missing after write: ${relativePath}`)
      return Buffer.from(body)
    },
    deleteSource: async (relativePath) => {
      deleted.push(relativePath)
      source.delete(relativePath)
    },
  }
  return { io, world: { source, destination, deleted } }
}

const TREE = {
  'gallery/104/events/identity/p1/crop-1.jpg': 'a',
  'gallery/104/events/identity/p1/crop-2.jpg': 'bb',
  'gallery/618/events/identity/p2/crop-3.jpg': 'ccc',
  '101/notification/still.jpg': 'dddd',
}

describe('moveLocationTree', () => {
  it('carries every file, at every depth, to the new root', async () => {
    const { io, world } = fakeIo(TREE)

    const moved = await moveLocationTree(io)

    expect(moved.files).toBe(4)
    expect(moved.bytes).toBe(1 + 2 + 3 + 4)
    expect([...world.destination.keys()].toSorted()).toEqual(Object.keys(TREE).toSorted())
  })

  it('deletes the source only AFTER every copy is verified', async () => {
    // Order is the whole safety property: a crash mid-move must leave the
    // bytes somewhere, and the somewhere that still has a location pointing at
    // it is the OLD root.
    const { io, world } = fakeIo(TREE)

    await moveLocationTree(io)

    expect(world.deleted.toSorted()).toEqual(Object.keys(TREE).toSorted())
    expect(world.source.size).toBe(0)
  })

  it('deletes NOTHING when one copy fails', async () => {
    const { io, world } = fakeIo(TREE, {
      failWrite: 'gallery/618/events/identity/p2/crop-3.jpg',
    })

    await expect(moveLocationTree(io)).rejects.toThrow(/disk full/)
    expect(world.deleted).toEqual([])
    expect(world.source.size).toBe(4)
  })

  it('refuses a copy that did not land intact', async () => {
    const { io, world } = fakeIo(TREE)
    const truncating: RepointMoveIo = {
      ...io,
      readBack: async () => Buffer.from(''),
    }

    await expect(moveLocationTree(truncating)).rejects.toThrow(/size/i)
    expect(world.deleted).toEqual([])
  })

  it('is a no-op on an empty root', async () => {
    const { io, world } = fakeIo({})
    const moved = await moveLocationTree(io)
    expect(moved).toEqual({ files: 0, bytes: 0 })
    expect(world.deleted).toEqual([])
  })
})
