/**
 * `readAddonStoreResult` on the in-process settings view (D651): a failed
 * read stays FAILED. `readAddonStore` answers `{}` for a store nobody wrote,
 * and a caller must never learn "never written" from a store that did not
 * answer — including a store that is not WIRED yet (the D294 window, fix
 * round 4): before `setSettingsStore`/`setSettingsDoor` the sync backend
 * reads the bootstrap file, which holds no addon key, and answered `missing`.
 */
import * as path from 'node:path'
import type { ISettingsStoreProvider } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ConfigManager } from '../config-manager.js'

const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')

/** A settings-store door whose only working method is `query`; everything else is not part of this test. */
function doorOver(query: ISettingsStoreProvider['query']): ISettingsStoreProvider {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`settings-store.${name} is not part of this test`)
  }
  return {
    query,
    get: unused('get'),
    set: unused('set'),
    upsert: unused('upsert'),
    insert: unused('insert'),
    insertMany: unused('insertMany'),
    upsertMany: unused('upsertMany'),
    transact: unused('transact'),
    update: unused('update'),
    delete: unused('delete'),
    deleteWhere: unused('deleteWhere'),
    updateWhere: unused('updateWhere'),
    count: unused('count'),
    aggregate: unused('aggregate'),
    histogram: unused('histogram'),
    isEmpty: unused('isEmpty'),
    declareCollection: unused('declareCollection'),
  }
}

function viewOver(query: ISettingsStoreProvider['query']) {
  const config = new ConfigManager(NO_CONFIG_FILE)
  const view = config.createSettingsView('pipeline-orchestrator')
  config.setSettingsDoor(doorOver(query))
  return view
}

describe('AddonSettingsView.readAddonStoreResult (door-backed)', () => {
  it('a store that throws is failed, not missing', async () => {
    const view = viewOver(async () => {
      throw new Error('door down')
    })
    expect(await view.readAddonStoreResult?.()).toEqual({
      kind: 'failed',
      error: expect.stringContaining('door down'),
    })
  })

  it('a store with no row of this addon is missing', async () => {
    const view = viewOver(async () => [])
    expect(await view.readAddonStoreResult?.()).toEqual({ kind: 'missing' })
  })

  it('a stored key comes back as a value', async () => {
    const view = viewOver(async () => [
      {
        id: 'pipeline-orchestrator.clusterModel:face-embedding',
        data: {
          addonId: 'pipeline-orchestrator',
          key: 'clusterModel:face-embedding',
          value: 'arcface-r100',
        },
      },
    ])
    const read = await view.readAddonStoreResult?.()
    expect(read?.kind).toBe('value')
    expect(read?.kind === 'value' ? Object.keys(read.value) : []).toEqual([
      'clusterModel:face-embedding',
    ])
  })
})

describe('AddonSettingsView.readAddonStoreResult (no backend wired yet)', () => {
  it('is FAILED, never missing — the bootstrap fallback holds no addon key and must not read as "never written"', async () => {
    const config = new ConfigManager(NO_CONFIG_FILE)
    const view = config.createSettingsView('pipeline-orchestrator')
    expect(await view.readAddonStoreResult?.()).toEqual({
      kind: 'failed',
      error: 'settings store not wired',
    })
  })

  it('answers from the door once it is wired — the backend is chosen per call', async () => {
    const config = new ConfigManager(NO_CONFIG_FILE)
    const view = config.createSettingsView('pipeline-orchestrator')
    expect((await view.readAddonStoreResult?.())?.kind).toBe('failed')
    config.setSettingsDoor(doorOver(async () => []))
    expect(await view.readAddonStoreResult?.()).toEqual({ kind: 'missing' })
  })
})
