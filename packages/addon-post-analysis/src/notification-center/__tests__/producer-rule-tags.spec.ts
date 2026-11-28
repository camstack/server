/**
 * D1054 on the scheduled producers: summaries, timelapses and calendar-events
 * rules carry `tags` on the base of the rule exactly like an event rule. Each
 * fixture has a MARKED field nothing here edits, so a write that rebuilt the
 * rule and dropped a field fails here. A partial patch must keep the tags,
 * `setTags` (the `tags` cap's rename/remove) must change only the tags, and a
 * rule stored before tags existed must load and re-save without a `tags` key.
 */
import type { InMemoryRecords } from '@dominevo/types'
import { TimelapseRuleInputSchema, TimelapseRulePatchSchema } from '@dominevo/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  NcCalendarEventsRuleInputSchema,
  NcCalendarEventsRulePatchSchema,
} from '../calendar-events/calendar-events-rule.js'
import { NcCalendarEventsStore } from '../calendar-events/calendar-events-store.js'
import { NcSummaryRuleInputSchema, NcSummaryRulePatchSchema } from '../summary/summary-rule.js'
import { NcSummaryStore } from '../summary/summary-store.js'
import { TimelapseStore } from '../timelapse/timelapse-store.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'

const SCHEDULE = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }] }
const TARGETS = [{ targetId: 'tgt-1' }]

const summaryInput = (extra: Record<string, unknown> = {}) =>
  NcSummaryRuleInputSchema.parse({
    name: 'night digest',
    deviceIds: [636],
    window: { kind: 'schedule', schedule: SCHEDULE },
    targets: TARGETS,
    // The mark: a non-default value nothing in this spec edits.
    maxTiles: 12,
    ...extra,
  })

const timelapseInput = (extra: Record<string, unknown> = {}) =>
  TimelapseRuleInputSchema.parse({
    name: 'garden timelapse',
    deviceIds: [636],
    schedule: SCHEDULE,
    targets: TARGETS,
    cadenceSec: 42,
    ...extra,
  })

const calendarInput = (extra: Record<string, unknown> = {}) =>
  NcCalendarEventsRuleInputSchema.parse({
    name: 'tomorrow',
    schedule: SCHEDULE,
    targets: TARGETS,
    horizonDays: 3,
    ...extra,
  })

describe('producer rule schemas never materialise tags', () => {
  // A `.default()` would make every partial patch overwrite the stored tags.
  it('a patch that does not name tags parses without the key', () => {
    expect(NcSummaryRulePatchSchema.parse({ enabled: false })).not.toHaveProperty('tags')
    expect(TimelapseRulePatchSchema.parse({ enabled: false })).not.toHaveProperty('tags')
    expect(NcCalendarEventsRulePatchSchema.parse({ enabled: false })).not.toHaveProperty('tags')
  })

  it('a create input that does not name tags parses without the key', () => {
    expect(summaryInput()).not.toHaveProperty('tags')
    expect(timelapseInput()).not.toHaveProperty('tags')
    expect(calendarInput()).not.toHaveProperty('tags')
  })
})

describe('NcSummaryStore — tags (D1054)', () => {
  let world: InMemoryRecords
  let store: NcSummaryStore

  beforeEach(() => {
    world = makeNcRecords()
    store = NcSummaryStore.of(
      world.records,
      makeSilentLogger(),
      () => 1_000,
      () => 'sum-1',
    )
  })

  it('create normalises the tags', async () => {
    const rule = await store.create(
      summaryInput({ tags: [' Garden ', 'garden', 'Night'] }),
      'admin',
    )
    expect(rule.tags).toEqual(['Garden', 'Night'])
  })

  it('a partial patch keeps the tags and the marked field', async () => {
    await store.create(summaryInput({ tags: ['Garden'] }), 'admin')
    const patched = await store.update('sum-1', { name: 'renamed', enabled: false })
    expect(patched).toMatchObject({ name: 'renamed', tags: ['Garden'], maxTiles: 12 })
    expect(ncTable(world, 'summary-rules').get('sum-1')?.['tags']).toEqual(['Garden'])
  })

  it('setTags rewrites only the tags; [] removes the key', async () => {
    await store.create(summaryInput({ tags: ['Garden', 'Night'] }), 'admin')
    const renamed = await store.setTags('sum-1', ['Yard', 'Night'])
    expect(renamed).toMatchObject({ name: 'night digest', maxTiles: 12, tags: ['Yard', 'Night'] })
    const cleared = await store.setTags('sum-1', [])
    expect(cleared).not.toHaveProperty('tags')
    expect(ncTable(world, 'summary-rules').get('sum-1')).not.toHaveProperty('tags')
  })

  it('a rule stored before tags existed loads and re-saves without a tags key', async () => {
    await store.create(summaryInput(), 'admin')
    const reloaded = NcSummaryStore.of(world.records, makeSilentLogger(), () => 2_000)
    await reloaded.load()
    expect(reloaded.get('sum-1')).not.toHaveProperty('tags')
    const edited = await reloaded.update('sum-1', { enabled: false })
    expect(edited).not.toHaveProperty('tags')
    expect(edited.maxTiles).toBe(12)
  })
})

describe('TimelapseStore — tags (D1054)', () => {
  it('a partial patch keeps the tags; setTags rewrites only them', async () => {
    const world = makeNcRecords()
    const store = TimelapseStore.of(
      world.records,
      makeSilentLogger(),
      () => 1_000,
      () => 'tl-1',
    )
    await store.create(timelapseInput({ tags: ['Garden'] }), 'admin')
    expect(await store.update('tl-1', { name: 'renamed' })).toMatchObject({
      tags: ['Garden'],
      cadenceSec: 42,
    })
    expect(await store.setTags('tl-1', ['Yard'])).toMatchObject({
      name: 'renamed',
      cadenceSec: 42,
      tags: ['Yard'],
    })
  })
})

describe('NcCalendarEventsStore — tags (D1054)', () => {
  it('create normalises; a partial patch keeps them; setTags rewrites only them', async () => {
    const world = makeNcRecords()
    const store = NcCalendarEventsStore.of(
      world.records,
      makeSilentLogger(),
      () => 1_000,
      () => 'cal-1',
    )
    const created = await store.create(calendarInput({ tags: ['garden', 'Garden '] }), 'admin')
    expect(created.tags).toEqual(['garden'])
    expect(await store.update('cal-1', { enabled: false })).toMatchObject({
      tags: ['garden'],
      horizonDays: 3,
    })
    expect(await store.setTags('cal-1', ['Yard'])).toMatchObject({
      name: 'tomorrow',
      horizonDays: 3,
      tags: ['Yard'],
    })
  })
})
