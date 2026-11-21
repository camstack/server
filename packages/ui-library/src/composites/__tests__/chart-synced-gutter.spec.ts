import { describe, expect, it } from 'vitest'
import { SYNCED_AXIS_SIZE, plotPadding, valueAxisSize } from '../charts/chart-uplot'

/** Total horizontal space a chart reserves left / right of its plot area. */
function extents(
  p: { leftAxis: boolean; rightAxis: boolean },
  synced: boolean,
  reserveRightAxis = false,
) {
  const pad = plotPadding({ synced, ...p, reserveRightAxis, top: 0 })
  const axisL = p.leftAxis ? valueAxisSize(4, synced) : 0
  const axisR = p.rightAxis ? valueAxisSize(4, synced) : 0
  return { left: pad[3] + axisL, right: pad[1] + axisR }
}

describe('synced chart gutters', () => {
  it('sizes a value axis to its labels when standalone, fixed when synced', () => {
    expect(valueAxisSize(6, false)).toBe(46)
    expect(valueAxisSize(11, false)).toBe(72)
    expect(valueAxisSize(2, true)).toBe(SYNCED_AXIS_SIZE)
    expect(valueAxisSize(11, true)).toBe(SYNCED_AXIS_SIZE)
  })

  it('gives line, dual-axis, bar and state charts identical x extents in a group that reserves a right axis', () => {
    const line = extents({ leftAxis: true, rightAxis: false }, true, true)
    const dual = extents({ leftAxis: true, rightAxis: true }, true, true)
    const state = extents({ leftAxis: false, rightAxis: false }, true, true)
    expect(dual).toEqual(line)
    expect(state).toEqual(line)
  })

  it('leaves no empty right column when the group has no dual-axis chart', () => {
    const line = extents({ leftAxis: true, rightAxis: false }, true)
    const state = extents({ leftAxis: false, rightAxis: false }, true)
    expect(line.right).toBe(30)
    expect(state).toEqual(line)
  })

  it('keeps standalone charts as before', () => {
    expect(plotPadding({ synced: false, leftAxis: true, rightAxis: false, top: 8 })).toEqual([
      8, 30, 0, 0,
    ])
    expect(plotPadding({ synced: false, leftAxis: false, rightAxis: false, top: 0 })).toEqual([
      0, 30, 0, 40,
    ])
  })
})
