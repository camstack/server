import type { HeroModel } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeroModelCard } from '../HeroModelCard'
import { buildModel, WASHER_SLICES } from './fixtures'

const NOW = 1_700_000_000_000

const SLICES = {
  ...WASHER_SLICES,
  'power-source': { switchOn: true, offSeconds: 20, lastFetchedAt: NOW },
  consumables: {
    items: [
      {
        key: 'filter',
        label: 'Filter',
        level: 12,
        status: 'low',
        lastResetAt: null,
        resettable: false,
      },
      { key: 'salt', label: 'Salt', level: 80, status: 'ok', lastResetAt: null, resettable: false },
    ],
    lastChangedAt: NOW,
  },
}
const CAPS = ['running-state', 'power-meter', 'power-source', 'consumables']

const washer = (canActuate = true): HeroModel => buildModel('washer', CAPS, SLICES, canActuate)
const host = (run = vi.fn(), history = vi.fn()) => ({
  lang: 'en' as const,
  busy: false,
  run,
  openHistory: history,
})

describe('HeroModelCard utility section', () => {
  it('draws history, consumables and power source in one section and no Supply row', () => {
    render(<HeroModelCard model={washer()} host={host()} />)
    const grid = screen.getByTestId('hero-utility-grid')
    expect(within(grid).getByTestId('hero-utility-history')).toBeTruthy()
    expect(within(grid).getByTestId('hero-utility-consumables').textContent).toContain('1 low')
    expect(within(grid).getByTestId('hero-utility-power-supply').textContent).toContain('On')
    expect(screen.queryByTestId('hero-power-supply')).toBeNull()
    expect(screen.queryByText('Supply')).toBeNull()
    // history + consumables share a row; the odd one out (power) takes the full last row
    expect(grid.children[2]?.className).toContain('col-span-2')
  })

  it('opens the history from its button', () => {
    const openHistory = vi.fn()
    render(<HeroModelCard model={washer()} host={host(vi.fn(), openHistory)} />)
    fireEvent.click(screen.getByTestId('hero-utility-history'))
    expect(openHistory).toHaveBeenCalledOnce()
  })

  it('lists the consumables when its button is pressed', () => {
    render(<HeroModelCard model={washer()} host={host()} />)
    fireEvent.click(screen.getByTestId('hero-utility-consumables'))
    expect(screen.getByTestId('hero-consumables-panel').textContent).toContain('Filter')
  })

  it('runs the power-off action (with its confirmation) from the power menu, and restarts', () => {
    const run = vi.fn()
    const model = washer()
    render(<HeroModelCard model={model} host={host(run)} />)
    fireEvent.click(screen.getByTestId('hero-utility-power-supply'))
    fireEvent.click(screen.getByTestId('hero-utility-action-power-supply.off'))
    expect(run).toHaveBeenCalledWith(model.powerSupply?.powerOff.call, model.powerSupply?.powerOff)
    expect(model.powerSupply?.powerOff.confirm).toBeDefined()
    fireEvent.click(screen.getByTestId('hero-utility-power-supply'))
    fireEvent.click(screen.getByTestId('hero-utility-action-power-supply.restart'))
    expect(run).toHaveBeenLastCalledWith(
      model.powerSupply?.restart.call,
      model.powerSupply?.restart,
    )
  })

  it('shows the power source read-only for a session that may not act', () => {
    const run = vi.fn()
    render(<HeroModelCard model={washer(false)} host={host(run)} />)
    const button = screen.getByTestId('hero-utility-power-supply')
    expect(button.textContent).toContain('On')
    expect(button.getAttribute('data-readonly')).toBe('true')
    fireEvent.click(button)
    expect(screen.queryByTestId('hero-utility-action-power-supply.off')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('draws no section for a device with no utility', () => {
    const model = buildModel('washer', ['running-state', 'power-meter'], WASHER_SLICES)
    render(<HeroModelCard model={model} host={{ lang: 'en', busy: false, run: vi.fn() }} />)
    expect(screen.queryByTestId('hero-utility-grid')).toBeNull()
    expect(screen.queryByTestId('hero-card-utility')).toBeNull()
  })
})
