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

  it('a tap on a wedge reports its reading', () => {
    const onSelect = vi.fn()
    render(<SensorPieCard model={model([reading('a'), reading('b')])} onSelect={onSelect} />)
    fireEvent.click(screen.getAllByTestId('dc-pie-wedge')[1] as Element)
    expect(onSelect).toHaveBeenCalledWith('b')
  })
})
