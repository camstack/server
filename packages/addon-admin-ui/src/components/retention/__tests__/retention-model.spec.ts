import type { RetentionKnob } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { groupKnobs, judgeKnobValue, writeCallFor } from '../retention-model'

function knob(over: Partial<RetentionKnob>): RetentionKnob {
  return {
    id: 'a:k',
    owner: 'a',
    key: 'k',
    labelKey: 'retention.a.k',
    label: 'K',
    group: 'history',
    unit: 'days',
    defaultValue: 7,
    value: 7,
    min: 1,
    max: 60,
    zeroMeansForever: false,
    scope: 'cluster',
    write: { method: 'updateScopedSettings', addonId: 'a', cap: 'c', scope: 'cluster', key: 'k' },
    ...over,
  }
}

describe('groupKnobs', () => {
  it('groups the knobs of several owners in first-seen order and lists a knob once', () => {
    const groups = groupKnobs([
      knob({ id: 'a:1', group: 'history' }),
      knob({ id: 'b:1', owner: 'b', group: 'events' }),
      knob({ id: 'a:2', group: 'history' }),
      knob({ id: 'a:1', group: 'history' }),
    ])
    expect(groups.map((g) => [g.group, g.knobs.map((k) => k.id)])).toEqual([
      ['history', ['a:1', 'a:2']],
      ['events', ['b:1']],
    ])
  })
})

describe('judgeKnobValue', () => {
  it('accepts whole numbers inside the bounds and refuses the rest by reason', () => {
    const k = knob({})
    expect(judgeKnobValue(k, '30')).toEqual({ ok: true, value: 30 })
    expect(judgeKnobValue(k, '0')).toEqual({ ok: false, reason: 'below-min' })
    expect(judgeKnobValue(k, '61')).toEqual({ ok: false, reason: 'above-max' })
    expect(judgeKnobValue(k, '2.5')).toEqual({ ok: false, reason: 'not-whole' })
    expect(judgeKnobValue(k, '')).toEqual({ ok: false, reason: 'not-a-number' })
  })

  it('takes 0 only where it means keep forever', () => {
    expect(judgeKnobValue(knob({ zeroMeansForever: true, min: 0 }), '0')).toEqual({
      ok: true,
      value: 0,
    })
  })
})

describe('writeCallFor', () => {
  it('names the existing cluster settings call', () => {
    expect(writeCallFor(knob({}), 9)).toEqual({
      method: 'updateScopedSettings',
      input: { addonId: 'a', cap: 'c', scope: 'cluster', patch: { k: 9 } },
    })
  })

  it('names the device settings call for a device listing, and refuses one without a device', () => {
    const write = { method: 'updateDeviceSettings', addonId: 'a', key: 'k' } as const
    expect(writeCallFor(knob({ write, deviceId: 4 }), 9)).toEqual({
      method: 'updateDeviceSettings',
      input: { addonId: 'a', deviceId: 4, patch: { k: 9 } },
    })
    expect(writeCallFor(knob({ write }), 9)).toBeNull()
  })
})
