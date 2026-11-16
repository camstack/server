/**
 * Which optional log-table columns a stream offers and shows: the code's
 * choice first (the scope lock, then the prop), the viewer's toggles on top.
 */
import { describe, expect, it } from 'vitest'
import {
  availableLogColumns,
  parseStoredLogColumns,
  visibleLogColumns,
} from '../log-stream-columns'

describe('availableLogColumns', () => {
  it('offers nothing unless the page opts in', () => {
    expect(availableLogColumns({}, undefined)).toEqual([])
    expect(availableLogColumns({}, {})).toEqual([])
  })

  it('offers what the page lists', () => {
    expect(availableLogColumns({}, { available: ['integration', 'device'] })).toEqual([
      'integration',
      'device',
    ])
  })

  it('a device lock never offers the device column, an addon lock never the integration one', () => {
    const both = { available: ['integration', 'device'] } as const
    expect(availableLogColumns({ deviceId: 5 }, both)).toEqual(['integration'])
    expect(availableLogColumns({ addonId: 'recorder' }, both)).toEqual(['device'])
  })
})

describe('visibleLogColumns', () => {
  const available = ['integration', 'device'] as const

  it('shows nothing by default, only the default set when the code names one', () => {
    expect(visibleLogColumns({ available, config: undefined, stored: {} })).toEqual([])
    expect(
      visibleLogColumns({ available, config: { defaultVisible: ['integration'] }, stored: {} }),
    ).toEqual(['integration'])
  })

  it('the viewer toggle wins over the default, both ways', () => {
    const config = { defaultVisible: ['integration'] } as const
    expect(
      visibleLogColumns({ available, config, stored: { integration: false, device: true } }),
    ).toEqual(['device'])
  })

  it('a stored choice for a column the page does not offer shows nothing', () => {
    expect(
      visibleLogColumns({
        available: ['integration'],
        config: undefined,
        stored: { device: true },
      }),
    ).toEqual([])
  })
})

describe('parseStoredLogColumns', () => {
  it('reads booleans per known column and ignores everything else', () => {
    expect(parseStoredLogColumns('{"device":false,"integration":true,"x":1}')).toEqual({
      device: false,
      integration: true,
    })
    expect(parseStoredLogColumns('not json')).toEqual({})
    expect(parseStoredLogColumns(null)).toEqual({})
  })
})
