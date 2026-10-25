/**
 * Rules-area strip helpers: producer tabs under Rules, create-type menu, and
 * the legacy top-level Summaries/Timelapses deep-link keys.
 */
import { describe, expect, it } from 'vitest'

import {
  CREATE_RULE_TYPE_OPTIONS,
  isProducerAreaKey,
  isRuleSectionArea,
  parseRulesArea,
  visibleRulesAreas,
} from '../notification-rules-area'

describe('parseRulesArea', () => {
  it('accepts rule sections and producer areas', () => {
    expect(parseRulesArea('all')).toBe('all')
    expect(parseRulesArea('detection')).toBe('detection')
    expect(parseRulesArea('summaries')).toBe('summaries')
    expect(parseRulesArea('timelapses')).toBe('timelapses')
    expect(parseRulesArea('calendar-events')).toBe('calendar-events')
    expect(parseRulesArea('nope')).toBeUndefined()
  })
})

describe('visibleRulesAreas', () => {
  it('always appends Summaries, Timelapses and Calendar events after the rule sections', () => {
    const areas = visibleRulesAreas(new Map())
    const keys = areas.map((a) => a.key)
    expect(keys.at(-3)).toBe('summaries')
    expect(keys.at(-2)).toBe('timelapses')
    expect(keys.at(-1)).toBe('calendar-events')
    expect(keys[0]).toBe('all')
  })
})

describe('create type menu', () => {
  it('offers section kinds + producers — no generic Rule', () => {
    expect(CREATE_RULE_TYPE_OPTIONS.map((o) => o.type)).toEqual([
      'detection',
      'sensor',
      'audio',
      'occupancy',
      'device-events',
      'system',
      'alarm',
      'summary',
      'timelapse',
      'calendar-events',
    ])
  })
})

describe('area predicates', () => {
  it('separates producer areas from event-rule sections', () => {
    expect(isProducerAreaKey('summaries')).toBe(true)
    expect(isProducerAreaKey('calendar-events')).toBe(true)
    expect(isProducerAreaKey('detection')).toBe(false)
    expect(isRuleSectionArea('detection')).toBe(true)
    expect(isRuleSectionArea('timelapses')).toBe(false)
    expect(isRuleSectionArea('calendar-events')).toBe(false)
  })
})

describe('strip counts', () => {
  it('exposes producer areas that carry their own counts', () => {
    // The Rules strip renders a count for every shown area. Event sections use
    // `countBySection`; producer tabs use the Summaries / Timelapses /
    // Calendar-events list lengths — both keys must stay on the strip so the
    // badges are not gated behind `isRuleSectionArea` alone.
    const areas = visibleRulesAreas(new Map([['all', 3]]))
    expect(areas.some((a) => a.key === 'summaries')).toBe(true)
    expect(areas.some((a) => a.key === 'timelapses')).toBe(true)
    expect(areas.some((a) => a.key === 'calendar-events')).toBe(true)
    expect(isRuleSectionArea('summaries')).toBe(false)
    expect(isRuleSectionArea('timelapses')).toBe(false)
    expect(isRuleSectionArea('calendar-events')).toBe(false)
  })
})
