/**
 * Tags become records with an id (D1089), on the real records engine (a real SQLite file):
 * step 1 adds `tagIds` to the four core-blocks owners, step 2 writes one `tags` record per tag
 * in use or styled and deletes the style rows. A marked field per owner kind survives, a
 * rerun and a restored older snapshot converge, and a record the operator edited is kept.
 */
import { type IconKey, tagIdFromKey, type TagBody, type TagStyle } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { ActionsStore } from '../../actions-store.js'
import { coreBlocksRecordKinds } from '../../record-kinds.js'
import { SchedulersStore } from '../../scheduler/scheduler-store.js'
import { coreBlockRecordsHarness, recordingLogger } from '../../__tests__/fixtures.js'
import { ADDON_MIGRATIONS } from '../index.js'
import { addTagIds, CORE_BLOCKS_TAG_IDS_ID, tagIdsPortsOver } from '../tag-ids.js'
import { TAGS_AS_RECORDS_ID, tagsAsRecordsPortsOver, writeTagRecords } from '../tags-as-records.js'

const { logger } = recordingLogger()
const STAR: IconKey = 'star'
const GARDEN = tagIdFromKey('garden')
const NIGHT = tagIdFromKey('night')

type Records = Awaited<ReturnType<typeof coreBlockRecordsHarness>>['records']

async function legacyHub(): Promise<{ records: Records }> {
  const { store, records } = await coreBlockRecordsHarness(logger, { newId: () => 'blk-1' })
  await store.load()
  await store.create(
    {
      name: 'Marked block',
      code: 'export default () => {}',
      enabled: true,
      placement: 'hub',
      tags: [' Garden ', 'garden', 'Solo'],
    },
    'u1',
  )
  const schedulers = new SchedulersStore({
    schedulers: records.kind(coreBlocksRecordKinds.schedulers),
    state: records.kind(coreBlocksRecordKinds['scheduler-state']),
    newId: () => 'sch-1',
  })
  await schedulers.create({
    name: 'Marked scheduler',
    enabled: true,
    priority: 77,
    maxLateMs: 5000,
    profiles: [],
    tags: ['GARDEN'],
  })
  const actions = new ActionsStore({
    actions: records.kind(coreBlocksRecordKinds.actions),
    links: records.kind(coreBlocksRecordKinds['action-links']),
    newId: () => 'act-1',
  })
  await actions.create({
    name: 'Marked action',
    steps: [{ kind: 'wait', seconds: 1 }],
    minDelaySec: 33,
    tags: ['Garden'],
  })
  await records.kind(coreBlocksRecordKinds.templates).put({
    id: 'tpl-1',
    data: {
      kind: 'remote',
      name: 'Marked template',
      payload: { mark: 'template-payload' },
      tags: ['night'],
      createdAt: 1,
      updatedAt: 2,
    },
  })
  const style: TagStyle = { name: 'Garden', color: 'tag-c', icon: STAR }
  await records.kind(coreBlocksRecordKinds['tag-styles']).put({ id: 'garden', data: style })
  const unused: TagStyle = { name: 'Unused', color: 'tag-b', icon: STAR }
  await records.kind(coreBlocksRecordKinds['tag-styles']).put({ id: 'unused', data: unused })
  return { records }
}

function portsOf(records: Records, external: () => Promise<readonly string[]>) {
  const tagIds = tagIdsPortsOver(
    {
      blocks: records.kind(coreBlocksRecordKinds.blocks),
      schedulers: records.kind(coreBlocksRecordKinds.schedulers),
      templates: records.kind(coreBlocksRecordKinds.templates),
      actions: records.kind(coreBlocksRecordKinds.actions),
    },
    logger,
  )
  const asRecords = tagsAsRecordsPortsOver({
    tagIds,
    external,
    styles: records.kind(coreBlocksRecordKinds['tag-styles']),
    tags: records.kind(coreBlocksRecordKinds.tags),
    logger,
  })
  return { tagIds, asRecords }
}

const tagRecords = async (records: Records): Promise<Record<string, TagBody>> => {
  const page = await records.kind(coreBlocksRecordKinds.tags).query({})
  return Object.fromEntries(page.records.map((row) => [row.id, row.data]))
}

let records: Records
beforeEach(async () => {
  records = (await legacyHub()).records
})

