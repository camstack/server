// @vitest-environment jsdom
/**
 * The pie scene (#694): one wedge per reading, the active one breathes with its
 * quantity's motion, a reading with no data is a dashed "—" wedge, and a tap
 * reports which wedge. Seven or more readings are `SensorGridCard`'s tiles.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { SensorGridCard } from '../scenes/sensor/SensorGridCard'
import {
  type PieReading,
  SensorPieCard,
  type SensorPieCardModel,
} from '../scenes/sensor/SensorPieCard'

afterEach(cleanup)

/** The i-th of a rendered list; a missing one fails the test by name, no cast. */
function nth<T>(list: readonly T[], i: number): T {
  const item = list[i]
  if (item === undefined) throw new Error(`no element ${String(i)} of ${String(list.length)}`)
  return item
}

const common = plugFixtures(0)[0]?.model.common
if (common === undefined) throw new Error('no plug fixture')

const reading = (id: string, over: Partial<PieReading> = {}): PieReading => ({
  id,
  quantity: 'temperature',
  value: '21',
  unit: '°C',
  label: 'Temperature',
  state: 'idle',
  ...over,
})

const model = (readings: readonly PieReading[]): SensorPieCardModel => ({
  common,
  state: { label: 'Active', since: null, tone: 'primary' },
  readings,
  updated: 'Updated · 2 min ago',
})

