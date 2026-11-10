import { DeviceFeature } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeroModelCard } from '../HeroModelCard'
import { TEST_LABELS, buildModel } from './fixtures'

const host = (run = vi.fn()) => ({ lang: 'en' as const, labels: TEST_LABELS, busy: false, run })

const COVER = {
  cover: { state: 'open', position: 40, tiltPosition: null, lastChangedAt: 1_700_000_000_000 },
}
const FEATURES = [DeviceFeature.CoverStoppable, DeviceFeature.CoverPositionable]

describe('HeroModelCard scene-placed controls', () => {
  it('draws a cover as open / stop / close beside its animation, with the position slider and no cover row', () => {
    const run = vi.fn()
    const model = buildModel('cover', ['cover'], COVER, true, FEATURES)
    expect(model.rows.find((r) => r.id === 'cover')?.placement).toBe('scene')
    render(<HeroModelCard model={model} host={host(run)} />)
    const strip = screen.getByTestId('scene-controls')
    expect(strip.querySelector('[data-testid="scene-action-cover.open"]')).not.toBeNull()
    expect(strip.querySelector('[data-testid="scene-action-cover.stop"]')).not.toBeNull()
    expect(strip.querySelector('[role="slider"], input[type="range"]')).not.toBeNull()
    expect(screen.queryByTestId('hero-row-cover')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 'cover', method: 'close' }),
      expect.objectContaining({ id: 'cover.close' }),
    )
  })

  it('shows a cover to a session that may not act without any command', () => {
    const model = buildModel('cover', ['cover'], COVER, false, FEATURES)
    render(<HeroModelCard model={model} host={host()} />)
    expect(screen.queryByTestId('scene-controls')).toBeNull()
    expect(screen.queryByTestId('hero-row-cover')).toBeNull()
  })
})
