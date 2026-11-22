import { linkedTriggerValues, type TemplateInstance } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  chipIds,
  chipsOff,
  commandCapOf,
  filterSummary,
  pickedOf,
  newTriggerParams,
  offeredActions,
  triggerRows,
  withRowAction,
  withRowFilter,
  withoutRow,
} from '../linked-triggers-model'

function instance(blockId: string, values: TemplateInstance['values']): TemplateInstance {
  return { blockId, name: blockId, enabled: true, templateId: 'builtin:linked-trigger', values }
}

/** The instance that runs on the hub: one button, short press, channels 1 and 2, toggles a light. */
const live = instance(
  '4864c0cc',
  linkedTriggerValues({
    targetDeviceId: 5767,
    action: 'toggle',
    sources: [
      { kind: 'device-fired', deviceId: 12, sourceIds: ['1'], eventIds: ['PRESS_SHORT'] },
      { kind: 'device-fired', deviceId: 12, sourceIds: ['2'], eventIds: ['PRESS_SHORT'] },
    ],
  }),
)

describe('triggerRows', () => {
  it('shows two sources of one device as one row with both parts', () => {
    const read = triggerRows([live])
    expect(read.unreadable).toEqual([])
    expect(read.rows).toEqual([
      {
        key: '4864c0cc:12',
        blockId: '4864c0cc',
        deviceId: 12,
        action: 'toggle',
        capability: 'switch',
        enabled: true,
        flagged: false,
        filter: { kind: 'fired', events: ['PRESS_SHORT'], parts: ['1', '2'] },
      },
    ])
  })

  it('gives one row per source device of an instance', () => {
    const read = triggerRows([
      instance(
        'b',
        linkedTriggerValues({
          targetDeviceId: 1,
          action: 'on',
          sources: [
            { kind: 'device-fired', deviceId: 7 },
            { kind: 'device-event', deviceId: 8, category: 'doorbell' },
          ],
        }),
      ),
    ])
    expect(read.rows.map((r) => [r.deviceId, r.filter])).toEqual([
      [7, { kind: 'fired', events: [], parts: [] }],
      [8, { kind: 'category', categories: ['doorbell'] }],
    ])
  })

  it('never flattens a filter one source cannot say', () => {
    const read = triggerRows([
      instance(
        'c',
        linkedTriggerValues({
          targetDeviceId: 1,
          action: 'on',
          sources: [
            { kind: 'device-fired', deviceId: 7, sourceIds: ['1'], eventIds: ['A'] },
            { kind: 'device-fired', deviceId: 7, sourceIds: ['2'], eventIds: ['B'] },
          ],
        }),
      ),
      instance(
        'd',
        linkedTriggerValues({
          targetDeviceId: 1,
          action: 'on',
          sources: [{ kind: 'device-fired', deviceId: 9, kinds: ['press'] }],
        }),
      ),
    ])
    expect(read.rows.map((r) => r.filter.kind)).toEqual(['custom', 'custom'])
  })

  it('names an instance it cannot read instead of dropping it', () => {
    const read = triggerRows([instance('x', { target: 1 })])
    expect(read.rows).toEqual([])
    expect(read.unreadable).toEqual([{ blockId: 'x', name: 'x' }])
  })
})

describe('row edits', () => {
  it('changes the action of the instance', () => {
    const next = withRowAction(live, 'off')
    expect(next?.action).toBe('off')
    expect(next?.sources).toHaveLength(2)
  })

  it('rewrites one device’s sources as a single source and keeps the others', () => {
    const two = instance(
      'b',
      linkedTriggerValues({
        targetDeviceId: 1,
        action: 'on',
        sources: [
          { kind: 'device-fired', deviceId: 7, sourceIds: ['1'] },
          { kind: 'device-fired', deviceId: 8 },
        ],
      }),
    )
    expect(withRowFilter(two, 7, { events: ['PRESS_LONG'], parts: [] })?.sources).toEqual([
      { kind: 'device-fired', deviceId: 7, eventIds: ['PRESS_LONG'] },
      { kind: 'device-fired', deviceId: 8 },
    ])
  })

  it('removing the last source device asks for the instance to be deleted', () => {
    expect(withoutRow(live, 12)).toEqual({ kind: 'delete' })
  })

  it('removing one of two source devices keeps the instance', () => {
    const two = instance(
      'b',
      linkedTriggerValues({
        targetDeviceId: 1,
        action: 'on',
        sources: [
          { kind: 'device-fired', deviceId: 7 },
          { kind: 'device-fired', deviceId: 8 },
        ],
      }),
    )
    const next = withoutRow(two, 7)
    expect(next.kind === 'update' ? next.params.sources : null).toEqual([
      { kind: 'device-fired', deviceId: 8 },
    ])
  })

  it('a new trigger is any event of the picked device, toggling when the cap can', () => {
    expect(newTriggerParams(5767, 12, 'switch')).toEqual({
      targetDeviceId: 5767,
      action: 'toggle',
      capability: 'switch',
      sources: [{ kind: 'device-fired', deviceId: 12 }],
    })
  })
})

describe('what a device can be commanded with', () => {
  it('offers on, off and toggle for a switch', () => {
    expect(offeredActions('switch')).toEqual(['on', 'off', 'toggle'])
  })

  it('picks the first commandable cap the device carries, null when none', () => {
    expect(commandCapOf(['motion', 'switch'])).toBe('switch')
    expect(commandCapOf(['motion'])).toBeNull()
  })
})

describe('the event and part chips', () => {
  it('offers the declared ids and any stored id the device no longer declares', () => {
    expect(chipIds(['1', '2'], ['2', '9'])).toEqual(['1', '2', '9'])
  })

  it('reads "any" as every chip on, and a pick as the others off', () => {
    expect([...chipsOff(['1', '2', '3'], [])]).toEqual([])
    expect([...chipsOff(['1', '2', '3'], ['2'])]).toEqual(['1', '3'])
  })

  it('writes every chip on as "any" and refuses an empty pick', () => {
    expect(pickedOf(['1', '2'], new Set())).toEqual([])
    expect(pickedOf(['1', '2'], new Set(['1']))).toEqual(['2'])
    expect(pickedOf(['1', '2'], new Set(['1', '2']))).toBeNull()
  })
})

describe('filterSummary', () => {
  it('says the events and the parts by their tokens', () => {
    expect(filterSummary({ kind: 'fired', events: ['PRESS_SHORT'], parts: ['1', '2'] })).toEqual({
      events: ['PRESS_SHORT'],
      parts: ['1', '2'],
      custom: false,
    })
    expect(filterSummary({ kind: 'category', categories: ['doorbell'] })).toEqual({
      events: ['doorbell'],
      parts: [],
      custom: false,
    })
    expect(filterSummary({ kind: 'custom' })).toEqual({ events: [], parts: [], custom: true })
  })
})
