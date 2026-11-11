import { AUTOMATION_LEAF_KINDS, type AutomationLeafKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildKindPicker,
  type KindPickerInput,
  type KindTexts,
  rememberRecentKind,
} from '../condition-kind-picker-model'

const TEXTS: Readonly<Record<AutomationLeafKind, KindTexts>> = {
  detection: {
    label: 'An object is detected',
    description: 'A camera sees a person',
    example: 'a person in the driveway',
  },
  stationary: {
    label: 'An object stops or leaves',
    description: 'An object parks',
    example: 'a car parks',
  },
  'device-becomes': {
    label: 'Device value becomes',
    description: 'A value changes',
    example: 'the door opens',
  },
  'device-event': {
    label: 'An event happens',
    description: 'The system reports an event',
    example: 'doorbell pressed',
  },
  schedule: {
    label: 'On a schedule',
    description: 'At a time of day',
    example: 'every day at 23:30',
  },
  interval: {
    label: 'Every few minutes',
    description: 'At a fixed pace',
    example: 'every 5 minutes',
  },
  manual: { label: 'Only when run by hand', description: 'You press Run', example: 'a scene' },
  'device-is': {
    label: 'Device value is',
    description: 'A value is, right now',
    example: 'power above 3 kW',
  },
  'stationary-present': {
    label: 'Object is parked',
    description: 'Parked right now',
    example: 'a car is in the yard',
  },
  'time-is': {
    label: 'Time is',
    description: 'The clock is inside a window',
    example: 'only between 22:00 and 06:00',
  },
  'triggered-by': {
    label: 'Started by',
    description: 'One of the chosen triggers started the run',
    example: 'the button, not the motion sensor',
  },
  expression: {
    label: 'Expression',
    description: 'Arithmetic across values',
    example: 'solar minus load',
  },
}

const CATEGORY_LABELS = {
  devices: 'Devices',
  time: 'Time & schedule',
  cameras: 'Cameras & detection',
  events: 'Events',
  logic: 'Logic & formulas',
  system: 'System',
} as const

function input(over: Partial<KindPickerInput> = {}): KindPickerInput {
  return {
    context: 'trigger',
    query: '',
    textsOf: (kind) => TEXTS[kind],
    categoryLabelOf: (category) => CATEGORY_LABELS[category],
    underNot: false,
    treeFull: false,
    recent: [],
    suggested: [],
    ...over,
  }
}

function kindsOf(view: ReturnType<typeof buildKindPicker>): AutomationLeafKind[] {
  return view.groups.flatMap((g) => g.items.map((i) => i.kind))
}

describe('buildKindPicker', () => {
  it('shows every kind once, grouped in category order, events before states', () => {
    const view = buildKindPicker(input())
    expect([...kindsOf(view)].sort()).toEqual([...AUTOMATION_LEAF_KINDS].sort())
    expect(view.groups.map((g) => g.category)).toEqual([
      'devices',
      'time',
      'cameras',
      'events',
      'logic',
      'system',
    ])
    const devices = view.groups[0]
    expect(devices?.items.map((i) => i.kind)).toEqual(['device-becomes', 'device-is'])
    expect(devices?.count).toBe(2)
    const cameras = view.groups[2]
    expect(cameras?.items.map((i) => i.role)).toEqual(['event', 'event', 'state'])
  })

  it('finds a kind by a keyword that is in no visible text, and Enter picks it', () => {
    const view = buildKindPicker(input({ query: 'stable' }))
    expect(kindsOf(view)).toEqual(['device-is'])
    expect(view.firstEnabled).toBe('device-is')
  })

  it('needs every word of the query, in any of label, description, example, keywords, category', () => {
    expect(kindsOf(buildKindPicker(input({ query: 'device becomes' })))).toEqual(['device-becomes'])
    expect(kindsOf(buildKindPicker(input({ query: 'cameras parked' }))).sort()).toEqual([
      'stationary',
      'stationary-present',
    ])
    expect(kindsOf(buildKindPicker(input({ query: 'zzz' })))).toEqual([])
    expect(buildKindPicker(input({ query: 'zzz' })).firstEnabled).toBeNull()
  })

  it('ranks a label that STARTS with the word above one that only contains it', () => {
    // Three labels hold "object"; only "Object is parked" starts with it, and it
    // is the LAST of them in catalogue order.
    const view = buildKindPicker(input({ query: 'object' }))
    expect(kindsOf(view)).toContain('detection')
    expect(view.firstEnabled).toBe('stationary-present')
  })

  it('keeps event kinds visible in a guard, disabled with the reason, and never picks one on Enter', () => {
    const view = buildKindPicker(input({ context: 'guard' }))
    const all = view.groups.flatMap((g) => g.items)
    expect(all.length).toBe(AUTOMATION_LEAF_KINDS.length)
    for (const item of all) {
      expect(item.disabled).toBe(item.role === 'event' ? 'event-in-guard' : null)
    }
    expect(view.firstEnabled).toBe('device-is')
    // 'cron' finds the schedule row alone (an event); 'schedule' is also the name of the time group, which holds a state
    expect(buildKindPicker(input({ context: 'guard', query: 'cron' })).firstEnabled).toBeNull()
  })

  it('disables event kinds under NOT, and every kind when the tree is full', () => {
    const underNot = buildKindPicker(input({ underNot: true })).groups.flatMap((g) => g.items)
    expect(underNot.find((i) => i.kind === 'detection')?.disabled).toBe('event-under-not')
    expect(underNot.find((i) => i.kind === 'device-is')?.disabled).toBeNull()
    const full = buildKindPicker(input({ treeFull: true }))
    expect(full.groups.flatMap((g) => g.items).every((i) => i.disabled === 'tree-full')).toBe(true)
    expect(full.firstEnabled).toBeNull()
  })

  it('shows recent and suggested kinds only while the search is empty, without repeats', () => {
    const view = buildKindPicker(
      input({
        recent: ['schedule', 'device-is', 'schedule'],
        suggested: ['device-is', 'detection'],
      }),
    )
    expect(view.suggested.map((i) => i.kind)).toEqual(['device-is', 'detection'])
    expect(view.recent.map((i) => i.kind)).toEqual(['schedule'])
    const searching = buildKindPicker(
      input({ query: 'sched', recent: ['schedule'], suggested: ['detection'] }),
    )
    expect(searching.recent).toEqual([])
    expect(searching.suggested).toEqual([])
  })
})

describe('rememberRecentKind', () => {
  it('puts the newest first, once, and keeps the list short', () => {
    expect(rememberRecentKind(['schedule', 'manual'], 'manual')).toEqual(['manual', 'schedule'])
    const long = rememberRecentKind(
      ['a', 'b', 'c', 'd', 'e'].map(() => 'schedule' as const),
      'manual',
    )
    expect(long).toEqual(['manual', 'schedule'])
    expect(
      rememberRecentKind(['schedule', 'interval', 'manual', 'detection'], 'expression').length,
    ).toBe(4)
  })
})
