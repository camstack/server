/**
 * A device row gets `tagIds` beside its kept `tags` names (D1089), on REAL SQLite: the id is
 * derived from the folded name so every owner mints the same one, the names stay, a row that
 * already has ids is left alone and a rerun plans nothing.
 */
import { tagIdFromKey } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { DEVICE_TAG_IDS_ID } from '../device-tag-ids.js'
import { makeMigrationWorld } from './device-manager-migration-world.js'

describe('device-tag-ids on real SQLite', () => {
  it('adds the ids, keeps the names, and leaves a row that has ids and a row without tags alone', async () => {
    const w = await makeMigrationWorld([
      { deviceId: 1, tags: ['Garden', 'Night'] },
      { deviceId: 2, tags: ['garden', 'Garden', 'GARDEN '] },
      { deviceId: 3, tags: ['Old'], tagIds: ['tag_already'] },
      { deviceId: 4 },
    ])
    expect(await w.run(DEVICE_TAG_IDS_ID)).toMatchObject({ status: 'applied', error: null })

    expect(w.device(1)).toMatchObject({
      tags: ['Garden', 'Night'],
      tagIds: [tagIdFromKey('garden'), tagIdFromKey('night')],
      mark: 'marked-survives',
    })
    // One tag in three spellings is one tag: both columns are de-duplicated and stay aligned.
    expect(w.device(2)).toMatchObject({ tags: ['garden'], tagIds: [tagIdFromKey('garden')] })
    expect(w.device(3)).toMatchObject({ tags: ['Old'], tagIds: ['tag_already'] })
    expect(w.device(4)).toMatchObject({ tags: null, tagIds: null })
  })

  it('a rerun plans nothing', async () => {
    const w = await makeMigrationWorld([{ deviceId: 1, tags: ['Garden'] }])
    await w.run(DEVICE_TAG_IDS_ID)
    expect((await w.planOf(DEVICE_TAG_IDS_ID)).edits).toEqual([])
  })

  it('refuses a row that gained ids since the plan read it', async () => {
    const w = await makeMigrationWorld([{ deviceId: 1, tags: ['Garden'] }])
    const plan = await w.planOf(DEVICE_TAG_IDS_ID)
    w.db
      .prepare('UPDATE "device-manager:devices" SET tagIds = ? WHERE deviceId = 1')
      .run('["tag_x"]')
    const out = await w.run(DEVICE_TAG_IDS_ID, () => plan)
    expect(out.status).toBe('failed')
    expect(w.device(1)['tagIds']).toEqual(['tag_x'])
  })
})
