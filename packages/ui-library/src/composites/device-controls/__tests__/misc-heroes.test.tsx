// @vitest-environment jsdom
/**
 * Tests for the remaining per-type hero surfaces (Task 2.5):
 *  - SwitchHeroCard      — a large TAP toggle (NO slide; slide is lock-only).
 *  - MediaPlayerHeroCard — lucide transport (SkipBack/PlayPause/SkipForward)
 *                          + seek and volume rendered as GripTrack grip-thumbs.
 *  - AlarmHeroCard       — segmented Disarm / Home / Away controls calling the
 *                          right arm/disarm methods.
 *  - SensorHeroCard      — readout heroes (numeric value+unit, battery bar,
 *                          colored binary/presence state) — covered in
 *                          sensor-hero-card.test.tsx; smoke-asserted here for
 *                          the per-type surface contract.
 *
 * Strategy mirrors light-fan-hero.test.tsx: the heroes read caps via
 * `useDeviceCapability`. We mock that hook so it dispatches on the caller's
 * `cap` accessor invoked against a sentinel-tagged fake DeviceProxy, returning
 * the matching mocked slot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeviceFeature } from '@camstack/types'

// ── Cap dispatch harness ────────────────────────────────────────────────────

interface CapSlot {
  cap: unknown
  slice: unknown
  available: boolean
}

type CapName = 'switch' | 'mediaPlayer' | 'alarmPanel'

let slots: Record<CapName, CapSlot>

const SENTINELS: Record<CapName, { __cap: CapName }> = {
  switch: { __cap: 'switch' },
  mediaPlayer: { __cap: 'mediaPlayer' },
  alarmPanel: { __cap: 'alarmPanel' },
}

function makeFakeProxy(): unknown {
  return {
    switch: SENTINELS.switch,
    mediaPlayer: SENTINELS.mediaPlayer,
    alarmPanel: SENTINELS.alarmPanel,
    state: {
      switch: { __slice: 'switch' },
      mediaPlayer: { __slice: 'mediaPlayer' },
      alarmPanel: { __slice: 'alarmPanel' },
    },
  }
}

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: (opts: { cap: (d: unknown) => unknown }) => {
    const picked = opts.cap(makeFakeProxy())
    const tag = (picked as { __cap?: CapName } | undefined)?.__cap
    if (tag !== undefined && slots[tag] !== undefined) {
      const slot = slots[tag]
      return { dev: {}, cap: slot.cap, slice: slot.slice, available: slot.available }
    }
    return { dev: {}, cap: undefined, slice: undefined, available: false }
  },
}))

import { SwitchHeroCard } from '../switch-hero-card'
import { MediaPlayerHeroCard } from '../media-player-hero-card'
import { AlarmHeroCard, AlarmInlineControl } from '../alarm-hero-card'

const trpc = {} as never

// ── Switch fixtures ─────────────────────────────────────────────────────────

const switchCap = { setState: vi.fn() }

function switchSlots(over?: Partial<Record<CapName, CapSlot>>): Record<CapName, CapSlot> {
  return {
    switch: { cap: switchCap, slice: { on: false, lastChangedAt: 0 }, available: true },
    mediaPlayer: { cap: undefined, slice: undefined, available: false },
    alarmPanel: { cap: undefined, slice: undefined, available: false },
    ...over,
  }
}

// ── Media fixtures ──────────────────────────────────────────────────────────

const mediaCap = {
  play: vi.fn(),
  pause: vi.fn(),
  stop: vi.fn(),
  next: vi.fn(),
  previous: vi.fn(),
  seek: vi.fn(),
  setVolume: vi.fn(),
  setMute: vi.fn(),
}

function mediaSlice(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    state: 'playing',
    volumeLevel: 40,
    isMuted: false,
    source: '',
    availableSources: [],
    currentMedia: { type: 'music', title: 'Test Track', artist: 'Tester' },
    positionMs: 30_000,
    durationMs: 120_000,
    shuffle: null,
    repeat: null,
    lastChangedAt: 0,
    ...over,
  }
}

function mediaSlots(over?: Partial<Record<CapName, CapSlot>>): Record<CapName, CapSlot> {
  return {
    switch: { cap: undefined, slice: undefined, available: false },
    mediaPlayer: { cap: mediaCap, slice: mediaSlice(), available: true },
    alarmPanel: { cap: undefined, slice: undefined, available: false },
    ...over,
  }
}

const ALL_MEDIA_FEATURES = [
  DeviceFeature.MediaPlayerSeek,
  DeviceFeature.MediaPlayerVolume,
  DeviceFeature.MediaPlayerNext,
  DeviceFeature.MediaPlayerPrevious,
]

// ── Alarm fixtures ──────────────────────────────────────────────────────────

// arm/disarm are typed Promise<void> on the real cap — AlarmHeroCard now
// chains .catch() on the returned promise (D630), so the mock must resolve.
const alarmCap = { arm: vi.fn(), disarm: vi.fn(), trigger: vi.fn() }

function alarmSlice(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    state: 'disarmed',
    availableModes: ['home', 'away'],
    requiresCode: false,
    lastChangedAt: 0,
    ...over,
  }
}

function alarmSlots(over?: Partial<Record<CapName, CapSlot>>): Record<CapName, CapSlot> {
  return {
    switch: { cap: undefined, slice: undefined, available: false },
    mediaPlayer: { cap: undefined, slice: undefined, available: false },
    alarmPanel: { cap: alarmCap, slice: alarmSlice(), available: true },
    ...over,
  }
}

beforeEach(() => {
  Object.values(switchCap).forEach((fn) => fn.mockReset())
  Object.values(mediaCap).forEach((fn) => fn.mockReset())
  Object.values(alarmCap).forEach((fn) => fn.mockReset())
  alarmCap.arm.mockResolvedValue(undefined)
  alarmCap.disarm.mockResolvedValue(undefined)
})

// ── SwitchHeroCard ──────────────────────────────────────────────────────────

describe('SwitchHeroCard', () => {
  it('returns null when the switch cap is absent (cap-gate)', () => {
    slots = switchSlots({ switch: { cap: undefined, slice: undefined, available: false } })
    const { container } = render(<SwitchHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('uses a TAP TOGGLE for on/off — no slide-thumb present', () => {
    slots = switchSlots()
    render(<SwitchHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByTestId('slide-thumb')).toBeNull()
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })

  it('calls setState with the toggled value on tap', () => {
    slots = switchSlots()
    render(<SwitchHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /turn/i }))
    expect(switchCap.setState).toHaveBeenCalledWith({ on: true })
  })
})

// ── MediaPlayerHeroCard ─────────────────────────────────────────────────────

describe('MediaPlayerHeroCard', () => {
  it('returns null when the media-player cap is absent (cap-gate)', () => {
    slots = mediaSlots({ mediaPlayer: { cap: undefined, slice: undefined, available: false } })
    const { container } = render(
      <MediaPlayerHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the three transport controls (skip-back / play-pause / skip-forward)', () => {
    slots = mediaSlots()
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    expect(screen.getByRole('button', { name: /previous/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /pause|play/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /next/i })).toBeTruthy()
  })

  it('renders seek and volume GripTracks', () => {
    slots = mediaSlots()
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    expect(screen.getByTestId('media-seek')).toBeTruthy()
    expect(screen.getByTestId('media-volume')).toBeTruthy()
  })

  it('calls pause when playing and the play/pause button is clicked', () => {
    slots = mediaSlots()
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    fireEvent.click(screen.getByRole('button', { name: /pause/i }))
    expect(mediaCap.pause).toHaveBeenCalledWith({})
  })

  it('calls next / previous transport methods', () => {
    slots = mediaSlots()
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /previous/i }))
    expect(mediaCap.next).toHaveBeenCalledWith({})
    expect(mediaCap.previous).toHaveBeenCalledWith({})
  })

  it('does not render the volume GripTrack when there is no volume surface', () => {
    slots = mediaSlots({
      mediaPlayer: { cap: mediaCap, slice: mediaSlice({ volumeLevel: null }), available: true },
    })
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    expect(screen.queryByTestId('media-volume')).toBeNull()
  })

  it('does not render the seek track when MediaPlayerSeek feature is absent', () => {
    slots = mediaSlots()
    const featuresNoSeek = ALL_MEDIA_FEATURES.filter((f) => f !== DeviceFeature.MediaPlayerSeek)
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={featuresNoSeek} />)
    expect(screen.queryByTestId('media-seek')).toBeNull()
  })

  it('does not render the seek track when durationMs is null (feature present)', () => {
    slots = mediaSlots({
      mediaPlayer: { cap: mediaCap, slice: mediaSlice({ durationMs: null }), available: true },
    })
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    expect(screen.queryByTestId('media-seek')).toBeNull()
  })

  it('does not render the seek track when durationMs is zero (degenerate)', () => {
    slots = mediaSlots({
      mediaPlayer: { cap: mediaCap, slice: mediaSlice({ durationMs: 0 }), available: true },
    })
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    expect(screen.queryByTestId('media-seek')).toBeNull()
  })

  it('shows now-playing title', () => {
    slots = mediaSlots()
    render(<MediaPlayerHeroCard trpc={trpc} deviceId={1} features={ALL_MEDIA_FEATURES} />)
    expect(screen.getByText('Test Track')).toBeTruthy()
  })
})

// ── AlarmHeroCard ───────────────────────────────────────────────────────────

describe('AlarmHeroCard', () => {
  it('returns null when the alarm-panel cap is absent (cap-gate)', () => {
    slots = alarmSlots({ alarmPanel: { cap: undefined, slice: undefined, available: false } })
    const { container } = render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders segmented Disarm / Home / Away controls per availableModes', () => {
    slots = alarmSlots()
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByRole('button', { name: /disarm/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^home$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^away$/i })).toBeTruthy()
  })

  it('does not render a mode button absent from availableModes', () => {
    slots = alarmSlots({
      alarmPanel: {
        cap: alarmCap,
        slice: alarmSlice({ availableModes: ['home'] }),
        available: true,
      },
    })
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByRole('button', { name: /^home$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^away$/i })).toBeNull()
  })

  it('calls arm({ mode: "home" }) when Home is clicked', () => {
    slots = alarmSlots()
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /^home$/i }))
    expect(alarmCap.arm).toHaveBeenCalledWith({ mode: 'home' })
  })

  it('calls arm({ mode: "away" }) when Away is clicked', () => {
    slots = alarmSlots()
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /^away$/i }))
    expect(alarmCap.arm).toHaveBeenCalledWith({ mode: 'away' })
  })

  it('calls disarm({}) when Disarm is clicked', () => {
    slots = alarmSlots({
      alarmPanel: { cap: alarmCap, slice: alarmSlice({ state: 'armed_away' }), available: true },
    })
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /disarm/i }))
    expect(alarmCap.disarm).toHaveBeenCalledWith({})
  })

  it('reflects the current armed state via data-state', () => {
    slots = alarmSlots({
      alarmPanel: { cap: alarmCap, slice: alarmSlice({ state: 'triggered' }), available: true },
    })
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByTestId('alarm-state').getAttribute('data-state')).toBe('triggered')
  })

  it('highlights no segment while transitioning (arming) — Disarm not active', () => {
    slots = alarmSlots({
      alarmPanel: { cap: alarmCap, slice: alarmSlice({ state: 'arming' }), available: true },
    })
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const disarm = screen.getByRole('button', { name: /disarm/i })
    const home = screen.getByRole('button', { name: /^home$/i })
    const away = screen.getByRole('button', { name: /^away$/i })
    expect(disarm.getAttribute('aria-pressed')).toBe('false')
    expect(home.getAttribute('aria-pressed')).toBe('false')
    expect(away.getAttribute('aria-pressed')).toBe('false')
  })
})

// ── AlarmInlineControl (row-sized compact strip) ─────────────────────────────

describe('AlarmInlineControl', () => {
  it('returns null when the alarm-panel cap is absent (cap-gate)', () => {
    slots = alarmSlots({ alarmPanel: { cap: undefined, slice: undefined, available: false } })
    const { container } = render(
      <AlarmInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the STATE and offers the modes on ONE line — no button strip', () => {
    // A state badge plus four buttons does not fit a phone-width row, and no
    // sizing makes it: the first version overflowed the card and cut the
    // highlighted button off, the second wrapped to three lines. A row shows
    // what a row is for — the state — and a select is one line at any width.
    slots = alarmSlots()
    const { container } = render(
      <AlarmInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(screen.getByText(/disarmed/i)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: /alarm mode/i })).toBeTruthy()
    // The four-segment strip belongs to the hero, not here.
    expect(screen.queryByRole('button', { name: /^away$/i })).toBeNull()
    expect(container.querySelector('.p-6')).toBeNull()
  })

  it('calls arm({ mode: "home" }) / disarm({}) from the select', () => {
    slots = alarmSlots({
      alarmPanel: { cap: alarmCap, slice: alarmSlice({ state: 'armed_away' }), available: true },
    })
    render(<AlarmInlineControl trpc={trpc} deviceId={1} features={undefined} />)
    const select = screen.getByRole('combobox', { name: /alarm mode/i })
    fireEvent.change(select, { target: { value: 'home' } })
    expect(alarmCap.arm).toHaveBeenCalledWith({ mode: 'home' })
    // The empty value is Disarm — it must not read as "no selection".
    fireEvent.change(select, { target: { value: '' } })
    expect(alarmCap.disarm).toHaveBeenCalledWith({})
  })
})
