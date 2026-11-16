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
  it('an open stream offers both', () => {
    expect(availableLogColumns({}, undefined)).toEqual(['integration', 'device'])
  })

  it('a device page never offers the device column, an addon page never the integration one', () => {
    expect(availableLogColumns({ deviceId: 5 }, undefined)).toEqual(['integration'])
    expect(availableLogColumns({ addonId: 'recorder' }, undefined)).toEqual(['device'])
  })

  it('the prop wins over the lock', () => {
    expect(availableLogColumns({ deviceId: 5 }, { available: ['device'] })).toEqual(['device'])
    expect(availableLogColumns({}, { available: [] })).toEqual([])
  })
})

describe('visibleLogColumns', () => {
  const available = ['integration', 'device'] as const

  it('shows everything available by default, only the default set when the code names one', () => {
    expect(visibleLogColumns({ available, config: undefined, stored: {} })).toEqual([
      'integration',
      'device',
    ])
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
    ).toEqual(['integration'])
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
