// @vitest-environment jsdom
/**
 * Tests for panel-backed InlineControl + HeroCard wrappers.
 *
 * Strategy: mock `useDeviceCapability` so we control the cap/slice returned.
 * Each wrapper guards on `cap !== undefined` — when cap is undefined it returns
 * null; when cap is present it renders the underlying panel.
 *
 * We verify:
 *  1. Component mounts without throwing when cap+slice are present.
 *  2. Returns null when cap is undefined (device has no such cap).
 *  3. Active-state token is applied for Switch (on→bg-success/30) and Lock
 *     (locked→text-success) so we exercise the real token path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// The mock is shared across all calls in a test — tests set mockResult before render.
let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

import {
  SwitchInlineControl,
  SwitchHeroCard,
  LockInlineControl,
  LockHeroCard,
  LightInlineControl,
  LightHeroCard,
  FanInlineControl,
  FanHeroCard,
  ThermostatInlineControl,
  ThermostatHeroCard,
  MediaPlayerInlineControl,
  MediaPlayerHeroCard,
  ControlInlineControl,
  ControlHeroCard,
} from '../panel-controls'

const trpc = {} as never

// ── Switch / Siren ─────────────────────────────────────────────────────────────

describe('SwitchInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setState: vi.fn() },
      slice: { on: false, lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <SwitchInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <SwitchInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a toggle button with bg-success/30 class when switch is on', () => {
    mockResult = {
      cap: { setState: vi.fn() },
      slice: { on: true, lastChangedAt: 0 },
      available: true,
    }
    render(<SwitchInlineControl trpc={trpc} deviceId={1} features={undefined} />)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('bg-success')
  })
})

describe('SwitchHeroCard', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setState: vi.fn() },
      slice: { on: false, lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(<SwitchHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<SwitchHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})

// ── Lock ───────────────────────────────────────────────────────────────────────

describe('LockInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: { lock: vi.fn(), unlock: vi.fn() },
      slice: { state: 'locked', lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <LockInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <LockInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('applies text-success class when locked', () => {
    render(<LockInlineControl trpc={trpc} deviceId={1} features={undefined} />)
    const btn = screen.getByLabelText('Unlock')
    expect(btn.className).toContain('text-success')
  })

  it('applies text-warning class when unlocked', () => {
    mockResult = {
      cap: { lock: vi.fn(), unlock: vi.fn() },
      slice: { state: 'unlocked', lastChangedAt: 0 },
      available: true,
    }
    render(<LockInlineControl trpc={trpc} deviceId={1} features={undefined} />)
    const btn = screen.getByLabelText('Lock')
    expect(btn.className).toContain('text-warning')
  })
})

describe('LockHeroCard', () => {
  beforeEach(() => {
    mockResult = {
      cap: { lock: vi.fn(), unlock: vi.fn() },
      slice: { state: 'locked', lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})

// ── Light ──────────────────────────────────────────────────────────────────────

describe('LightInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setState: vi.fn() },
      slice: { on: false, lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <LightInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when switch cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <LightInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('LightHeroCard', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setState: vi.fn() },
      slice: { on: false, lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(<LightHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when switch cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<LightHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})

// ── Fan ────────────────────────────────────────────────────────────────────────

describe('FanInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setPercentage: vi.fn(), setPreset: vi.fn() },
      slice: { percentage: 50, preset: '', availablePresets: [], lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <FanInlineControl trpc={trpc} deviceId={1} features={['fan-speed']} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when fan cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<FanInlineControl trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('FanHeroCard', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setPercentage: vi.fn(), setPreset: vi.fn() },
      slice: { percentage: 50, preset: '', availablePresets: [], lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(<FanHeroCard trpc={trpc} deviceId={1} features={['fan-speed']} />)
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when fan cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<FanHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})

// ── Thermostat ─────────────────────────────────────────────────────────────────

describe('ThermostatInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: {
        setTarget: vi.fn(),
        setMode: vi.fn(),
        setFanMode: vi.fn(),
        setPreset: vi.fn(),
        setTargetRange: vi.fn(),
        setTargetHumidity: vi.fn(),
      },
      slice: {
        mode: 'heat' as const,
        availableModes: ['heat', 'cool'],
        availableFanModes: [],
        availablePresets: [],
        currentTemp: 21,
        target: 22,
        targetLow: null,
        targetHigh: null,
        fanMode: '',
        preset: '',
        targetHumidity: null,
        lastChangedAt: 0,
      },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <ThermostatInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when climate cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <ThermostatInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('ThermostatHeroCard', () => {
  beforeEach(() => {
    mockResult = {
      cap: {
        setTarget: vi.fn(),
        setMode: vi.fn(),
        setFanMode: vi.fn(),
        setPreset: vi.fn(),
        setTargetRange: vi.fn(),
        setTargetHumidity: vi.fn(),
      },
      slice: {
        mode: 'cool' as const,
        availableModes: ['heat', 'cool'],
        availableFanModes: [],
        availablePresets: [],
        currentTemp: 21,
        target: 22,
        targetLow: null,
        targetHigh: null,
        fanMode: '',
        preset: '',
        targetHumidity: null,
        lastChangedAt: 0,
      },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when climate cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

// ── MediaPlayer ────────────────────────────────────────────────────────────────

describe('MediaPlayerInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: {
        play: vi.fn(),
        pause: vi.fn(),
        next: vi.fn(),
        previous: vi.fn(),
        setVolume: vi.fn(),
        setMute: vi.fn(),
        selectSource: vi.fn(),
        setShuffle: vi.fn(),
        setRepeat: vi.fn(),
      },
      slice: {
        state: 'playing' as const,
        volumeLevel: 50,
        isMuted: false,
        source: '',
        availableSources: [],
        shuffle: false,
        repeat: 'off' as const,
        lastChangedAt: 0,
      },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <MediaPlayerInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when media player cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <MediaPlayerInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('MediaPlayerHeroCard', () => {
  beforeEach(() => {
    mockResult = {
      cap: {
        play: vi.fn(),
        pause: vi.fn(),
        next: vi.fn(),
        previous: vi.fn(),
        setVolume: vi.fn(),
        setMute: vi.fn(),
        selectSource: vi.fn(),
        setShuffle: vi.fn(),
        setRepeat: vi.fn(),
      },
      slice: {
        state: 'paused' as const,
        volumeLevel: null,
        isMuted: null,
        source: '',
        availableSources: [],
        shuffle: null,
        repeat: null,
        lastChangedAt: 0,
      },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <MediaPlayerHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when media player cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <MediaPlayerHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

// ── Control ────────────────────────────────────────────────────────────────────

describe('ControlInlineControl', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setValue: vi.fn() },
      slice: { kind: 'numeric' as const, value: 5, options: [], lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(
      <ControlInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when control cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <ControlInlineControl trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('ControlHeroCard', () => {
  beforeEach(() => {
    mockResult = {
      cap: { setValue: vi.fn() },
      slice: { kind: 'select' as const, value: 'a', options: ['a', 'b'], lastChangedAt: 0 },
      available: true,
    }
  })

  it('mounts without error when cap present', () => {
    const { container } = render(<ControlHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).not.toBeNull()
  })

  it('returns null when control cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<ControlHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})
