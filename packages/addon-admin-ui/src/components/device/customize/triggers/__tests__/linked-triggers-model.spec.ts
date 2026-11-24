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
  actionChoiceOf,
  offeredChoices,
  sourceKindOf,
  rowSourceKindOf,
  withActiveWhen,
  withActiveWindow,
  withRowAction,
  withRowClasses,
  withRowFilter,
  withRowOnFor,
  withRowSource,
  withoutRow,
} from '../linked-triggers-model'

function instance(blockId: string, values: TemplateInstance['values']): TemplateInstance {
  return {
    blockId,
    name: blockId,
    enabled: true,
    templateId: 'builtin:linked-trigger',
    values,
  }
}

/** The instance that runs on the hub: one button, short press, channels 1 and 2, toggles a light. */
const live = instance(
  '4864c0cc',
  linkedTriggerValues({
    targetDeviceId: 5767,
    action: 'toggle',
    sources: [
      {
        kind: 'device-fired',
        deviceId: 12,
        sourceIds: ['1'],
        eventIds: ['PRESS_SHORT'],
      },
      {
        kind: 'device-fired',
        deviceId: 12,
        sourceIds: ['2'],
        eventIds: ['PRESS_SHORT'],
      },
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
        onForSeconds: null,
        activeWindow: null,
        activeWhen: null,
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
            {
              kind: 'device-fired',
              deviceId: 7,
              sourceIds: ['1'],
              eventIds: ['A'],
            },
            {
              kind: 'device-fired',
              deviceId: 7,
              sourceIds: ['2'],
              eventIds: ['B'],
            },
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
    expect(
      filterSummary({
        kind: 'fired',
        events: ['PRESS_SHORT'],
        parts: ['1', '2'],
      }),
    ).toEqual({
      events: ['PRESS_SHORT'],
      parts: ['1', '2'],
      custom: false,
    })
    expect(filterSummary({ kind: 'category', categories: ['doorbell'] })).toEqual({
      events: ['doorbell'],
      parts: [],
      custom: false,
    })
    expect(filterSummary({ kind: 'custom' })).toEqual({
      events: [],
      parts: [],
      custom: true,
    })
  })
})

describe('on for a time, motion and cameras', () => {
  const MOTION = {
    kind: 'device-becomes',
    deviceId: 8,
    cap: 'motion',
    fieldPath: 'detected',
    becomes: true,
  } as const
  const held = instance(
    'hall',
    linkedTriggerValues({
      targetDeviceId: 4,
      action: 'on',
      onForSeconds: 300,
      sources: [MOTION],
    }),
  )
  const camera = instance(
    'porch',
    linkedTriggerValues({
      targetDeviceId: 4,
      action: 'on',
      onForSeconds: 120,
      sources: [
        {
          kind: 'detection',
          deviceIds: [9, 10],
          subjects: [{ macro: 'person' }],
        },
      ],
    }),
  )

  it('reads a motion source held on for a time as one row', () => {
    const [row] = triggerRows([held]).rows
    expect(row).toMatchObject({
      deviceId: 8,
      action: 'on',
      onForSeconds: 300,
      activeWindow: null,
      activeWhen: null,
      filter: { kind: 'motion' },
    })
    expect(row === undefined ? null : actionChoiceOf(row)).toBe('on-for')
  })

  it('reads a camera source as one row per camera, with its classes', () => {
    const rows = triggerRows([camera]).rows
    expect(rows.map((r) => r.deviceId)).toEqual([9, 10])
    expect(rows[0]?.filter).toEqual({ kind: 'detection', classes: ['person'] })
  })

  it('a camera source narrowed to a named person is shown, never rewritten', () => {
    const named = instance(
      'named',
      linkedTriggerValues({
        targetDeviceId: 4,
        action: 'on',
        sources: [
          {
            kind: 'detection',
            deviceIds: [9],
            subjects: [
              {
                macro: 'person',
                label: { kind: 'identity', identityId: 'p1', name: 'Ada' },
              },
            ],
          },
        ],
      }),
    )
    expect(triggerRows([named]).rows[0]?.filter).toEqual({ kind: 'custom' })
  })

  it('choosing "on for" keeps the time it had, or starts at five minutes; a plain action drops it', () => {
    expect(withRowAction(held, 'on-for')?.onForSeconds).toBe(300)
    expect(withRowAction(live, 'on-for')).toMatchObject({
      action: 'on',
      onForSeconds: 300,
    })
    const plain = withRowAction(held, 'toggle')
    expect(plain?.action).toBe('toggle')
    expect(plain === null ? null : 'onForSeconds' in plain).toBe(false)
    // the values the template takes agree: no duration is written for a toggle
    expect(plain === null ? null : 'onFor' in linkedTriggerValues(plain)).toBe(false)
  })

  it('changes the time, the window and the classes of an instance', () => {
    expect(withRowOnFor(held, 3_600)?.onForSeconds).toBe(3_600)
    const window = { days: ['sat' as const, 'sun' as const] }
    expect(withActiveWindow(held, window)?.activeWindow).toEqual(window)
    const cleared = withActiveWindow(
      instance(
        'w',
        linkedTriggerValues({
          targetDeviceId: 4,
          action: 'on',
          activeWindow: window,
          sources: [MOTION],
        }),
      ),
      null,
    )
    expect(cleared === null ? null : 'activeWindow' in cleared).toBe(false)
    expect(withRowClasses(camera, 9, ['person', 'vehicle'])?.sources).toEqual([
      {
        kind: 'detection',
        deviceIds: [9, 10],
        subjects: [{ macro: 'person' }, { macro: 'vehicle' }],
      },
    ])
    expect(withRowClasses(camera, 9, [])).toBeNull()
  })

  it('removing one camera keeps the other; removing the last deletes the instance', () => {
    const removal = withoutRow(camera, 9)
    expect(removal).toMatchObject({
      kind: 'update',
      params: { sources: [{ deviceIds: [10] }] },
    })
    expect(withoutRow(held, 8)).toEqual({ kind: 'delete' })
  })

  it('a new motion or camera trigger is "on for five minutes"; a button still toggles', () => {
    expect(newTriggerParams(4, 8, 'switch', 'motion')).toEqual({
      targetDeviceId: 4,
      action: 'on',
      capability: 'switch',
      onForSeconds: 300,
      sources: [MOTION],
    })
    expect(newTriggerParams(4, 9, 'switch', 'camera')?.sources).toEqual([
      { kind: 'detection', deviceIds: [9], subjects: [{ macro: 'person' }] },
    ])
    expect(newTriggerParams(4, 12, 'switch', 'emitter')?.action).toBe('toggle')
  })

  it('offers "on for" where on can be held, and knows what a picked device is', () => {
    expect(offeredChoices('switch')).toEqual(['on', 'off', 'toggle', 'on-for'])
    expect(sourceKindOf('camera', ['motion'])).toBe('camera')
    expect(sourceKindOf('sensor', ['motion'])).toBe('motion')
    expect(sourceKindOf('button', ['event-emitter'])).toBe('emitter')
    expect(sourceKindOf('sensor', [])).toBeNull()
  })
})

