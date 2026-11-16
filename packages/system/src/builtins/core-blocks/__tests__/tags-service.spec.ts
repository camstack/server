/**
 * The `tags` cap (D1054) over REAL stores: one fixture record per owner kind, each
 * carrying a tag AND a marked unrelated field, so a rename that rebuilt a record
 * from scratch (and dropped the mark) fails here, not on a live hub.
 */
import {
  defaultTagColorId,
  type IconKey,
  normalizeTags,
  type RecordKindHandle,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { ActionsStore } from '../actions-store.js'
import { coreBlocksRecordKinds, type TemplateRowBody } from '../record-kinds.js'
import { SchedulersStore } from '../scheduler/scheduler-store.js'
import type { TagOwnerPort } from '../tags-service.js'
import { buildTagsService } from '../tags-wiring.js'
import { coreBlockRecordsHarness, recordingLogger } from './fixtures.js'
import type { CoreBlockStore } from '../core-block-store.js'

const { logger } = recordingLogger()
const STAR: IconKey = 'star'

interface FakeDevice {
  readonly id: number
  tags: string[]
  readonly mark: string
}

function fakeDevices(devices: FakeDevice[], failOn?: number): TagOwnerPort {
  return {
    list: async () => devices.map((d) => ({ id: String(d.id), tags: d.tags })),
    setTags: async (id, tags) => {
      if (failOn !== undefined && Number(id) === failOn) throw new Error('device manager refused')
      const device = devices.find((d) => d.id === Number(id))
      if (device === undefined) throw new Error('unknown device')
      device.tags = tags
    },
  }
}

interface FakeRule {
  readonly id: string
  tags: string[]
  readonly mark: string
}

/** The notification rules as the `tags` cap reaches them: `listRules` + `setRuleTags`. */
function fakeRules(rules: FakeRule[]): TagOwnerPort {
  return {
    list: async () => rules.map((r) => ({ id: r.id, tags: r.tags })),
    setTags: async (id, tags) => {
      const rule = rules.find((r) => r.id === id)
      if (rule === undefined) throw new Error('unknown rule')
      rule.tags = tags
    },
  }
}

interface World {
  readonly tags: ReturnType<typeof buildTagsService>
  readonly blocks: CoreBlockStore
  readonly schedulers: SchedulersStore
  readonly actions: ActionsStore
  readonly templates: RecordKindHandle<TemplateRowBody>
  readonly devices: FakeDevice[]
  readonly rules: FakeRule[]
  readonly styles: {
    get(id: string): Promise<{ data: { name: string; color: string; icon: string } } | null>
  }
}

async function world(failDevice?: number): Promise<World> {
  const { store, records } = await coreBlockRecordsHarness(logger, { newId: () => 'blk-1' })
  await store.load()
  const devices: FakeDevice[] = [
    { id: 41, tags: ['Garden'], mark: 'device-mark' },
    { id: 42, tags: ['garden', 'Night'], mark: 'device-mark-2' },
    { id: 43, tags: [], mark: 'untagged' },
  ]
  const rules: FakeRule[] = [
    { id: 'rule-1', tags: ['GARDEN', 'Night'], mark: 'rule-mark' },
    { id: 'rule-2', tags: [], mark: 'rule-untagged' },
  ]
  const tags = buildTagsService({
    records,
    blocks: () => store,
    api: () => undefined,
    logger,
    devices: fakeDevices(devices, failDevice),
    notificationRules: fakeRules(rules),
  })
  const schedulers = new SchedulersStore({
    schedulers: records.kind(coreBlocksRecordKinds.schedulers),
    state: records.kind(coreBlocksRecordKinds['scheduler-state']),
    newId: () => 'sch-1',
  })
  const actions = new ActionsStore({
    actions: records.kind(coreBlocksRecordKinds.actions),
    links: records.kind(coreBlocksRecordKinds['action-links']),
    newId: () => 'act-1',
  })
  const templates = records.kind(coreBlocksRecordKinds.templates)
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
  await schedulers.create({
    name: 'Marked scheduler',
    enabled: true,
    priority: 77,
    maxLateMs: 5000,
    profiles: [],
    tags: ['GARDEN'],
  })
  await actions.create({
    name: 'Marked action',
    steps: [{ kind: 'wait', seconds: 1 }],
    minDelaySec: 33,
    tags: ['Garden'],
  })
  await templates.put({
    id: 'tpl-1',
    data: {
      kind: 'remote',
      name: 'Marked template',
      payload: { mark: 'template-payload' },
      tags: ['garden'],
      createdAt: 1,
      updatedAt: 2,
    },
  })
  return {
    tags,
    blocks: store,
    schedulers,
    actions,
    templates,
    devices,
    rules,
    styles: records.kind(coreBlocksRecordKinds['tag-styles']),
  }
}

let w: World

beforeEach(async () => {
  w = await world()
})

describe('stores persist and normalise tags', () => {
  it('a core block round-trips trimmed, de-duplicated tags', () => {
    expect(w.blocks.get('blk-1')?.tags).toEqual(['Garden', 'Solo'])
  })

  it('an update with tags normalises them; one without leaves them', async () => {
    await w.blocks.update('blk-1', { tags: ['  A ', 'a', ''] })
    expect(w.blocks.get('blk-1')?.tags).toEqual(['A'])
    await w.blocks.update('blk-1', { enabled: false })
    expect(w.blocks.get('blk-1')?.tags).toEqual(['A'])
  })

  it('a scheduler and an action keep tags on create and edit', async () => {
    expect((await w.schedulers.get('sch-1'))?.tags).toEqual(['GARDEN'])
    const existing = await w.schedulers.get('sch-1')
    expect(existing).not.toBeNull()
    const edited = await w.schedulers.update('sch-1', {
      name: 'Marked scheduler',
      enabled: true,
      priority: 77,
      maxLateMs: 5000,
      profiles: [],
      tags: [' x ', 'X'],
    })
    expect(edited.tags).toEqual(['x'])
    const action = await w.actions.get('internal:act-1')
    expect(action?.tags).toEqual(['Garden'])
  })
})

describe('list', () => {
  it('counts per kind, matching case-insensitively, and derives an unstyled tag', async () => {
    const list = await w.tags.list({})
    const garden = list.find((t) => t.name.toLowerCase() === 'garden')
    expect(garden?.counts).toEqual({
      coreBlocks: 1,
      schedulers: 1,
      templates: 1,
      actions: 1,
      devices: 2,
      notificationRules: 1,
    })
    expect(garden).toMatchObject({
      styled: false,
      color: defaultTagColorId('garden'),
      icon: 'tag',
    })
    expect(list.map((t) => t.name).toSorted()).toEqual(['Garden', 'Night', 'Solo'].toSorted())
  })

  it('includes a styled tag that nothing uses, with zero counts', async () => {
    await w.tags.setStyle({ name: 'Orphan', color: 'tag-c', icon: STAR })
    const orphan = (await w.tags.list({})).find((t) => t.name === 'Orphan')
    expect(orphan).toMatchObject({
      styled: true,
      color: 'tag-c',
      icon: STAR,
      counts: {
        coreBlocks: 0,
        schedulers: 0,
        templates: 0,
        actions: 0,
        devices: 0,
        notificationRules: 0,
      },
    })
  })
})

describe('rename', () => {
  it('moves the tag on all six owner kinds and keeps every marked field', async () => {
    const result = await w.tags.rename({ from: ' garden ', to: 'Yard' })
    expect(result.updated).toEqual({
      coreBlocks: 1,
      schedulers: 1,
      templates: 1,
      actions: 1,
      devices: 2,
      notificationRules: 1,
    })
    const block = w.blocks.get('blk-1')
    expect(block).toMatchObject({ name: 'Marked block', tags: ['Yard', 'Solo'] })
    const scheduler = await w.schedulers.get('sch-1')
    expect(scheduler).toMatchObject({ priority: 77, tags: ['Yard'] })
    const action = await w.actions.get('internal:act-1')
    expect(action).toMatchObject({ minDelaySec: 33, tags: ['Yard'] })
    const template = await w.templates.get('tpl-1')
    expect(template?.data).toMatchObject({ payload: { mark: 'template-payload' }, tags: ['Yard'] })
    expect(w.devices.map((d) => [d.id, d.tags, d.mark])).toEqual([
      [41, ['Yard'], 'device-mark'],
      [42, ['Yard', 'Night'], 'device-mark-2'],
      [43, [], 'untagged'],
    ])
    expect(w.rules.map((r) => [r.id, r.tags, r.mark])).toEqual([
      ['rule-1', ['Yard', 'Night'], 'rule-mark'],
      ['rule-2', [], 'rule-untagged'],
    ])
  })

  it('a rename leaves a core block updatedAt alone', async () => {
    const before = w.blocks.get('blk-1')?.updatedAt
    expect(before).toBeDefined()
    await w.tags.rename({ from: 'Garden', to: 'Yard' })
    expect(w.blocks.get('blk-1')?.updatedAt).toBe(before)
  })

  it('a 41-character target is refused and nothing is written', async () => {
    await expect(w.tags.rename({ from: 'Garden', to: 'x'.repeat(41) })).rejects.toThrow(
      /not a valid tag name/,
    )
    expect(w.blocks.get('blk-1')?.tags).toEqual(['Garden', 'Solo'])
    expect(w.devices[0]?.tags).toEqual(['Garden'])
  })

  it('a rename that would leave a record past the per-record cap refuses before any write', async () => {
    const crowded = Array.from({ length: 20 }, (_, i) => `t${i}`)
    w.devices.push({ id: 44, tags: ['Garden', ...crowded], mark: 'crowded' })
    await expect(w.tags.rename({ from: 'Garden', to: 'Yard' })).rejects.toThrow(
      /nothing was written/,
    )
    expect(w.blocks.get('blk-1')?.tags).toEqual(['Garden', 'Solo'])
    expect(w.devices[0]?.tags).toEqual(['Garden'])
  })

  it('a rename does not reset a scheduler timeline', async () => {
    await w.schedulers.setProcessedUntil('sch-1', 123)
    await w.tags.rename({ from: 'Garden', to: 'Yard' })
    expect(await w.schedulers.processedUntil('sch-1')).toBe(123)
  })

  it('merging onto an existing tag keeps the TARGET style and drops the source style', async () => {
    await w.tags.setStyle({ name: 'Garden', color: 'tag-a', icon: 'sun' })
    await w.tags.setStyle({ name: 'Yard', color: 'tag-e', icon: STAR })
    await w.tags.rename({ from: 'Garden', to: 'yard' })
    expect(await w.styles.get('garden')).toBeNull()
    expect((await w.styles.get('yard'))?.data).toEqual({ name: 'Yard', color: 'tag-e', icon: STAR })
  })

  it('moves the style when the target is unstyled', async () => {
    await w.tags.setStyle({ name: 'Garden', color: 'tag-b', icon: STAR })
    await w.tags.rename({ from: 'Garden', to: 'Yard' })
    expect(await w.styles.get('garden')).toBeNull()
    expect((await w.styles.get('yard'))?.data).toEqual({ name: 'Yard', color: 'tag-b', icon: STAR })
  })

  it('an empty target throws before anything is written', async () => {
    await expect(w.tags.rename({ from: 'Garden', to: '   ' })).rejects.toThrow(
      /not a valid tag name/,
    )
    expect(w.blocks.get('blk-1')?.tags).toEqual(['Garden', 'Solo'])
    expect(w.devices[0]?.tags).toEqual(['Garden'])
  })

  it('a failing device is reported, the rest still move, and the style stays put', async () => {
    const failing = await world(42)
    await failing.tags.setStyle({ name: 'Garden', color: 'tag-b', icon: STAR })
    await expect(failing.tags.rename({ from: 'Garden', to: 'Yard' })).rejects.toThrow(
      /repeat the call/,
    )
    expect(failing.blocks.get('blk-1')?.tags).toEqual(['Yard', 'Solo'])
    expect(failing.devices[0]?.tags).toEqual(['Yard'])
    expect(failing.devices[1]?.tags).toEqual(['garden', 'Night'])
    expect(await failing.styles.get('garden')).not.toBeNull()
  })
})

describe('remove', () => {
  it('drops the tag from every owner, keeps the other tags, and deletes the style', async () => {
    await w.tags.setStyle({ name: 'Garden', color: 'tag-b', icon: STAR })
    const result = await w.tags.remove({ name: 'GARDEN' })
    expect(result.updated).toEqual({
      coreBlocks: 1,
      schedulers: 1,
      templates: 1,
      actions: 1,
      devices: 2,
      notificationRules: 1,
    })
    expect(w.blocks.get('blk-1')?.tags).toEqual(['Solo'])
    expect((await w.schedulers.get('sch-1'))?.tags).toBeUndefined()
    expect((await w.schedulers.get('sch-1'))?.priority).toBe(77)
    expect((await w.actions.get('internal:act-1'))?.tags).toBeUndefined()
    expect((await w.templates.get('tpl-1'))?.data.tags).toBeUndefined()
    expect(w.devices.map((d) => d.tags)).toEqual([[], ['Night'], []])
    expect(w.rules.map((r) => [r.tags, r.mark])).toEqual([
      [['Night'], 'rule-mark'],
      [[], 'rule-untagged'],
    ])
    expect(await w.styles.get('garden')).toBeNull()
    expect(normalizeTags(w.devices.flatMap((d) => d.tags))).toEqual(['Night'])
  })
})
