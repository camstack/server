/**
 * #487 / D1032 — the summary, timelapse and calendar-events editors round-trip
 * `targetOverrides`: load a rule, edit ONE target, save, and the payload carries
 * the edit plus every untouched target. The patch merges over the stored rule,
 * so a map that named only the edited target would wipe the others.
 */
import type { NcTargetOverrides } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildCalendarEventsCreateInput,
  buildCalendarEventsPatch,
  calendarEventsRuleToForm,
  parseCalendarEventsRules,
} from '../notification-calendar-events.helpers'
import {
  buildTimelapsePatch,
  parseTimelapseRules,
  timelapseRuleToForm,
} from '../notification-timelapse.helpers'
import {
  buildSummaryCreateInput,
  buildSummaryPatch,
  isEditableSummaryRule,
  parseSummaryRules,
  summaryRuleToForm,
} from '../notification-summaries.helpers'
import { writeTargetOverride } from '../rule-form-target-settings'

const STORED: NcTargetOverrides = {
  phone: { priority: 5, attachment: 'image', template: { title: 'Phone title' } },
  echo: { template: { title: 'Speak' }, actions: false },
}

const EDITED: NcTargetOverrides = writeTargetOverride(STORED, 'phone', {
  ...STORED['phone'],
  priority: 2,
})

const SCHEDULE = {
  windows: [{ days: [1, 2], startMinute: 0, endMinute: 420 }],
  timezone: 'Europe/Rome',
}

const SUMMARY_WIRE = {
  id: 'sum_1',
  name: 'Morning digest',
  enabled: true,
  deviceIds: [101],
  window: { kind: 'schedule', schedule: SCHEDULE },
  maxTiles: 9,
  maxAiImages: 6,
  rank: 'importance',
  barrierSeconds: 120,
  targets: [{ targetId: 'phone' }, { targetId: 'echo' }],
  deliverEmpty: false,
  priority: 3,
  targetOverrides: STORED,
  createdBy: 'admin',
  createdAt: 1000,
  readOnly: false,
}

const TIMELAPSE_WIRE = {
  id: 'tl_1',
  name: 'Front door',
  enabled: true,
  deviceIds: [101],
  schedule: SCHEDULE,
  cadenceSec: 30,
  framerate: 12,
  targets: [{ targetId: 'phone' }, { targetId: 'echo' }],
  previewMode: 'image',
  priority: 3,
  targetOverrides: STORED,
  createdBy: 'admin',
  createdAt: 1000,
  updatedAt: 1000,
  readOnly: false,
}

const CALENDAR_WIRE = {
  id: 'cal_1',
  name: 'Morning calendar',
  enabled: true,
  schedule: SCHEDULE,
  horizonDays: 1,
  deliverEmpty: false,
  targets: [{ targetId: 'phone' }, { targetId: 'echo' }],
  priority: 3,
  targetOverrides: STORED,
  readOnly: false,
}

describe('summary editor', () => {
  const rule = parseSummaryRules({ rules: [SUMMARY_WIRE] })![0]!
  if (!isEditableSummaryRule(rule)) throw new Error('fixture must be editable')

  it('loads the stored overrides into the form', () => {
    expect(summaryRuleToForm(rule).targetOverrides).toEqual(STORED)
  })

  it('opening and saving unchanged sends no overrides at all', () => {
    expect(buildSummaryPatch(summaryRuleToForm(rule), rule)).toEqual({})
  })

  it('editing one target sends that edit AND the untouched target', () => {
    const patch = buildSummaryPatch({ ...summaryRuleToForm(rule), targetOverrides: EDITED }, rule)
    expect(patch).toEqual({ targetOverrides: EDITED })
    expect(patch.targetOverrides?.['echo']).toEqual(STORED['echo'])
  })

  it('clearing the last override sends `{}`, which replaces the stored map', () => {
    const patch = buildSummaryPatch({ ...summaryRuleToForm(rule), targetOverrides: {} }, rule)
    expect(patch).toEqual({ targetOverrides: {} })
  })

  it('a create carries the map only when something is set', () => {
    const base = summaryRuleToForm(rule)
    expect(buildSummaryCreateInput(base).targetOverrides).toEqual(STORED)
    expect(buildSummaryCreateInput({ ...base, targetOverrides: {} })).not.toHaveProperty(
      'targetOverrides',
    )
  })

  it('an override of a target no longer selected is not saved', () => {
    const form = { ...summaryRuleToForm(rule), targetIds: ['phone'] }
    expect(buildSummaryPatch(form, rule)).toMatchObject({
      targets: [{ targetId: 'phone' }],
      targetOverrides: { phone: STORED['phone'] },
    })
  })
})

describe('timelapse editor', () => {
  const rule = parseTimelapseRules({ rules: [TIMELAPSE_WIRE] })![0]!

  it('loads the stored overrides into the form', () => {
    expect(timelapseRuleToForm(rule).targetOverrides).toEqual(STORED)
  })

  it('opening and saving unchanged sends an empty patch', () => {
    expect(buildTimelapsePatch(timelapseRuleToForm(rule), rule)).toEqual({})
  })

  it('editing one target sends that edit AND the untouched target', () => {
    const patch = buildTimelapsePatch(
      { ...timelapseRuleToForm(rule), targetOverrides: EDITED },
      rule,
    )
    expect(patch).toEqual({ targetOverrides: EDITED })
  })

  it('clearing every override sends `{}`', () => {
    const patch = buildTimelapsePatch({ ...timelapseRuleToForm(rule), targetOverrides: {} }, rule)
    expect(patch).toEqual({ targetOverrides: {} })
  })
})

describe('calendar-events editor', () => {
  const rule = parseCalendarEventsRules({ rules: [CALENDAR_WIRE] })![0]!

  it('reads the stored overrides (a hub answer is not stripped of them)', () => {
    expect(rule.targetOverrides).toEqual(STORED)
    expect(calendarEventsRuleToForm(rule).targetOverrides).toEqual(STORED)
  })

  it('editing one target sends that edit AND the untouched target', () => {
    const patch = buildCalendarEventsPatch(
      { ...calendarEventsRuleToForm(rule), targetOverrides: EDITED },
      rule,
    )
    expect(patch['targetOverrides']).toEqual(EDITED)
  })

  it('clearing every override on a rule that had some sends `{}`', () => {
    const patch = buildCalendarEventsPatch(
      { ...calendarEventsRuleToForm(rule), targetOverrides: {} },
      rule,
    )
    expect(patch['targetOverrides']).toEqual({})
  })

  it('a create names the map only when something is set', () => {
    const form = calendarEventsRuleToForm(rule)
    expect(buildCalendarEventsCreateInput({ ...form, targetOverrides: {} })).not.toHaveProperty(
      'targetOverrides',
    )
  })

  it('a rule that never had overrides is not given an empty map by a save', () => {
    const { targetOverrides: _none, ...bare } = CALENDAR_WIRE
    const plain = parseCalendarEventsRules({ rules: [bare] })![0]!
    const patch = buildCalendarEventsPatch(calendarEventsRuleToForm(plain), plain)
    expect(patch).not.toHaveProperty('targetOverrides')
  })
})
