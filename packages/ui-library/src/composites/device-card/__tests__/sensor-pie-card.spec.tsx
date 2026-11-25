// @vitest-environment jsdom
/**
 * The pie scene (#694): one wedge per reading, the active one breathes with its
 * quantity's motion, a reading with no data is a dashed "—" wedge, a "+N" wedge
 * stands for the readings past the sixth, and a tap reports which wedge.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import {
  type PieReading,
  SensorPieCard,
  type SensorPieCardModel,
} from '../scenes/sensor/SensorPieCard'

afterEach(cleanup)

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

const model = (
  readings: readonly PieReading[],
  overflow: readonly PieReading[] = [],
): SensorPieCardModel => ({
  common,
  state: { label: 'Active', since: null, tone: 'primary' },
  readings,
  overflow,
  updated: 'Updated · 2 min ago',
})

describe('SensorPieCard', () => {
  it('draws one wedge per reading and the updated line top-left', () => {
    render(<SensorPieCard model={model([reading('a'), reading('b', { quantity: 'humidity' })])} />)
    expect(screen.getAllByTestId('dc-pie-wedge')).toHaveLength(2)
    expect(screen.getByTestId('dc-pie-updated').textContent).toBe('Updated · 2 min ago')
  })

  it('an active reading breathes and carries its quantity motion; an idle one does not', () => {
    render(
      <SensorPieCard
        model={model([
          reading('m', { quantity: 'motion', value: 'Active', unit: null, state: 'active' }),
          reading('t'),
        ])}
      />,
    )
    const [motion, temp] = screen.getAllByTestId('dc-pie-wedge')
    expect(motion?.querySelector('.dc-pie-breathe')).not.toBeNull()
    expect(motion?.querySelector('[data-fx="rings"]')).not.toBeNull()
    expect(temp?.querySelector('.dc-pie-breathe')).toBeNull()
    expect(temp?.querySelector('.dc-pie-fx')).toBeNull()
  })

  it('a reading with no data is a dashed wedge showing a dash, never 0', () => {
    render(
      <SensorPieCard
        model={model([
          reading('a'),
          reading('l', { quantity: 'illuminance', value: '—', unit: 'lx', state: 'empty' }),
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

  it('past six readings the sixth wedge is "+N" and opens the list', () => {
    const onOverflow = vi.fn()
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => reading(id))
    render(
      <SensorPieCard model={model(five, [reading('f'), reading('g')])} onOverflow={onOverflow} />,
    )
    expect(screen.getAllByTestId('dc-pie-wedge')).toHaveLength(5)
    const more = screen.getByTestId('dc-pie-more')
    expect(more.textContent).toBe('+2')
    fireEvent.click(more)
    expect(onOverflow).toHaveBeenCalledOnce()
  })

  it('the selected wedge is highlighted in its own quantity colour and the others dim', () => {
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
    expect(b?.querySelector(':scope > path')?.getAttribute('class')).toContain('stroke-info')
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
