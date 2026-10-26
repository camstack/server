import { describe, expect, it } from 'vitest'
import {
  CHART_TOUCH_SLOP_PX,
  HIDDEN_INTERACTION,
  barRangeLabel,
  barTooltipBody,
  bucketSelectionIndex,
  dataXFromPointer,
  formatTooltipValue,
  lineTooltipBody,
  nearestPointIndex,
  placeChartTooltip,
  reduceChartInteraction,
  stateSpanAt,
  stateTooltipBody,
  stepStop,
  type ChartInteraction,
} from '../chart-tooltip-model'

const GAP = 8

function touch(
  state: ChartInteraction,
  type: 'down' | 'move' | 'up',
  x: number,
  y: number,
  dataX: number | null,
): ChartInteraction {
  return reduceChartInteraction(state, { type, kind: 'touch', x, y, dataX })
}

describe('nearest point for a pointer x', () => {
  const xs = [10, 20, 30]

  it('picks the closest sample', () => {
    expect(nearestPointIndex(xs, 19)).toBe(1)
    expect(nearestPointIndex(xs, 26)).toBe(2)
  })

  it('breaks a tie toward the earlier sample', () => {
    expect(nearestPointIndex(xs, 15)).toBe(0)
    expect(nearestPointIndex(xs, 25)).toBe(1)
  })

  it('returns null when there is nothing to select', () => {
    expect(nearestPointIndex([], 10)).toBeNull()
    expect(nearestPointIndex(xs, Number.NaN)).toBeNull()
  })

  it('maps a pointer inside the plot to a data x, and refuses one outside unless clamping', () => {
    const plot = { plotLeft: 10, plotWidth: 100, xMin: 0, xMax: 200 }
    expect(dataXFromPointer({ ...plot, localX: 35, clamp: false })).toBe(50)
    expect(dataXFromPointer({ ...plot, localX: 0, clamp: false })).toBeNull()
    expect(dataXFromPointer({ ...plot, localX: 200, clamp: false })).toBeNull()
    expect(dataXFromPointer({ ...plot, localX: 200, clamp: true })).toBe(200)
    const x = dataXFromPointer({ ...plot, localX: 60, clamp: false })
    expect(x).not.toBeNull()
    expect(nearestPointIndex([0, 100, 200], x ?? 0)).toBe(1)
  })
})

describe('bucket under a pointer', () => {
  const buckets = [{ t: 0 }, { t: 100 }, { t: 300 }]

  it('selects the bucket that contains the time', () => {
    expect(bucketSelectionIndex(buckets, 100, 150)).toBe(1)
  })

  it('selects the nearest bucket when the time falls in a gap', () => {
    expect(bucketSelectionIndex(buckets, 100, 260)).toBe(2)
    expect(bucketSelectionIndex(buckets, 100, 210)).toBe(1)
  })

  it('returns null when there are no buckets', () => {
    expect(bucketSelectionIndex([], 100, 10)).toBeNull()
  })
})

describe('touch and mouse selection', () => {
  it('a tap selects and pins; a second tap hides', () => {
    let state = HIDDEN_INTERACTION
    state = touch(state, 'down', 10, 10, 100)
    expect(state.selection.visible).toBe(false)
    state = touch(state, 'up', 12, 11, 100)
    expect(state.selection).toMatchObject({ visible: true, pinned: true, dataX: 100 })
    state = touch(state, 'down', 40, 10, 300)
    state = touch(state, 'up', 42, 12, 300)
    expect(state.selection.visible).toBe(false)
  })

  it('a horizontal drag scrubs and locks page scroll; lifting keeps the selection', () => {
    let state = touch(HIDDEN_INTERACTION, 'down', 0, 0, 0)
    state = touch(state, 'move', CHART_TOUCH_SLOP_PX + 8, 2, 50)
    expect(state.lockHorizontalScroll).toBe(true)
    expect(state.selection).toMatchObject({ visible: true, pinned: true, dataX: 50 })
    state = touch(state, 'move', 40, 3, 80)
    expect(state.selection.dataX).toBe(80)
    state = touch(state, 'up', 40, 3, 80)
    expect(state.lockHorizontalScroll).toBe(false)
    expect(state.selection).toMatchObject({ visible: true, pinned: true, dataX: 80 })
  })

  it('a gesture that starts vertical does not select and does not lock horizontal scroll', () => {
    let state = touch(HIDDEN_INTERACTION, 'down', 0, 0, 0)
    state = touch(state, 'move', 2, CHART_TOUCH_SLOP_PX + 12, 999)
    expect(state.lockHorizontalScroll).toBe(false)
    expect(state.selection.visible).toBe(false)
    state = touch(state, 'move', 40, CHART_TOUCH_SLOP_PX + 14, 999)
    expect(state.lockHorizontalScroll).toBe(false)
    expect(state.selection.visible).toBe(false)
    state = touch(state, 'up', 40, 30, 999)
    expect(state.selection.visible).toBe(false)
  })

  it('mouse hover follows the point and leaving the plot hides it', () => {
    let state = reduceChartInteraction(HIDDEN_INTERACTION, {
      type: 'hover',
      dataX: 5,
      anchorX: 20,
      anchorY: 8,
    })
    expect(state.selection).toMatchObject({ visible: true, pinned: false, dataX: 5 })
    expect(state.lockHorizontalScroll).toBe(false)
    state = reduceChartInteraction(state, { type: 'leave' })
    expect(state.selection.visible).toBe(false)
  })

  it('a tap outside hides a pinned selection', () => {
    let state = touch(HIDDEN_INTERACTION, 'down', 4, 4, 12)
    state = touch(state, 'up', 4, 4, 12)
    state = reduceChartInteraction(state, { type: 'outside' })
    expect(state.selection.visible).toBe(false)
  })

  it('arrow keys walk the stops and Escape hides', () => {
    const stops = [10, 20, 30]
    expect(stepStop(stops, null, 1)).toBe(10)
    expect(stepStop(stops, 10, 1)).toBe(20)
    expect(stepStop(stops, 30, 1)).toBe(30)
    expect(stepStop(stops, null, -1)).toBe(30)
    let state = reduceChartInteraction(HIDDEN_INTERACTION, {
      type: 'key',
      dataX: 20,
      anchorX: 40,
      anchorY: 10,
    })
    expect(state.selection).toMatchObject({ visible: true, pinned: true, dataX: 20 })
    state = reduceChartInteraction(state, { type: 'hide' })
    expect(state.selection.visible).toBe(false)
  })
})