describe('SensorPieCard', () => {
  it('draws one wedge per reading and the updated line top-left', () => {
    render(<SensorPieCard model={model([reading('a'), reading('b', { quantity: 'humidity' })])} />)
    expect(screen.getAllByTestId('dc-pie-wedge')).toHaveLength(2)
    expect(screen.getByTestId('dc-pie-updated').textContent).toBe('Updated · 2 min ago')
  })

  it("an active reading breathes; the motion inside its wedge is the single-reading card's own", () => {
    render(
      <SensorPieCard
        model={model([
          reading('m', {
            quantity: 'motion',
            value: 'Active',
            unit: null,
            state: 'active',
            visual: { kind: 'ring', tone: 'primary', speed: 'normal', dim: false },
          }),
          reading('t', { visual: { kind: 'heat', tone: 'danger', speed: 'normal', dim: false } }),
          reading('h', { quantity: 'humidity', visual: null }),
        ])}
      />,
    )
    const [motion, temp] = screen.getAllByTestId('dc-pie-wedge')
    expect(motion?.querySelector('.dc-pie-breathe')).not.toBeNull()
    expect(temp?.querySelector('.dc-pie-breathe')).toBeNull()
    // One clipped layer per reading that has a motion, inside the pie, carrying MeasurementFx.
    const layers = screen.getAllByTestId('dc-pie-fx')
    expect(layers).toHaveLength(2)
    expect(
      layers.map((l) =>
        l.querySelector('[data-testid="dc-measurement-fx"]')?.getAttribute('data-fx'),
      ),
    ).toEqual(['ring', 'heat'])
    for (const l of layers) expect(l.getAttribute('style')).toContain('polygon(')
    expect(screen.getByTestId('dc-sensor-pie').contains(nth(layers, 0))).toBe(true)
  })

  it('a wedge with no value stays still: no motion layer, while the one with a value keeps its own', () => {
    render(
      <SensorPieCard
        model={model([
          reading('t', { visual: { kind: 'heat', tone: 'danger', speed: 'normal', dim: false } }),
          reading('l', {
            quantity: 'illuminance',
            value: '—',
            state: 'empty',
            visual: { kind: 'ring', tone: 'primary', speed: 'normal', dim: false },
          }),
        ])}
      />,
    )
    const layers = screen.getAllByTestId('dc-pie-fx')
    expect(layers.map((l) => l.getAttribute('data-quantity'))).toEqual(['temperature'])
  })

  it('a reading with no data is a dashed wedge showing a dash, never 0', () => {
    render(
      <SensorPieCard
        model={model([
          reading('a'),
          reading('l', {
            quantity: 'illuminance',
            value: '—',
            unit: 'lx',
            state: 'empty',
          }),
        ])}
      />,
    )
    const empty = screen.getAllByTestId('dc-pie-wedge')[1]
    expect(empty?.getAttribute('data-state')).toBe('empty')
    expect(empty?.querySelector('.dc-pie-empty')).not.toBeNull()
    expect(empty?.textContent).toContain('—')
    expect(empty?.textContent).not.toMatch(/\b0\b/)
  })

  it('the motion honours prefers-reduced-motion', () => {
    render(<SensorPieCard model={model([reading('a'), reading('b')])} />)
    const css = document.querySelector('style')?.textContent ?? ''
    expect(css).toContain('prefers-reduced-motion:reduce')
  })

  it('the selected wedge is highlighted in its own palette colour and the others dim', () => {
    render(
      <SensorPieCard
        model={model([reading('a'), reading('b', { quantity: 'humidity' })])}
        selectedId="b"
        detail={<p>chart</p>}
      />,
    )
    const [a, b] = screen.getAllByTestId('dc-pie-wedge')
    expect(b?.getAttribute('data-selected')).toBe('true')
    expect(b?.getAttribute('aria-pressed')).toBe('true')
    expect(b?.querySelector(':scope > path')?.getAttribute('class')).toMatch(
      /stroke-chart-series-[a-h]$/,
    )
    expect(a?.getAttribute('class')).toContain('opacity-40')
    expect(b?.getAttribute('class')).not.toContain('opacity-40')
    expect(screen.getByTestId('dc-pie-detail').textContent).toBe('chart')
  })

  it('Enter and Space select a wedge from the keyboard', () => {
    const onSelect = vi.fn()
    render(<SensorPieCard model={model([reading('a'), reading('b')])} onSelect={onSelect} />)
    const [a, b] = screen.getAllByTestId('dc-pie-wedge')
    fireEvent.keyDown(a as Element, { key: 'Enter' })
    fireEvent.keyDown(b as Element, { key: ' ' })
    expect(onSelect.mock.calls).toEqual([['a'], ['b']])
  })

  it('no two quantities that appear together share a wedge colour, and each wedge has its own edge', () => {
    const together = ['temperature', 'humidity', 'illuminance', 'motion', 'contact'] as const
    render(<SensorPieCard model={model(together.map((q) => reading(q, { quantity: q })))} />)
    const paths = screen
      .getAllByTestId('dc-pie-wedge')
      .map((w) => w.querySelector(':scope > path')?.getAttribute('class') ?? '')
    const fills = paths.map((c) => /fill-([a-z-]+)\//.exec(c)?.[1])
    expect(new Set(fills).size).toBe(together.length)
    for (const c of paths) {
      expect(c).toMatch(/fill-[a-z-]+\/(2|3|4)\d/)
      expect(c).not.toContain('stroke-border')
    }
  })

  it('a tap on a wedge reports its reading', () => {
    const onSelect = vi.fn()
    render(<SensorPieCard model={model([reading('a'), reading('b')])} onSelect={onSelect} />)
    fireEvent.click(screen.getAllByTestId('dc-pie-wedge')[1] as Element)
    expect(onSelect).toHaveBeenCalledWith('b')
  })
})

describe('SensorGridCard', () => {
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => reading(id))

  it('draws one tile per reading, none hidden behind a "+N"', () => {
    render(<SensorGridCard model={model(nine)} />)
    expect(screen.getAllByTestId('dc-grid-tile')).toHaveLength(9)
    expect(screen.queryByTestId('dc-pie-more')).toBeNull()
    expect(screen.getByTestId('dc-grid-updated').textContent).toBe('Updated · 2 min ago')
  })

  it('a reading with no data is a dashed "—" tile, never 0', () => {
    render(
      <SensorGridCard
        model={model([reading('a', { value: '—', unit: null, state: 'empty' }), ...nine])}
      />,
    )
    const [first] = screen.getAllByTestId('dc-grid-tile')
    expect(first?.getAttribute('data-state')).toBe('empty')
    expect(first?.textContent).toContain('—')
    expect(first?.className).toContain('border-dashed')
  })

  it('a tap reports the tile; the selected one is highlighted and the others dim', () => {
    const onSelect = vi.fn()
    render(
      <SensorGridCard
        model={model(nine)}
        selectedId="b"
        onSelect={onSelect}
        detail={<p>chart</p>}
      />,
    )
    const tiles = screen.getAllByTestId('dc-grid-tile')
    expect(tiles[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(tiles[0]?.className).toContain('opacity-40')
    fireEvent.click(tiles[2] as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith('c')
    expect(screen.getByTestId('dc-grid-detail').textContent).toBe('chart')
  })
})
