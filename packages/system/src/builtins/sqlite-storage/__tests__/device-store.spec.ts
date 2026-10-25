import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { DeviceStore } from '../device-store.js'

describe('DeviceStore', () => {
  let db: Database.Database
  let store: DeviceStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addon_id TEXT NOT NULL,
        stable_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_stable_id TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(addon_id, stable_id)
      )
    `)
    store = new DeviceStore(db)
  })

  it('inserts and retrieves a device', () => {
    store.insert('reolink', {
      stableId: 'cam-01',
      type: 'camera',
      name: 'Camera 1',
      parentStableId: null,
    })
    const devices = store.listByAddon('reolink')
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ stableId: 'cam-01', type: 'camera', name: 'Camera 1' })
  })

  it('enforces unique (addon_id, stable_id)', () => {
    store.insert('reolink', {
      stableId: 'cam-01',
      type: 'camera',
      name: 'Camera 1',
      parentStableId: null,
    })
    expect(() =>
      store.insert('reolink', {
        stableId: 'cam-01',
        type: 'camera',
        name: 'Dup',
        parentStableId: null,
      }),
    ).toThrow()
  })

  it('lists children by parent', () => {
    store.insert('reolink', { stableId: 'nvr-01', type: 'hub', name: 'NVR', parentStableId: null })
    store.insert('reolink', {
      stableId: 'cam-ch1',
      type: 'camera',
      name: 'CH1',
      parentStableId: 'nvr-01',
    })
    store.insert('reolink', {
      stableId: 'cam-ch2',
      type: 'camera',
      name: 'CH2',
      parentStableId: 'nvr-01',
    })
    const children = store.listChildren('reolink', 'nvr-01')
    expect(children).toHaveLength(2)
  })

  it('removes device', () => {
    store.insert('reolink', {
      stableId: 'cam-01',
      type: 'camera',
      name: 'Camera 1',
      parentStableId: null,
    })
    store.remove('reolink', 'cam-01')
    expect(store.listByAddon('reolink')).toHaveLength(0)
  })
})
