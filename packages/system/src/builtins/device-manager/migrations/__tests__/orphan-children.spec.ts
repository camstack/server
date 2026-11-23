import { defineAddonMigrations } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ORPHAN_CHILDREN_MIGRATIONS } from '../index.js'
import { type OrphanRow, orphansOf } from '../orphan-children.js'

function world(rows: readonly OrphanRow[]) {
  let live = [...rows]
  const removed: number[] = []
  const logged: string[] = []
  const ports = {
    listRows: async () => live,
    removeDevice: async (id: number) => {
      removed.push(id)
      // the tombstoned removal cascades to the row's own children
      const gone = new Set([id])
      for (let grew = true; grew; ) {
        grew = false
        for (const r of live) {
          if (r.parentDeviceId !== null && gone.has(r.parentDeviceId) && !gone.has(r.id)) {
            gone.add(r.id)
            grew = true
          }
        }
      }
      live = live.filter((r) => !gone.has(r.id))
    },
    info: (_m: string, id: number, parent: number) => logged.push(`${id}<-${parent}`),
  }
  return { ports, removed, logged, rows: () => live }
}

describe('device-manager/remove-orphan-children', () => {
  it('removes a row with a dangling parent, lists it, keeps the marked fixture rows', async () => {
    const w = world([
      { id: 1, parentDeviceId: null }, // top-level: kept
      { id: 2, parentDeviceId: 1 }, // child of a live parent: kept
      { id: 7, parentDeviceId: 99 }, // parent 99 is gone: removed
      { id: 8, parentDeviceId: 7 }, // its child goes with it
    ])
    const [migration] = defineAddonMigrations(ORPHAN_CHILDREN_MIGRATIONS, w.ports)
    const result = await migration?.execute()

    expect(result).toEqual({
      kind: 'procedure',
      result: { outcome: 'done', summary: { removed: [7] } },
    })
    expect(w.logged).toEqual(['7<-99'])
    expect(w.rows().map((r) => r.id)).toEqual([1, 2])
    expect(orphansOf(w.rows())).toEqual([])
  })

  it('is already done when nothing dangles', async () => {
    const w = world([
      { id: 1, parentDeviceId: null },
      { id: 2, parentDeviceId: 1 },
    ])
    const [migration] = defineAddonMigrations(ORPHAN_CHILDREN_MIGRATIONS, w.ports)
    expect(await migration?.execute()).toEqual({
      kind: 'procedure',
      result: { outcome: 'already-done', summary: { removed: [] } },
    })
    expect(w.removed).toEqual([])
  })
})
