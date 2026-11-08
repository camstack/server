// @vitest-environment jsdom
import { DeviceFeature } from '@camstack/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MediaPlayerHeroCard } from '../media-player-hero-card'

let mockSlices: { runningState?: unknown } = {}
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
  it('draws no volume, source or now-playing for an infrared TV, and shows no assumed label', () => {
    renderHero(infrared)
    expect(screen.queryByTestId('media-volume')).toBeNull()
    expect(screen.queryByTestId('media-source')).toBeNull()
    expect(screen.queryByText('Nothing playing')).toBeNull()
    expect(screen.queryByTestId('media-assumed')).toBeNull()
    expect(screen.queryByText('assumed')).toBeNull()
    expect(screen.getByTestId('media-state').textContent).toContain('Standby')
  })

  it('draws volume, source and now-playing when they are known', () => {
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

  it('a bound running-state settles the power guess; the card draws no readings of its own', () => {
    mockSlices = { runningState: { running: true } }
    renderHero({ ...infrared })
    expect(screen.getByTestId('media-hero').getAttribute('data-power')).toBe('on')
    expect(screen.queryByTestId('media-running-state')).toBeNull()
    expect(screen.queryByTestId('media-watts')).toBeNull()
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

  it('a status with no state draws an unknown orb and never says Not running', () => {
    mockSlices = {}
    renderHero(JSON.parse('{"stateSource":"reported","assumedFields":[]}'))
    expect(screen.getByTestId('media-hero').getAttribute('data-power')).toBe('unknown')
    expect(screen.getByTestId('media-state-unknown')).toBeTruthy()
    expect(screen.queryByText('Not running')).toBeNull()
  })

  it('an absent running-state cap never reads as Not running, even with a known state', () => {
    mockSlices = {}
    renderHero({ ...infrared, state: 'off', stateSource: 'reported', assumedFields: [] })
    expect(screen.queryByText('Not running')).toBeNull()
  })

  it('a running-state cap that answered false reads as off, without a line of its own', () => {
    mockSlices = { runningState: { running: false } }
    renderHero({ ...infrared, state: 'off', stateSource: 'reported', assumedFields: [] })
    expect(screen.getByTestId('media-hero').getAttribute('data-power')).toBe('off')
    expect(screen.queryByText('Not running')).toBeNull()
    mockSlices = {}
  })
})

const PLAYING = {
  ...infrared,
  state: 'playing' as const,
  stateSource: 'reported' as const,
  assumedFields: [],
  volumeLevel: 40,
  isMuted: false,
}

function renderPlaying(extra: Record<string, unknown> = {}, features = FEATURES): void {
  mockSlices = {}
  mockResult = { cap, slice: { ...PLAYING, ...extra }, available: true }
  render(<MediaPlayerHeroCard trpc={{} as never} deviceId={1} features={features} />)
}

function volumeInput(): HTMLInputElement {
  return screen.getByLabelText('Volume') as HTMLInputElement
}

describe('MediaPlayerHeroCard — optimistic controls', () => {
  it('a refused volume change rolls the slider back to the reported level', async () => {
    cap.setVolume.mockReset()
    cap.setVolume.mockRejectedValueOnce(new Error('refused'))
    renderPlaying()
    await act(async () => {
      fireEvent.change(volumeInput(), { target: { value: '70' } })
    })
    expect(cap.setVolume).toHaveBeenCalledWith({ volumeLevel: 70 })
    expect(volumeInput().value).toBe('40')
  })

  it('an accepted volume change keeps the new value', async () => {
    cap.setVolume.mockReset()
    cap.setVolume.mockResolvedValueOnce(undefined)
    renderPlaying()
    await act(async () => {
      fireEvent.change(volumeInput(), { target: { value: '70' } })
    })
    expect(volumeInput().value).toBe('70')
  })
})

describe('MediaPlayerHeroCard — now playing', () => {
  const MEDIA = {
    title: 'Song',
    artist: 'Band',
    album: 'Record',
    imageUrl: 'https://img.example/a.jpg',
  }

  it('draws title, artist and album, artwork, source and progress', () => {
    renderPlaying({ currentMedia: MEDIA, source: 'Spotify', position: 65_000, duration: 200_000 })
    expect(screen.getByTestId('media-title').textContent).toBe('Song')
    expect(screen.getByTestId('media-subtitle').textContent).toBe('Band · Record')
    expect(screen.getByTestId('media-artwork-img').getAttribute('src')).toBe(MEDIA.imageUrl)
    expect(screen.getByTestId('media-source').textContent).toBe('Spotify')
    const progress = screen.getByTestId('media-progress')
    expect(progress.textContent).toContain('1:05')
    expect(progress.textContent).toContain('3:20')
    // Not seekable here: a progress indication, no slider.
    expect(screen.queryByTestId('media-seek')).toBeNull()
  })

  it('draws no progress while the position is unknown', () => {
    renderPlaying({ currentMedia: MEDIA, position: null, duration: 200_000 })
    expect(screen.queryByTestId('media-progress')).toBeNull()
  })

  it('shows what plays when the provider reports the device as off, without any controls', () => {
    renderPlaying({ state: 'standby', currentMedia: MEDIA, source: 'Spotify' })
    expect(screen.getByTestId('media-title').textContent).toBe('Song')
    expect(screen.queryByTestId('media-volume')).toBeNull()
  })

  it('advances a stamped position while playing and holds an unstamped one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    renderPlaying({
      currentMedia: MEDIA,
      position: 10_000,
      duration: 200_000,
      positionUpdatedAt: 100_000,
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByTestId('media-progress').textContent).toContain('0:15')
    vi.useRealTimers()
  })

  it('draws a shuffle / repeat value the device reports but cannot change as a flag, not a button', () => {
    renderPlaying({ currentMedia: MEDIA, shuffle: true, repeat: 'all' })
    expect(screen.getByTestId('media-shuffle-flag').getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('media-repeat-flag')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull()
  })

  it('draws the idle fixture with nothing playing', () => {
    renderPlaying({ state: 'idle', currentMedia: null, source: '' })
    expect(screen.queryByTestId('media-now-playing')).toBeNull()
  })
})
