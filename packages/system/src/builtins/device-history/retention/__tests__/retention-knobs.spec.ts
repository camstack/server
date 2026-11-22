/**
 * The retention catalog device-history contributes (D1084): a read of the policy it
 * already resolves, the two raw windows overridable per device.
 */
import { describe, expect, it } from 'vitest'
import { readRawOverrides } from '../device-raw-overrides.js'
import { deviceHistoryKnobs } from '../retention-knobs.js'
import { DEFAULT_RETENTION } from '../retention.js'

const POLICY = { ...DEFAULT_RETENTION, rawDays: 10, rawDiscreteDays: 45 }

describe('deviceHistoryKnobs', () => {
  it('lists every tier cluster-wide, the two raw windows as device-overridable', () => {
    const knobs = deviceHistoryKnobs(POLICY, undefined, undefined)
    expect(knobs.map((k) => k.key)).toEqual([
      'rawDays',
      'rawDiscreteDays',
      'fiveMinuteDays',
      'hourDays',
      'dayDays',
      'transitionDays',
    ])
    const discrete = knobs.find((k) => k.key === 'rawDiscreteDays')
    expect(discrete).toMatchObject({
      scope: 'device',
      defaultValue: 30,
      value: 45,
      write: { method: 'updateScopedSettings', key: 'rawDiscreteDays' },
    })
    expect(knobs.find((k) => k.key === 'hourDays')?.scope).toBe('cluster')
    expect(knobs.find((k) => k.key === 'dayDays')?.zeroMeansForever).toBe(true)
  })

  it('lists only the device-scoped knobs for a device, saying inherited or overridden', () => {
    const knobs = deviceHistoryKnobs(POLICY, 7, { rawDays: 3 })
    expect(knobs.map((k) => k.key)).toEqual(['rawDays', 'rawDiscreteDays'])
    expect(knobs[0]).toMatchObject({
      deviceId: 7,
      value: 3,
      inherited: false,
      inheritedValue: 10,
      write: { method: 'updateDeviceSettings', key: 'rawDays' },
    })
    expect(knobs[1]).toMatchObject({
      value: 45,
      inherited: true,
      inheritedValue: 45,
    })
  })
})

describe('readRawOverrides', () => {
  it('keeps only positive numbers, a cleared override means inherit', async () => {
    const rows = new Map<number, Record<string, unknown>>([
      [1, { rawDays: 5, other: 'x' }],
      [2, { rawDiscreteDays: null, rawDays: 0 }],
      [3, { rawDiscreteDays: 90 }],
    ])
    const out = await readRawOverrides({
      listDeviceStoreIds: async () => [...rows.keys()],
      readDeviceStoreBatch: async (ids) => new Map(ids.map((id) => [id, rows.get(id) ?? {}])),
    })
    expect([...out.entries()]).toEqual([
      [1, { rawDays: 5 }],
      [3, { rawDiscreteDays: 90 }],
    ])
  })
})
