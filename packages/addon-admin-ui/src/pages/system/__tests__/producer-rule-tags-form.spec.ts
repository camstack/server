/**
 * D1054 in the producer editors: summaries, timelapses and calendar-events rules
 * carry `tags` like an event rule. The form reads them back, a create sends them
 * only when there are some, and a patch sends them only when they CHANGED — a
 * save that echoed stale tags would undo a rename made elsewhere (the `tags`
 * cap rewrites every owner while an editor is open).
 */
import { describe, expect, it } from 'vitest'
import {
  buildCalendarEventsCreateInput,
  buildCalendarEventsPatch,
  calendarEventsRuleToForm,
  parseCalendarEventsRules,
} from '../notification-calendar-events.helpers'
import {
  buildSummaryCreateInput,
  buildSummaryPatch,
  isEditableSummaryRule,
  parseSummaryRules,
  summaryRuleToForm,
} from '../notification-summaries.helpers'
import {
  buildTimelapseCreateInput,
  buildTimelapsePatch,
  parseTimelapseRules,
  timelapseRuleToForm,
} from '../notification-timelapse.helpers'

const SCHEDULE = {
  windows: [{ days: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 420 }],
  timezone: 'Europe/Rome',
}

const SUMMARY_WIRE = {
  id: 'sum_1',
  name: 'Overnight sweep',
  enabled: true,
  deviceIds: [101],
  window: { kind: 'motion', quietSeconds: 300, maxWindowSeconds: 3600 },
  maxTiles: 9,
  maxAiImages: 6,
  rank: 'importance',
  barrierSeconds: 120,
  targets: [{ targetId: 't1' }],
  deliverEmpty: false,
  priority: 3,
  createdBy: 'admin',
  createdAt: 1,
  updatedAt: 2,
  readOnly: false,
  tags: ['Garden', 'Night'],
}

const TIMELAPSE_WIRE = {
  id: 'tl_1',
  name: 'Garden timelapse',
  enabled: true,
  deviceIds: [101],
  schedule: SCHEDULE,
  cadenceSec: 30,
  framerate: 12,
  targets: [{ targetId: 't1' }],
  previewMode: 'image',
  priority: 2,
  createdBy: 'admin',
  createdAt: 1,
  updatedAt: 2,
  readOnly: false,
  tags: ['Garden'],
}

const CALENDAR_WIRE = {
  id: 'cal_1',
  name: 'Week ahead',
  enabled: true,
  schedule: SCHEDULE,
  horizonDays: 7,
  deliverEmpty: false,
  targets: [{ targetId: 't1' }],
  priority: 3,
  tags: ['Garden'],
}

function summaryRule() {
  const rule = parseSummaryRules({ rules: [SUMMARY_WIRE] })?.[0]
  if (rule === undefined || !isEditableSummaryRule(rule)) throw new Error('fixture must parse')
  return rule
}

function timelapseRule() {
  const rule = parseTimelapseRules({ rules: [TIMELAPSE_WIRE] })?.[0]
  if (rule === undefined) throw new Error('fixture must parse')
  return rule
}

function calendarRule() {
  const rule = parseCalendarEventsRules({ rules: [CALENDAR_WIRE] })?.[0]
  if (rule === undefined) throw new Error('fixture must parse')
  return rule
}

describe('summary rule tags in the editor', () => {
  it('reads the stored tags into the form', () => {
    expect(summaryRuleToForm(summaryRule()).tags).toEqual(['Garden', 'Night'])
  })

  it('a save that did not touch the tags sends no tags key', () => {
    const rule = summaryRule()
    const patch = buildSummaryPatch({ ...summaryRuleToForm(rule), name: 'Renamed' }, rule)
    expect(patch).not.toHaveProperty('tags')
    expect(patch).toMatchObject({ name: 'Renamed' })
  })

  it('a changed list is sent whole; a cleared list is sent as []', () => {
    const rule = summaryRule()
    const form = summaryRuleToForm(rule)
    expect(buildSummaryPatch({ ...form, tags: ['Yard'] }, rule).tags).toEqual(['Yard'])
    expect(buildSummaryPatch({ ...form, tags: [] }, rule).tags).toEqual([])
  })

  it('a create sends tags only when there are some', () => {
    const form = summaryRuleToForm(summaryRule())
    expect(buildSummaryCreateInput(form).tags).toEqual(['Garden', 'Night'])
    expect(buildSummaryCreateInput({ ...form, tags: [] })).not.toHaveProperty('tags')
  })
})

describe('timelapse rule tags in the editor', () => {
  it('round-trips, sends nothing when unchanged and [] when cleared', () => {
    const rule = timelapseRule()
    const form = timelapseRuleToForm(rule)
    expect(form.tags).toEqual(['Garden'])
    expect(buildTimelapsePatch({ ...form, name: 'Renamed' }, rule)).not.toHaveProperty('tags')
    expect(buildTimelapsePatch({ ...form, tags: [] }, rule).tags).toEqual([])
    expect(buildTimelapseCreateInput({ ...form, tags: [] })).not.toHaveProperty('tags')
  })
})

describe('calendar-events rule tags in the editor', () => {
  it('round-trips, sends nothing when unchanged and the new list when renamed', () => {
    const rule = calendarRule()
    const form = calendarEventsRuleToForm(rule)
    expect(form.tags).toEqual(['Garden'])
    expect(buildCalendarEventsPatch({ ...form, name: 'Renamed' }, rule)).not.toHaveProperty('tags')
    expect(buildCalendarEventsPatch({ ...form, tags: ['Yard'] }, rule)['tags']).toEqual(['Yard'])
    expect(buildCalendarEventsCreateInput({ ...form, tags: [] })).not.toHaveProperty('tags')
  })
})
