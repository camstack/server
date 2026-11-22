import { EventCategory, type GroupTrigger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  actionSummary,
  nextTriggerId,
  offeredActions,
  sourceSummary,
  triggerEnabled,
  withEnabled,
  withTrigger,
  withoutTrigger,
} from '../group-triggers-model'

const remote = { addonId: 'zigbee', stableId: 'remote-1' }
const press: GroupTrigger = {
  id: 't1',
  source: { kind: 'fired', device: remote, eventIds: ['PRESS_SHORT'] },
  action: { kind: 'switch' },
}
const nameOf = (ref: { stableId: string }): string => `name-${ref.stableId}`

describe('the group triggers list model', () => {
  it('reads a trigger as one line: source then action', () => {
    expect(sourceSummary(press.source, nameOf)).toBe('name-remote-1 · PRESS_SHORT')
    expect(actionSummary(press.action)).toBe('switch')
    expect(actionSummary({ kind: 'climate', mode: 'heat', target: 21 })).toBe('climate heat 21')
    expect(
      sourceSummary({ kind: 'event', category: EventCategory.DeviceStateChanged }, nameOf),
    ).toBe(EventCategory.DeviceStateChanged)
  })

  it('edits without mutating: add, replace, disable, remove', () => {
    const list = [press] as const
    const added = withTrigger(list, { ...press, id: 't2' })
    expect(added.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(list).toHaveLength(1)
    const replaced = withTrigger(added, {
      ...press,
      id: 't2',
      action: { kind: 'on' },
    })
    expect(replaced[1]?.action).toEqual({ kind: 'on' })
    const off = withEnabled(replaced, 't1', false)
    expect(off.map(triggerEnabled)).toEqual([false, true])
    expect(withoutTrigger(off, 't1').map((t) => t.id)).toEqual(['t2'])
  })

  it('names a fresh id that is free', () => {
    expect(nextTriggerId([])).toBe('t1')
    expect(nextTriggerId([press, { ...press, id: 't3' }])).toBe('t2')
    expect(
      nextTriggerId([
        { ...press, id: 't2' },
        { ...press, id: 't3' },
      ]),
    ).toBe('t1')
  })

  it('offers the climate action only to a climate group', () => {
    expect(offeredActions('climate')).toEqual(['climate'])
    expect(offeredActions('light')).toEqual(['on', 'off', 'switch'])
  })
})
