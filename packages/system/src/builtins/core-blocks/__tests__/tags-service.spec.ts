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
  type TagBody,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionsStore } from '../actions-store.js'
import { coreBlocksRecordKinds, type TemplateRowBody } from '../record-kinds.js'
import { SchedulersStore } from '../scheduler/scheduler-store.js'
import { type TagOwnerPort, TagOwnerUnreachableError } from '../tags-service.js'
import type { TagRecord } from '@camstack/types'
import { buildTagsService, parseRuleTagOwnerId, ruleTagOwnerId } from '../tags-wiring.js'
import { coreBlockRecordsHarness, recordingLogger } from './fixtures.js'
import type { CoreBlockStore } from '../core-block-store.js'

const { logger } = recordingLogger()
const STAR: IconKey = 'star'

interface FakeDevice {
  readonly id: number
  tags: string[]
  tagIds?: string[]
  readonly mark: string
}

function fakeDevices(devices: FakeDevice[], failOn?: number): TagOwnerPort {
  return {
    storage: 'ids',
    list: async () =>
      devices.map((d) => ({ id: String(d.id), tags: d.tags, tagIds: d.tagIds ?? [] })),
    setTagIds: async (id, tagIds) => {
      const device = devices.find((d) => d.id === Number(id))
      if (device === undefined) throw new Error('unknown device')
      device.tagIds = tagIds
    },
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

/**
 * The notification rules as the `tags` cap reaches them: `listRuleTags` +
 * `setRuleTags`, every kind behind one port, ids `<kind>:<ruleId>`.
 * `unreachable` is the post-analysis owner being down: its read throws.
 */
function fakeRules(rules: FakeRule[], unreachable = false): TagOwnerPort {
  return {
    storage: 'names',
    list: async () => {
      if (unreachable) throw new Error('provider not available: notificationRules')
      return rules.map((r) => ({ id: r.id, tags: r.tags, tagIds: [] }))
    },
    setTagIds: async () => {
      throw new Error('a notification rule carries names only')
    },
    setTags: async (id, tags) => {
      const rule = rules.find((r) => r.id === id)
      if (rule === undefined) throw new Error('unknown rule')
      rule.tags = tags
    },
  }
}

/** Rules whose notification center ran its tag-ids step: the port stores ids and one write sets both. */
function fakeIdRules(rules: FakeRule[], ids: Map<string, string[]>): TagOwnerPort {
  return {
    storage: 'ids',
    list: async () => rules.map((r) => ({ id: r.id, tags: r.tags, tagIds: ids.get(r.id) ?? [] })),
    setTagIds: async (id, tagIds) => {
      ids.set(id, tagIds)
    },
    setTagsAndIds: async (id, tags, tagIds) => {
      const rule = rules.find((r) => r.id === id)
      if (rule === undefined) throw new Error('unknown rule')
      rule.tags = tags
      ids.set(id, tagIds)
    },
    setTags: async (id, tags) => {
      const rule = rules.find((r) => r.id === id)
      if (rule === undefined) throw new Error('unknown rule')
      rule.tags = tags
      // A names-only write: the ids no longer describe them.
      ids.delete(id)
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
  readonly styles: RecordKindHandle<TagBody>
}

async function world(
  failDevice?: number,
  rulesUnreachable = false,
  rulesPort?: (rules: FakeRule[]) => TagOwnerPort,
): Promise<World> {
  const { store, records } = await coreBlockRecordsHarness(logger, { newId: () => 'blk-1' })
  await store.load()
  const devices: FakeDevice[] = [
    { id: 41, tags: ['Garden'], mark: 'device-mark' },
    { id: 42, tags: ['garden', 'Night'], mark: 'device-mark-2' },
    { id: 43, tags: [], mark: 'untagged' },
  ]
  const rules: FakeRule[] = [
    { id: 'event:rule-1', tags: ['GARDEN', 'Night'], mark: 'rule-mark' },
    { id: 'event:rule-2', tags: [], mark: 'rule-untagged' },
    // A non-event kind: tags live on the base of every rule kind.
    { id: 'summary:sum-1', tags: ['Garden'], mark: 'summary-mark' },
  ]
  const tags = buildTagsService({
    records,
    blocks: () => store,
    api: () => undefined,
    logger,
    devices: fakeDevices(devices, failDevice),
    notificationRules:
      rulesPort === undefined ? fakeRules(rules, rulesUnreachable) : rulesPort(rules),
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
    styles: records.kind(coreBlocksRecordKinds.tags),
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
      notificationRules: 2,
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
      notificationRules: 2,
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
      ['event:rule-1', ['Yard', 'Night'], 'rule-mark'],
      ['event:rule-2', [], 'rule-untagged'],
      ['summary:sum-1', ['Yard'], 'summary-mark'],
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

  it('a rename does not reset a scheduler timeline', async () => {
    await w.schedulers.setProcessedUntil('sch-1', 123)
    await w.tags.rename({ from: 'Garden', to: 'Yard' })
    expect(await w.schedulers.processedUntil('sch-1')).toBe(123)
  })

  it('an empty target throws before anything is written', async () => {
    await expect(w.tags.rename({ from: 'Garden', to: '   ' })).rejects.toThrow(
      /not a valid tag name/,
    )
    expect(w.blocks.get('blk-1')?.tags).toEqual(['Garden', 'Solo'])
    expect(w.devices[0]?.tags).toEqual(['Garden'])
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
      notificationRules: 2,
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
      [[], 'summary-mark'],
    ])
    expect((await w.tags.listTags({})).map((t) => t.name)).not.toContain('Garden')
    expect(normalizeTags(w.devices.flatMap((d) => d.tags))).toEqual(['Night'])
  })
})

describe('an unreachable owner (notification rules down)', () => {
  it('list still answers: that owner counts null (unknown, never 0), the others stand', async () => {
    const down = await world(undefined, true)
    const garden = (await down.tags.list({})).find((t) => t.name.toLowerCase() === 'garden')
    expect(garden?.counts).toEqual({
      coreBlocks: 1,
      schedulers: 1,
      templates: 1,
      actions: 1,
      devices: 2,
      notificationRules: null,
    })
  })
})

describe('notification-rule owner ids', () => {
  it('round-trip every rule kind, and a bare id is refused', () => {
    for (const kind of ['event', 'summary', 'timelapse', 'calendar-events'] as const) {
      expect(parseRuleTagOwnerId(ruleTagOwnerId(kind, 'a:b'))).toEqual({ kind, ruleId: 'a:b' })
    }
    expect(() => parseRuleTagOwnerId('rule-1')).toThrow(/not a notification-rule owner id/)
  })
})

/** Point every owner at the tag by ID, the way a migrated fleet is (D1089). */
async function adopt(world0: World, tag: TagRecord): Promise<void> {
  await world0.blocks.setTagIds('blk-1', [tag.id])
  await world0.schedulers.setTagIds('sch-1', [tag.id])
  await world0.actions.setTagIds('internal:act-1', [tag.id])
  const template = await world0.templates.get('tpl-1')
  if (template === null) throw new Error('fixture template missing')
  await world0.templates.put({ id: 'tpl-1', data: { ...template.data, tagIds: [tag.id] } })
  for (const device of world0.devices) {
    if (device.tags.length > 0) device.tagIds = [tag.id]
  }
}

async function tagRows(world0: World): Promise<string> {
  const page = await world0.styles.query({})
  return JSON.stringify(page.records.map((r) => [r.id, r.data]).toSorted())
}

describe('tags are records with an id (D1089)', () => {
  it('ensureTag returns the existing tag for the same name, and the id is not the name', async () => {
    const a = await w.tags.ensureTag({ name: 'Garden' })
    const b = await w.tags.ensureTag({ name: '  gARDEN ' })
    expect(b.id).toBe(a.id)
    expect(a.id).not.toBe('garden')
    expect((await w.tags.listTags({})).map((t) => t.name)).toEqual(['Garden'])
  })

  it('a rename writes exactly ONE record and touches no owner', async () => {
    const garden = await w.tags.ensureTag({ name: 'Garden' })
    const night = await w.tags.ensureTag({ name: 'Night' })
    await adopt(w, garden)
    const before = JSON.parse(await tagRows(w)) as [string, unknown][]
    const blockBefore = JSON.stringify(w.blocks.get('blk-1'))
    const deviceBefore = JSON.stringify(w.devices)
    const rulesBefore = JSON.stringify(w.rules)

    await w.tags.updateTag({ id: garden.id, patch: { name: 'Orchard' } })

    const after = JSON.parse(await tagRows(w)) as [string, unknown][]
    const changed = after.filter(
      ([id, data]) => JSON.stringify(data) !== JSON.stringify(before.find(([i]) => i === id)?.[1]),
    )
    expect(changed.map(([id]) => id)).toEqual([garden.id])
    expect(after).toHaveLength(2)
    expect(night.id).not.toBe(garden.id)
    expect(JSON.stringify(w.blocks.get('blk-1'))).toBe(blockBefore)
    expect(JSON.stringify(w.devices)).toBe(deviceBefore)
    // A rule still holding text only is the one owner that follows, or it would name a tag
    // nothing carries any more.
    expect(JSON.stringify(w.rules)).not.toBe(rulesBefore)
    expect(w.rules.map((r) => r.tags)).toEqual([['Orchard', 'Night'], [], ['Orchard']])
  })

  it('a rule filing the tag by NAME still carries it after a rename (names-only rule)', async () => {
    const garden = await w.tags.ensureTag({ name: 'Garden' })
    await w.tags.updateTag({ id: garden.id, patch: { name: 'Yard' } })
    const listed = (await w.tags.list({})).find((t) => t.name === 'Yard')
    expect(listed?.counts.notificationRules).toBe(2)
    // No stray unstyled "Garden" is left behind by the rule that still named it.
    expect((await w.tags.list({})).map((t) => t.name)).not.toContain('Garden')
  })

  it('a migrated rule keeps its ids across a rename and is not rewritten', async () => {
    const ids = new Map<string, string[]>()
    const m = await world(undefined, false, (rules) => fakeIdRules(rules, ids))
    const garden = await m.tags.ensureTag({ name: 'Garden' })
    ids.set('event:rule-1', [garden.id])
    const before = JSON.stringify(m.rules)
    await m.tags.updateTag({ id: garden.id, patch: { name: 'Yard' } })
    // rule-1 carries the id: untouched. summary:sum-1 has no ids yet: it follows by name.
    expect(m.rules.find((r) => r.id === 'event:rule-1')?.tags).toEqual(['GARDEN', 'Night'])
    expect(ids.get('event:rule-1')).toEqual([garden.id])
    expect(m.rules.find((r) => r.id === 'summary:sum-1')?.tags).toEqual(['Yard'])
    expect(JSON.stringify(m.rules)).not.toBe(before)
    const listed = (await m.tags.list({})).find((t) => t.name === 'Yard')
    expect(listed?.counts.notificationRules).toBe(2)
  })

  it('a rename needs no owner to be reachable', async () => {
    const down = await world(undefined, true)
    const tag = await down.tags.ensureTag({ name: 'Garden' })
    const renamed = await down.tags.updateTag({ id: tag.id, patch: { name: 'Orchard' } })
    expect(renamed.name).toBe('Orchard')
  })

  it('a rename onto another tag name is refused and writes nothing', async () => {
    const garden = await w.tags.ensureTag({ name: 'Garden' })
    await w.tags.ensureTag({ name: 'Night' })
    const before = await tagRows(w)
    await expect(w.tags.updateTag({ id: garden.id, patch: { name: ' night ' } })).rejects.toThrow(
      /name already taken/,
    )
    expect(await tagRows(w)).toBe(before)
  })

  it('deleteTag clears the id from every owner, keeps the others, and removes the record', async () => {
    const garden = await w.tags.ensureTag({ name: 'Garden' })
    await adopt(w, garden)
    const result = await w.tags.deleteTag({ id: garden.id })
    expect(result.updated).toEqual({
      coreBlocks: 1,
      schedulers: 1,
      templates: 1,
      actions: 1,
      devices: 2,
      notificationRules: 2,
    })
    expect(w.blocks.get('blk-1')?.tagIds).toBeUndefined()
    expect((await w.schedulers.get('sch-1'))?.tagIds).toBeUndefined()
    expect((await w.schedulers.get('sch-1'))?.priority).toBe(77)
    expect((await w.templates.get('tpl-1'))?.data.tagIds).toBeUndefined()
    expect(w.devices.map((d) => d.tagIds)).toEqual([[], [], undefined])
    expect(w.rules.map((r) => r.tags)).toEqual([['Night'], [], []])
    expect(await w.tags.listTags({})).toEqual([])
  })

  it('deleteTag refuses while an owner cannot be read, naming it, and writes nothing', async () => {
    const down = await world(undefined, true)
    const tag = await down.tags.ensureTag({ name: 'Garden' })
    await adopt(down, tag)
    await expect(down.tags.deleteTag({ id: tag.id })).rejects.toBeInstanceOf(
      TagOwnerUnreachableError,
    )
    expect(down.blocks.get('blk-1')?.tagIds).toEqual([tag.id])
    expect((await down.tags.listTags({})).map((t) => t.id)).toEqual([tag.id])
  })

  it('an owner pointing at an id with no record reads as unset: list answers, nothing throws', async () => {
    await w.blocks.setTagIds('blk-1', ['tag_gone'])
    const list = await w.tags.list({})
    expect(list.map((t) => t.name)).not.toContain('tag_gone')
  })

  it('setStyle creates the record and the old list shows it styled', async () => {
    await w.tags.setStyle({ name: 'Orchard', color: 'tag-b', icon: STAR })
    const entry = (await w.tags.list({})).find((t) => t.name === 'Orchard')
    expect(entry).toMatchObject({ styled: true, color: 'tag-b', icon: 'star' })
  })

  it('the rename shim is one record write for a plain rename, and merges onto an existing tag', async () => {
    const garden = await w.tags.ensureTag({ name: 'Garden' })
    const night = await w.tags.ensureTag({ name: 'Night' })
    await adopt(w, garden)
    const spy = vi.spyOn(w.blocks, 'setTagIds')
    await w.tags.rename({ from: 'Garden', to: 'Orchard' })
    expect(spy).not.toHaveBeenCalled()
    expect((await w.tags.listTags({})).map((t) => t.name).toSorted()).toEqual(['Night', 'Orchard'])

    await w.tags.rename({ from: 'Orchard', to: 'Night' })
    expect((await w.tags.listTags({})).map((t) => t.id)).toEqual([night.id])
    expect(w.blocks.get('blk-1')?.tagIds).toEqual([night.id])
  })
})
