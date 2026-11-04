import { describe, expect, it } from 'vitest'
import { bandToken, bandsAt, clipBands, type ChartBand } from '../chart-bands'

const band = (id: string, from: number, to: number): ChartBand => ({
  id,
  from,
  to,
  title: 'Run',
  label: '10m',
  tone: 'success',
})

describe('chart bands', () => {
  it('finds the bands under a cursor, edges included', () => {
    const bands = [band('a', 10, 20), band('b', 20, 30), band('c', 40, 50)]
    expect(bandsAt(bands, 20).map((b) => b.id)).toEqual(['a', 'b'])
    expect(bandsAt(bands, 35)).toEqual([])
  })

  it('clips to the window and drops what lies outside', () => {
    const clipped = clipBands([band('a', 0, 15), band('b', 20, 30), band('c', 90, 99)], 10, 25)
    expect(clipped.map((b) => [b.id, b.from, b.to])).toEqual([
      ['a', 10, 15],
      ['b', 20, 25],
    ])
  })

  it('maps every tone to a theme token', () => {
    expect(bandToken('danger')).toBe('danger')
    expect(bandToken('neutral')).toBe('foreground-subtle')
  })
})
