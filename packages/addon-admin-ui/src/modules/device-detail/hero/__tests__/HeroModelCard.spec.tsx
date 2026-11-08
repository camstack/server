import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeroModelCard } from '../HeroModelCard'
import { buildModel, MEDIA_FEATURES, MEDIA_SLICE, PLUG_SLICES, WASHER_SLICES } from './fixtures'

const host = (run = vi.fn()) => ({ lang: 'en' as const, busy: false, run })

describe('HeroModelCard', () => {
  it('draws the washer scene with the model name and state, and no controls it lacks', () => {
    const model = buildModel('washer', ['running-state', 'power-meter'], WASHER_SLICES)
    const { container } = render(<HeroModelCard model={model} host={host()} />)
    expect(container.querySelector('[data-scene="washer"]')).not.toBeNull()
    expect(screen.getByText('Device')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('runs the cap call the model names when the own-power toggle is flipped', () => {
    const run = vi.fn()
    const model = buildModel('switch', ['switch', 'power-meter'], PLUG_SLICES)
    render(<HeroModelCard model={model} host={host(run)} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(run).toHaveBeenCalledWith(model.ownPower?.turnOff.call, model.ownPower?.turnOff)
  })

  it('hides every actuating part for a session that may not act', () => {
    const model = buildModel('switch', ['switch', 'power-meter'], PLUG_SLICES, false)
    render(<HeroModelCard model={model} host={host()} />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByTestId('hero-own-power')).toBeNull()
  })

  it('draws the media player rows the model carries and runs the volume call on release', () => {
    const run = vi.fn()
    const model = buildModel(
      'media-player',
      ['media-player'],
      { 'media-player': MEDIA_SLICE },
      true,
      MEDIA_FEATURES,
    )
    render(<HeroModelCard model={model} host={host(run)} />)
    expect(screen.getByTestId('hero-row-volume')).toBeTruthy()
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '55' } })
    fireEvent.pointerUp(slider)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 'media-player', method: 'setVolume' }),
      null,
    )
  })

  it('draws the artwork the model carries in the scene centre', () => {
    const slice = {
      ...MEDIA_SLICE,
      currentMedia: {
        ...MEDIA_SLICE.currentMedia,
        imageUrl: 'https://example.com/cover.jpg',
      },
    }
    const model = buildModel('media-player', ['media-player'], {
      'media-player': slice,
    })
    expect(model.background.kind).toBe('artwork')
    const { container } = render(<HeroModelCard model={model} host={host()} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/cover.jpg',
    )
  })

  it('puts a slider value at its dotted path in the call (control.value)', () => {
    const run = vi.fn()
    const model = buildModel('control', ['control'], {
      control: {
        kind: 'numeric',
        value: 5,
        min: 0,
        max: 30,
        step: 1,
        options: [],
        lastChangedAt: 1,
      },
    })
    render(<HeroModelCard model={model} host={host(run)} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '22' } })
    fireEvent.pointerUp(slider)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        cap: 'control',
        method: 'setValue',
        args: { control: { kind: 'numeric', value: 22 } },
      }),
      null,
    )
  })
  it('draws a climate setpoint in the scene centre, steps it by the cap step and names mode and fan', () => {
    const run = vi.fn()
    const model = buildModel('climate', ['climate-control'], {
      'climate-control': {
        mode: 'cool',
        availableModes: ['off', 'auto', 'cool', 'heat'],
        fanMode: 'auto',
        availableFanModes: ['auto', 'low'],
        preset: '',
        availablePresets: [],
        target: 24,
        targetHigh: null,
        targetLow: null,
        targetHumidity: null,
        currentTemp: 26,
        currentHumidity: null,
        swingVertical: null,
        swingHorizontal: null,
        minTemp: 16,
        maxTemp: 30,
        tempStep: 1,
        lastFetchedAt: 1,
      },
    })
    render(<HeroModelCard model={model} host={host(run)} />)
    expect(screen.getByTestId('setpoint-centre').textContent).toContain('24')
    expect(screen.queryByTestId('hero-row-setpoint')).toBeNull()
    expect(screen.getByTestId('scene-caption').textContent).toContain('fan Auto')
    expect(screen.queryByText('off')).toBeNull()
    fireEvent.click(screen.getByLabelText('Target +'))
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        cap: 'climate-control',
        method: 'setTarget',
        args: { target: 25 },
      }),
      null,
    )
  })
})
