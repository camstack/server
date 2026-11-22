/** The derived device changes over a fake history port (D1084). */
import { describe, expect, it } from 'vitest'
import {
  type AuditedSeries,
  type ChangeSeriesPort,
  DerivedChanges,
  type RawChangeRead,
} from '../derived-changes.js'

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)
const NOW = T0 + 600_000

function port(
  series: readonly AuditedSeries[],
  reads: Record<string, RawChangeRead>,
): ChangeSeriesPort {
  return {
    auditedSeries: () => series,
    readRaw: async (_id, s) => reads[`${s.capName}.${s.field}`] ?? { before: null, points: [] },
  }
}

describe('DerivedChanges', () => {
  it('turns a boolean series into one change with booleans', async () => {
    const reader = new DerivedChanges(
      port([{ capName: 'switch', field: 'on', kind: 'boolean' }], {
        'switch.on': {
          before: { t: T0 - 1_000, value: 0, state: null },
          points: [{ t: T0, value: 1, state: null }],
        },
      }),
      () => NOW,
    )
    expect(await reader.read(1, { from: T0 - 5_000, to: NOW })).toEqual([
      { capName: 'switch', field: 'on', at: T0, from: false, to: true },
    ])
  })

  it('names an enum change by its state', async () => {
    const reader = new DerivedChanges(
      port([{ capName: 'lock-control', field: 'state', kind: 'enum' }], {
        'lock-control.state': {
          before: { t: T0 - 1, value: 0, state: 'locked' },
          points: [{ t: T0, value: 1, state: 'unlocked' }],
        },
      }),
      () => NOW,
    )
    const [change] = await reader.read(1, { from: 0, to: NOW })
    expect(change).toMatchObject({ from: 'locked', to: 'unlocked' })
  })

  it('shows a gauge as its net number and skips a counter', async () => {
    const reader = new DerivedChanges(
      port(
        [
          { capName: 'brightness', field: 'level', kind: 'gauge' },
          { capName: 'meter', field: 'total', kind: 'counter' },
        ],
        {
          'brightness.level': {
            before: { t: T0 - 1, value: 10, state: null },
            points: [
              { t: T0, value: 40, state: null },
              { t: T0 + 500, value: 70, state: null },
            ],
          },
          'meter.total': { before: null, points: [{ t: T0, value: 5, state: null }] },
        },
      ),
      () => NOW,
    )
    expect(await reader.read(1, { from: 0, to: NOW })).toEqual([
      { capName: 'brightness', field: 'level', at: T0 + 500, from: 10, to: 70 },
    ])
  })

  it('narrows to a capability and answers nothing for a device with no audited series', async () => {
    const reader = new DerivedChanges(port([], {}), () => NOW)
    expect(await reader.read(1, { from: 0, to: NOW })).toEqual([])
    const switchOnly = new DerivedChanges(
      port([{ capName: 'switch', field: 'on', kind: 'boolean' }], {
        'switch.on': {
          before: { t: T0 - 1, value: 0, state: null },
          points: [{ t: T0, value: 1, state: null }],
        },
      }),
      () => NOW,
    )
    expect(await switchOnly.read(1, { from: 0, to: NOW, capName: 'lock-control' })).toEqual([])
  })
})
