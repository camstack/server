// @vitest-environment jsdom
import { DeviceFeature } from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MediaPlayerHeroCard } from '../media-player-hero-card'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const cap = {
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
})
