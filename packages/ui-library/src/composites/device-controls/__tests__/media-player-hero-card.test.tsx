// @vitest-environment jsdom
import { DeviceFeature } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MediaPlayerHeroCard } from '../media-player-hero-card'

let mockSlices: { runningState?: unknown; powerMeter?: unknown } = {}
let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceState: (_t: unknown, _d: unknown, pick: (s: Record<string, unknown>) => unknown) =>
    pick(mockSlices),
}))

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const cap = {
  turnOn: vi.fn(),
  turnOff: vi.fn(),
  volumeUp: vi.fn(),
  volumeDown: vi.fn(),
  stop: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  next: vi.fn(),
  previous: vi.fn(),
  seek: vi.fn(),
  setVolume: vi.fn(),
  setMute: vi.fn(),
}

const infrared = {
  state: 'standby' as const,
  stateSource: 'assumed' as const,
  assumedFields: ['state' as const],
  volumeLevel: null,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: null,
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  lastChangedAt: 0,
}

const FEATURES = [DeviceFeature.MediaPlayerVolume, DeviceFeature.MediaPlayerNext]

function renderHero(slice: unknown): void {
  mockResult = { cap, slice, available: true }
  render(<MediaPlayerHeroCard trpc={{} as never} deviceId={1} features={FEATURES} />)
}

describe('MediaPlayerHeroCard — only what is known', () => {
  it('draws no volume, source or now-playing for an infrared TV, and marks the state assumed', () => {
    renderHero(infrared)
    expect(screen.queryByTestId('media-volume')).toBeNull()
    expect(screen.queryByTestId('media-source')).toBeNull()
    expect(screen.queryByText('Nothing playing')).toBeNull()
    expect(screen.getByTestId('media-assumed')).toBeTruthy()
    expect(screen.getByTestId('media-state').textContent).toContain('Standby')
  })

  it('draws volume, source and now-playing when they are known, with no assumed mark', () => {
    renderHero({
      ...infrared,
      state: 'playing',
      stateSource: 'reported',
      assumedFields: [],
      volumeLevel: 40,
      isMuted: false,
      source: 'HDMI 1',
      currentMedia: { title: 'Song', artist: 'Band' },
    })
    expect(screen.getByTestId('media-volume')).toBeTruthy()
    expect(screen.getByTestId('media-source').textContent).toBe('HDMI 1')
    expect(screen.getByText('Song')).toBeTruthy()
    expect(screen.queryByTestId('media-assumed')).toBeNull()
  })

  it('renders nothing without the media-player binding', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <MediaPlayerHeroCard trpc={{} as never} deviceId={1} features={FEATURES} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('an unanswered status is drawn as unknown, not off, with no controls', () => {
    renderHero(undefined)
    expect(screen.getByTestId('media-hero').getAttribute('data-power')).toBe('unknown')
    expect(screen.getByTestId('media-state-unknown')).toBeTruthy()
    expect(screen.queryByText('Off')).toBeNull()
    expect(screen.queryByTestId('media-transport')).toBeNull()
  })

  it('draws power on with a halo and an equalizer while playing', () => {
    renderHero({ ...infrared, state: 'playing', stateSource: 'reported', assumedFields: [] })
    expect(screen.getByTestId('media-hero').getAttribute('data-power')).toBe('on')
    expect(screen.getByTestId('media-power-halo')).toBeTruthy()
    expect(screen.getByTestId('media-running').getAttribute('data-running')).toBe('playing')
  })

  it('off has no halo, running indicator or controls; the orb switches power when declared', () => {
    mockResult = { cap, slice: { ...infrared, state: 'off' }, available: true }
    render(
      <MediaPlayerHeroCard
        trpc={{} as never}
        deviceId={1}
        features={[DeviceFeature.MediaPlayerPower, DeviceFeature.MediaPlayerVolumeStep]}
      />,
    )
    expect(screen.queryByTestId('media-power-halo')).toBeNull()
    expect(screen.queryByTestId('media-running')).toBeNull()
    expect(screen.queryByTestId('media-volume-steps')).toBeNull()
    fireEvent.click(screen.getByTestId('media-power'))
    expect(cap.turnOn).toHaveBeenCalledTimes(1)
  })

  it('a powered device with a step feature and no level reading draws volume steps', () => {
    mockResult = { cap, slice: { ...infrared, state: 'on' }, available: true }
    render(
      <MediaPlayerHeroCard
        trpc={{} as never}
        deviceId={1}
        features={[DeviceFeature.MediaPlayerVolumeStep]}
      />,
    )
    fireEvent.click(screen.getByLabelText('Volume up'))
    expect(cap.volumeUp).toHaveBeenCalledWith({ steps: 1 })
  })

  it('shows the running state unknown and no watts when neither cap is bound', () => {
    mockSlices = {}
    renderHero({ ...infrared })
    expect(screen.getByTestId('media-running-state').getAttribute('data-reading')).toBe('unknown')
    expect(screen.queryByTestId('media-watts')).toBeNull()
  })

  it('reads running-state and power-meter watts when bound', () => {
    mockSlices = { runningState: { running: true }, powerMeter: { power: 84.4 } }
    renderHero({ ...infrared })
    expect(screen.getByTestId('media-running-state').getAttribute('data-reading')).toBe('running')
    expect(screen.getByTestId('media-watts').textContent).toContain('84 W')
    expect(screen.getByTestId('media-hero').getAttribute('data-power')).toBe('on')
    mockSlices = {}
  })

  it('a bound meter with no reading shows a dash, not zero', () => {
    mockSlices = { powerMeter: {} }
    renderHero({ ...infrared })
    expect(screen.getByTestId('media-watts').textContent).toContain('—')
    mockSlices = {}
  })

  it('a declared volume draws an unknown-level slider when the level is null, and it still sends', () => {
    mockResult = {
      cap,
      slice: { ...infrared, state: 'playing', stateSource: 'reported', assumedFields: [] },
      available: true,
    }
    render(
      <MediaPlayerHeroCard
        trpc={{} as never}
        deviceId={1}
        features={[DeviceFeature.MediaPlayerVolume, DeviceFeature.MediaPlayerMute]}
      />,
    )
    expect(screen.getByTestId('media-volume')).toBeTruthy()
    expect(screen.getByTestId('media-volume-track').getAttribute('data-known')).toBe('false')
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '30' } })
    expect(cap.setVolume).toHaveBeenCalledWith({ volumeLevel: 30 })
    fireEvent.click(screen.getByLabelText('Mute'))
    expect(cap.setMute).toHaveBeenCalledWith({ muted: true })
  })

  it('shows the artwork, title and artist of what is playing', () => {
    renderHero({
      ...infrared,
      state: 'playing',
      stateSource: 'reported',
      assumedFields: [],
      currentMedia: { title: 'Song', artist: 'Band', imageUrl: 'https://img.example/a.jpg' },
    })
    expect(screen.getByTestId('media-artwork-img').getAttribute('src')).toBe(
      'https://img.example/a.jpg',
    )
    expect(screen.getByText('Band')).toBeTruthy()
  })
})