describe('the device-state limit of a row', () => {
  const MOTION = {
    kind: 'device-becomes' as const,
    deviceId: 3,
    cap: 'motion',
    fieldPath: 'detected',
    becomes: true,
  }
  const night = {
    deviceId: 77,
    cap: 'binary',
    fieldPath: 'on',
    operator: 'eq' as const,
    value: false,
  }
  const base = instance(
    'n',
    linkedTriggerValues({ targetDeviceId: 4, action: 'on', sources: [MOTION] }),
  )

  it('a row reads the limit and an instance takes and drops it', () => {
    const withNight = withActiveWhen(base, night)
    expect(withNight?.activeWhen).toEqual(night)
    const read = triggerRows([
      instance(
        'n',
        linkedTriggerValues({
          ...(withNight ?? {
            targetDeviceId: 4,
            action: 'on',
            sources: [MOTION],
          }),
        }),
      ),
    ])
    expect(read.rows[0]?.activeWhen).toEqual(night)
    const cleared = withActiveWhen(
      instance(
        'n',
        linkedTriggerValues({
          targetDeviceId: 4,
          action: 'on',
          activeWhen: night,
          sources: [MOTION],
        }),
      ),
      null,
    )
    expect(cleared === null ? null : 'activeWhen' in cleared).toBe(false)
  })
})

describe('moving a row to another source device', () => {
  const perPart = instance(
    'pp',
    linkedTriggerValues({
      targetDeviceId: 5767,
      action: 'toggle',
      sources: [
        {
          kind: 'device-fired',
          deviceId: 12,
          sourceIds: ['1'],
          eventIds: ['PRESS_SHORT'],
        },
        {
          kind: 'device-fired',
          deviceId: 12,
          sourceIds: ['2'],
          eventIds: ['PRESS_LONG'],
        },
        { kind: 'device-fired', deviceId: 30, eventIds: ['PRESS_SHORT'] },
      ],
    }),
  )

  it('the same kind keeps every condition, and only the device changes', () => {
    const params = withRowSource(perPart, 12, 13, 'emitter', 'emitter')
    expect(params?.sources).toEqual([
      {
        kind: 'device-fired',
        deviceId: 13,
        sourceIds: ['1'],
        eventIds: ['PRESS_SHORT'],
      },
      {
        kind: 'device-fired',
        deviceId: 13,
        sourceIds: ['2'],
        eventIds: ['PRESS_LONG'],
      },
      { kind: 'device-fired', deviceId: 30, eventIds: ['PRESS_SHORT'] },
    ])
    expect(params?.action).toBe('toggle')
  })

  it('a camera keeps its classes and its other cameras', () => {
    const cameras = instance(
      'cam',
      linkedTriggerValues({
        targetDeviceId: 5767,
        action: 'on',
        sources: [
          {
            kind: 'detection',
            deviceIds: [40, 41],
            subjects: [{ macro: 'person' }, { macro: 'vehicle' }],
          },
        ],
      }),
    )
    expect(withRowSource(cameras, 40, 42, 'camera', 'camera')?.sources).toEqual([
      {
        kind: 'detection',
        deviceIds: [42, 41],
        subjects: [{ macro: 'person' }, { macro: 'vehicle' }],
      },
    ])
  })

  it("another kind starts from that kind's default sources, in the old position", () => {
    const params = withRowSource(perPart, 12, 14, 'emitter', 'motion')
    expect(params?.sources).toEqual([
      {
        kind: 'device-becomes',
        deviceId: 14,
        cap: 'motion',
        fieldPath: 'detected',
        becomes: true,
      },
      { kind: 'device-fired', deviceId: 30, eventIds: ['PRESS_SHORT'] },
    ])
  })

  it('reads the kind of a row from its filter', () => {
    expect(rowSourceKindOf({ kind: 'motion' })).toBe('motion')
    expect(rowSourceKindOf({ kind: 'detection', classes: ['person'] })).toBe('camera')
    expect(rowSourceKindOf({ kind: 'category', categories: ['doorbell'] })).toBe('emitter')
    expect(rowSourceKindOf({ kind: 'custom' })).toBe('emitter')
  })
})