describe('tooltip placement', () => {
  it('flips to the left when the right edge would clip', () => {
    const box = placeChartTooltip({
      anchorX: 90,
      anchorY: 40,
      tooltipWidth: 40,
      tooltipHeight: 20,
      boundsWidth: 100,
      boundsHeight: 80,
      gap: GAP,
    })
    expect(box.placed).toBe('left')
    expect(box.vertical).toBe('above')
    expect(box.left).toBe(42)
    expect(box.top).toBe(12)
  })

  it('flips below when the top edge would clip', () => {
    const box = placeChartTooltip({
      anchorX: 20,
      anchorY: 8,
      tooltipWidth: 30,
      tooltipHeight: 16,
      boundsWidth: 200,
      boundsHeight: 100,
      gap: GAP,
    })
    expect(box.placed).toBe('right')
    expect(box.vertical).toBe('below')
    expect(box.left).toBe(28)
    expect(box.top).toBe(16)
  })

  it('stays inside a phone-width chart and does not cover the point', () => {
    const box = placeChartTooltip({
      anchorX: 360,
      anchorY: 40,
      tooltipWidth: 160,
      tooltipHeight: 48,
      boundsWidth: 390,
      boundsHeight: 120,
      gap: 12,
    })
    expect(box.left).toBeGreaterThanOrEqual(4)
    expect(box.left + 160).toBeLessThanOrEqual(390 - 4)
    expect(box.top).toBeGreaterThanOrEqual(4)
    expect(box.top + 48).toBeLessThanOrEqual(120 - 4)
    const coversX = box.left <= 360 && 360 <= box.left + 160
    const coversY = box.top <= 40 && 40 <= box.top + 48
    expect(coversX && coversY).toBe(false)
  })
})

describe('tooltip values carry their unit', () => {
  it('formats a base-unit temperature through the display preference', () => {
    expect(formatTooltipValue({ value: 20, quantity: 'temperature', preference: 'metric' })).toBe(
      '20 °C',
    )
    expect(formatTooltipValue({ value: 20, quantity: 'temperature', preference: 'imperial' })).toBe(
      '68 °F',
    )
  })

  it('infers the quantity from a unique unit so a raw number is never shown alone', () => {
    expect(formatTooltipValue({ value: 21.5, unit: '°C' })).toMatch(/°C$/)
    expect(formatTooltipValue({ value: 21.5, unit: '°C', preference: 'imperial' })).toMatch(/°F$/)
    expect(formatTooltipValue({ value: 1.5, unit: 'kWh' })).toBe('1.5 kWh')
    expect(formatTooltipValue({ value: 40, unit: '%' })).toBe('40%')
  })

  it('says unknown for a missing sample', () => {
    expect(formatTooltipValue({ value: null, quantity: 'temperature' })).toBe('—')
  })

  it('lists every visible series and omits a hidden one', () => {
    const body = lineTooltipBody({
      timeLabel: '10:00',
      preference: 'metric',
      series: [
        { id: 't', label: 'Temperature', value: 20, quantity: 'temperature' },
        { id: 'h', label: 'Hidden', value: 1, unit: 'W', visible: false },
        { id: 'p', label: 'Power', value: null, unit: 'W' },
      ],
    })
    expect(body.heading).toBe('10:00')
    expect(body.lines.map((l) => l.id)).toEqual(['t', 'p'])
    expect(body.lines[0]?.value).toBe('20 °C')
    expect(body.lines[1]?.value).toBe('—')
    expect(body.liveText).toContain('Temperature 20 °C')
  })

  it('names a state and how long that span lasts', () => {
    const hit = stateSpanAt(
      [
        { from: 0, to: 1_000, state: 'false' },
        { from: 1_000, to: 1_000 + 2 * 3_600_000 + 14 * 60_000, state: 'true' },
      ],
      1_500,
    )
    expect(hit).toEqual({
      state: 'true',
      spanMs: 2 * 3_600_000 + 14 * 60_000,
    })
    const body = stateTooltipBody({
      timeLabel: '10:00',
      rows: [
        { id: 'door', label: 'Door', stateLabel: 'open', spanMs: hit?.spanMs ?? null },
        { id: 'gap', label: 'Online', stateLabel: null, spanMs: null },
      ],
    })
    expect(body.lines[0]?.value).toBe('open · 2h 14m')
    expect(body.lines[1]?.value).toBe('—')
    expect(body.liveText).toContain('Door open · 2h 14m')
  })

  it('names a bar bucket by its range and its value with the unit', () => {
    const range = barRangeLabel(0, 3_600_000, 86_400_000)
    expect(range).toContain('–')
    expect(range.split('–')).toHaveLength(2)
    const body = barTooltipBody({
      rangeLabel: range,
      layers: [{ id: 'e', label: 'Energy', value: 1.5, unit: 'kWh' }],
    })
    expect(body.heading).toBe(range)
    expect(body.lines[0]?.value).toBe('1.5 kWh')
    expect(body.liveText).toContain('1.5 kWh')
  })
})
