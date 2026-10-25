/**
 * Unified Rules bags — All concatenates every family; strip tabs filter.
 */
import { describe, expect, it } from 'vitest'
import type { NcRule } from '@camstack/types'
import { parseCalendarEventsRules } from '../notification-calendar-events.helpers'
import { parseSummaryRules } from '../notification-summaries.helpers'
import { parseTimelapseRules } from '../notification-timelapse.helpers'
import {
  countForArea,
  rowsForArea,
  unifyRuleBags,
  type UnifiedRuleBags,
} from '../unified-rules-model'

function sampleEvent(overrides: Partial<NcRule> & Pick<NcRule, 'id' | 'name'>): NcRule {
  return {
    enabled: true,
    disabledTargetIds: [],
    delivery: 'immediate',
    conditions: { classes: ['person'] },
    schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 1439 }] },
    targets: [{ targetId: 't1' }],
    media: { attach: 'keyFrame' },
    throttle: { cooldownSec: 0, scope: 'rule' },
    template: { title: 'Hi', body: 'Body' },
    priority: 4,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const summaries = parseSummaryRules({
  rules: [
    {
      id: 's1',
      name: 'Morning digest',
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
    },
  ],
})

const timelapses = parseTimelapseRules({
  rules: [
    {
      id: 't1',
      name: 'Night video',
      enabled: true,
      deviceIds: [101],
      schedule: {
        windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }],
        timezone: 'Europe/Rome',
      },
      cadenceSec: 30,
      framerate: 12,
      targets: [{ targetId: 't1' }],
      previewMode: 'image',
      priority: 2,
      createdBy: 'admin',
      createdAt: 1,
      updatedAt: 2,
      readOnly: false,
    },
  ],
})

const calendarEvents = parseCalendarEventsRules({
  rules: [
    {
      id: 'c1',
      name: 'Week ahead',
      enabled: true,
      schedule: {
        timezone: 'Europe/Rome',
        windows: [{ days: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 421 }],
      },
      horizonDays: 7,
      deliverEmpty: false,
      targets: [{ targetId: 't1' }],
      priority: 3,
    },
  ],
})

const BAGS: UnifiedRuleBags = {
  events: [
    sampleEvent({ id: 'e1', name: 'Zebra sensor', delivery: 'device-event', conditions: {} }),
    sampleEvent({ id: 'e2', name: 'Alpha detect' }),
  ],
  summaries: summaries ?? [],
  timelapses: timelapses ?? [],
  calendarEvents: calendarEvents ?? [],
}

describe('unifyRuleBags / rowsForArea', () => {
  it('parses producer fixtures used by the bags', () => {
    expect(summaries).not.toBeNull()
    expect(timelapses).not.toBeNull()
    expect(calendarEvents).not.toBeNull()
  })

  it('All concatenates every family and sorts by name', () => {
    const rows = rowsForArea('all', BAGS)
    expect(rows.map((r) => r.name)).toEqual([
      'Alpha detect',
      'Morning digest',
      'Night video',
      'Week ahead',
      'Zebra sensor',
    ])
    expect(countForArea('all', BAGS)).toBe(5)
  })

  it('producer tabs keep only their family', () => {
    expect(rowsForArea('summaries', BAGS).map((r) => r.kind)).toEqual(['summary'])
    expect(rowsForArea('timelapses', BAGS).map((r) => r.kind)).toEqual(['timelapse'])
    expect(rowsForArea('calendar-events', BAGS).map((r) => r.kind)).toEqual(['calendar-events'])
  })

  it('unifyRuleBags is unsorted — rowsForArea owns R1 sort', () => {
    const raw = unifyRuleBags(BAGS)
    expect(raw[0]?.name).toBe('Zebra sensor')
  })
})
