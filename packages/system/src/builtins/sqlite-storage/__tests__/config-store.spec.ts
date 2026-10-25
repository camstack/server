import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../config-store.js'

describe('ConfigStore', () => {
  let db: Database.Database
  let store: ConfigStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE addon_config (
        addon_id TEXT NOT NULL,
        stable_id TEXT,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_addon_config_global ON addon_config(addon_id) WHERE stable_id IS NULL;
      CREATE UNIQUE INDEX idx_addon_config_device ON addon_config(addon_id, stable_id) WHERE stable_id IS NOT NULL;
    `)
    store = new ConfigStore(db)
  })

  it('saves and loads addon global config (stable_id = null)', () => {
    store.save('reolink', null, { logLevel: 'debug' })
    const data = store.load('reolink', null)
    expect(data).toEqual({ logLevel: 'debug' })
  })

  it('saves and loads device config (stable_id set)', () => {
    store.save('reolink', 'cam-01', { channel: 1, subStream: false })
    const data = store.load('reolink', 'cam-01')
    expect(data).toEqual({ channel: 1, subStream: false })
  })

  it('returns empty object for missing config', () => {
    const data = store.load('reolink', 'nonexistent')
    expect(data).toEqual({})
  })

  it('upserts on duplicate', () => {
    store.save('reolink', 'cam-01', { channel: 1 })
    store.save('reolink', 'cam-01', { channel: 2 })
    const data = store.load('reolink', 'cam-01')
    expect(data).toEqual({ channel: 2 })
  })

  it('removes config by stable_id', () => {
    store.save('reolink', 'cam-01', { channel: 1 })
    store.remove('reolink', 'cam-01')
    expect(store.load('reolink', 'cam-01')).toEqual({})
  })

  it('removes addon global config', () => {
    store.save('reolink', null, { logLevel: 'debug' })
    store.remove('reolink', null)
    expect(store.load('reolink', null)).toEqual({})
  })
})