describe('core-blocks tag ids', () => {
  it('adds the ids beside the names on every owner and keeps the marked fields', async () => {
    const { tagIds } = portsOf(records, async () => [])
    expect(await addTagIds(tagIds)).toMatchObject({ outcome: 'done', summary: { records: 4 } })

    const block = (await records.kind(coreBlocksRecordKinds.blocks).get('blk-1'))?.data
    expect(block).toMatchObject({ name: 'Marked block' })
    expect(block?.block).toMatchObject({
      tags: ['Garden', 'Solo'],
      tagIds: [GARDEN, tagIdFromKey('solo')],
    })
    const scheduler = (await records.kind(coreBlocksRecordKinds.schedulers).get('sch-1'))?.data
    expect(scheduler).toMatchObject({ priority: 77, tags: ['GARDEN'], tagIds: [GARDEN] })
    const action = (await records.kind(coreBlocksRecordKinds.actions).get('act-1'))?.data
    expect(action).toMatchObject({ minDelaySec: 33, tags: ['Garden'], tagIds: [GARDEN] })
    const template = (await records.kind(coreBlocksRecordKinds.templates).get('tpl-1'))?.data
    expect(template).toMatchObject({
      payload: { mark: 'template-payload' },
      tags: ['night'],
      tagIds: [NIGHT],
    })
  })

  it('a rerun edits nothing', async () => {
    const { tagIds } = portsOf(records, async () => [])
    await addTagIds(tagIds)
    expect(await addTagIds(tagIds)).toMatchObject({ outcome: 'already-done' })
  })

  it('fails, writing nothing for the row, when a record changed since it was read', async () => {
    const { tagIds } = portsOf(records, async () => [])
    const rows = await tagIds.listTaggedRows()
    const scheduler = rows.find((row) => row.owner === 'schedulers')
    expect(scheduler).toBeDefined()
    // The operator edits the scheduler between the read and the write.
    const schedulers = records.kind(coreBlocksRecordKinds.schedulers)
    const current = await schedulers.get('sch-1')
    if (current === null || scheduler === undefined) throw new Error('fixture')
    await schedulers.put({ id: 'sch-1', data: { ...current.data, priority: 5 } })
    await expect(tagIds.writeTagIds(scheduler, [GARDEN], null)).rejects.toThrow(/changed since/)
    expect((await schedulers.get('sch-1'))?.data).toMatchObject({ priority: 5, tags: ['GARDEN'] })
    expect((await schedulers.get('sch-1'))?.data.tagIds).toBeUndefined()
  })
})

describe('tags as records', () => {
  it('writes one record per tag in use or styled under the id the owners used, and deletes the styles', async () => {
    const { tagIds, asRecords } = portsOf(records, async () => ['Night', 'Remote only'])
    await addTagIds(tagIds)
    expect(await writeTagRecords(asRecords)).toMatchObject({
      outcome: 'done',
      summary: { tags: 5, styles: 2 },
    })

    expect(await tagRecords(records)).toEqual({
      // The style's spelling, colour and icon are carried.
      [GARDEN]: { name: 'Garden', colour: 'tag-c', icon: STAR },
      [tagIdFromKey('solo')]: { name: 'Solo' },
      // `night` and `Night` are used once each: the first by locale order.
      [NIGHT]: { name: 'night' },
      [tagIdFromKey('remote only')]: { name: 'Remote only' },
      // A styled tag nobody uses is still the operator's work.
      [tagIdFromKey('unused')]: { name: 'Unused', colour: 'tag-b', icon: STAR },
    })
    const styles = await records.kind(coreBlocksRecordKinds['tag-styles']).query({})
    expect(styles.records).toEqual([])
  })

  it('a rerun writes nothing', async () => {
    const { tagIds, asRecords } = portsOf(records, async () => [])
    await addTagIds(tagIds)
    await writeTagRecords(asRecords)
    expect(await writeTagRecords(asRecords)).toMatchObject({ outcome: 'already-done' })
  })

  it('a restored older snapshot converges: a record the operator edited is not overwritten', async () => {
    const { tagIds, asRecords } = portsOf(records, async () => [])
    await addTagIds(tagIds)
    await writeTagRecords(asRecords)
    const tags = records.kind(coreBlocksRecordKinds.tags)
    await tags.put({ id: GARDEN, data: { name: 'Yard', colour: 'tag-h', icon: STAR } })
    // An older file restores a style row of the same tag.
    const old: TagStyle = { name: 'Garden', color: 'tag-c', icon: STAR }
    await records.kind(coreBlocksRecordKinds['tag-styles']).put({ id: 'garden', data: old })
    await writeTagRecords(asRecords)
    expect((await tags.get(GARDEN))?.data).toEqual({ name: 'Yard', colour: 'tag-h', icon: STAR })
    expect((await records.kind(coreBlocksRecordKinds['tag-styles']).query({})).records).toEqual([])
  })

  it('an owner that cannot be read right now is skipped, and a styled tag is carried anyway', async () => {
    const { tagIds, asRecords } = portsOf(records, async () => {
      throw new Error('provider not available: deviceManager')
    })
    await addTagIds(tagIds)
    expect(await writeTagRecords(asRecords)).toMatchObject({ outcome: 'done' })
    expect((await tagRecords(records))[GARDEN]).toMatchObject({ name: 'Garden', colour: 'tag-c' })
  })

  it('deleting the styles is the last write: a failed record write keeps every style row', async () => {
    const { tagIds, asRecords } = portsOf(records, async () => [])
    await addTagIds(tagIds)
    const failing = {
      ...asRecords,
      createTag: async () => {
        throw new Error('disk full')
      },
    }
    await expect(writeTagRecords(failing)).rejects.toThrow(/disk full/)
    expect(
      (await records.kind(coreBlocksRecordKinds['tag-styles']).query({})).records,
    ).toHaveLength(2)
  })
})

describe('the catalogue', () => {
  it('orders the records step after the owner steps', () => {
    const step = ADDON_MIGRATIONS.find((m) => m.meta.id === TAGS_AS_RECORDS_ID)
    expect(step?.meta.dependsOn).toEqual([
      CORE_BLOCKS_TAG_IDS_ID,
      'device-manager/2026-11-23-device-tag-ids',
      'pipeline-analytics/2026-11-23-rule-tag-ids',
    ])
  })
})
