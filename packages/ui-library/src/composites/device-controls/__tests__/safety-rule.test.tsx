// @vitest-environment jsdom
/**
 * Enforces the LOCKED safety-gesture rule (Spec §3):
 *
 *   - LockHeroCard    MUST use SlideToggle  → `data-testid="slide-thumb"` is present.
 *   - SwitchHeroCard  MUST use TapToggle    → no `slide-thumb`; tap button present.
 *   - LightHeroCard   MUST use TapToggle    → no `slide-thumb`; tap button present.
 *   - FanHeroCard     MUST use TapToggle    → no `slide-thumb`; tap button present.
 *
 * Strategy: mirrors the harnesses in lock-hero.test.tsx and
 * light-fan-hero.test.tsx / misc-heroes.test.tsx exactly.
 *
 * LockHeroCard uses a simple single-cap mock (same as lock-hero.test.tsx).
 * Switch / Light / Fan use the sentinel-proxy cap-dispatch harness (same as
 * light-fan-hero.test.tsx / misc-heroes.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// ── Sentinel-proxy harness (Switch / Light / Fan) ────────────────────────────

interface CapSlot {
  cap: unknown
  slice: unknown
  available: boolean
}

type CapName = 'switch' | 'brightness' | 'color' | 'fanControl'

let slots: Record<CapName, CapSlot>

const SENTINELS: Record<CapName, { __cap: CapName }> = {
  switch: { __cap: 'switch' },
  brightness: { __cap: 'brightness' },
  color: { __cap: 'color' },
  fanControl: { __cap: 'fanControl' },
}

function makeFakeProxy(): unknown {
  return {
    switch: SENTINELS.switch,
    brightness: SENTINELS.brightness,
    color: SENTINELS.color,
    fanControl: SENTINELS.fanControl,
    state: {
      switch: { __slice: 'switch' },
      brightness: { __slice: 'brightness' },
      color: { __slice: 'color' },
      fanControl: { __slice: 'fanControl' },
    },
  }
}

// ── Lock-specific mock state (single cap, no sentinel dispatch needed) ────────

let lockMockResult: { cap: unknown; slice: unknown; available: boolean }

// The mock must handle BOTH calling conventions:
//   lock-hero uses `useDeviceCapability({ cap, slice })` with a plain object arg
//   (cap accessor returns cap directly from the result).
//   switch/light/fan use the sentinel proxy pattern.
// We use a single vi.mock that serves both: if the accessor result has a __cap
// sentinel we dispatch via `slots`; otherwise we fall back to `lockMockResult`.
vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: (opts: { cap: (d: unknown) => unknown }) => {
    const picked = opts.cap(makeFakeProxy())
    const tag = (picked as { __cap?: CapName } | undefined)?.__cap
    if (tag !== undefined && slots !== undefined && slots[tag] !== undefined) {
      const slot = slots[tag]
      return { dev: {}, cap: slot.cap, slice: slot.slice, available: slot.available }
    }
    // Lock hero path: lockMockResult holds { cap, slice, available } directly.
    return lockMockResult
  },
}))

import { LockHeroCard } from '../lock-hero-card'
import { SwitchHeroCard } from '../switch-hero-card'
import { LightHeroCard } from '../light-hero-card'
import { FanHeroCard } from '../fan-hero-card'

const trpc = {} as never

// ── Lock fixtures ─────────────────────────────────────────────────────────────

const lockCap = { lock: vi.fn(), unlock: vi.fn(), open: vi.fn() }

// ── Switch / Light / Fan fixtures ─────────────────────────────────────────────

const switchCap = { setState: vi.fn() }
const brightnessCap = { setBrightness: vi.fn() }
const colorCap = { setColor: vi.fn() }
const fanCap = {
  setPercentage: vi.fn(),
  setPreset: vi.fn(),
  setDirection: vi.fn(),
  setOscillating: vi.fn(),
}

function switchSlots(): Record<CapName, CapSlot> {
  return {
    switch: { cap: switchCap, slice: { on: true, lastChangedAt: 0 }, available: true },
    brightness: { cap: undefined, slice: undefined, available: false },
    color: { cap: undefined, slice: undefined, available: false },
    fanControl: { cap: undefined, slice: undefined, available: false },
  }
}

function lightSlots(): Record<CapName, CapSlot> {
  return {
    switch: { cap: switchCap, slice: { on: true, lastChangedAt: 0 }, available: true },
    brightness: {
      cap: brightnessCap,
      slice: { percentage: 80, lastChangedAt: 0 },
      available: true,
    },
    color: {
      cap: colorCap,
      slice: { mode: 'mired', mireds: 325, lastChangedAt: 0 },
      available: true,
    },
    fanControl: { cap: undefined, slice: undefined, available: false },
  }
}

function fanSlots(): Record<CapName, CapSlot> {
  return {
    switch: { cap: switchCap, slice: { on: true, lastChangedAt: 0 }, available: true },
    brightness: { cap: undefined, slice: undefined, available: false },
    color: { cap: undefined, slice: undefined, available: false },
    fanControl: {
      cap: fanCap,
      slice: {
        percentage: 60,
        preset: '',
        availablePresets: [],
        direction: null,
        oscillating: false,
        lastChangedAt: 0,
      },
      available: true,
    },
  }
}

beforeEach(() => {
  lockCap.lock.mockReset()
  lockCap.unlock.mockReset()
  lockCap.open.mockReset()
  Object.values(switchCap).forEach((fn) => fn.mockReset())
  Object.values(brightnessCap).forEach((fn) => fn.mockReset())
  Object.values(colorCap).forEach((fn) => fn.mockReset())
  Object.values(fanCap).forEach((fn) => fn.mockReset())

  // Default: lock cap present and locked
  lockMockResult = {
    cap: lockCap,
    slice: { state: 'locked' as const, lastChangedAt: 0 },
    available: true,
  }
})

// ── LockHeroCard: MUST use SlideToggle ───────────────────────────────────────

describe('LockHeroCard — safety-gesture rule', () => {
  it('renders a SlideToggle (slide-thumb) — never a plain tap toggle', () => {
    // Lock cap is set in lockMockResult; sentinel dispatch is not triggered.
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByTestId('slide-thumb')).toBeTruthy()
  })

  it('does NOT render a plain tap toggle button for the lock action', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    // The TapToggle button has title="Turn on" / "Turn off"; must be absent.
    expect(screen.queryByRole('button', { name: /turn/i })).toBeNull()
  })
})

// ── SwitchHeroCard: MUST NOT use SlideToggle ─────────────────────────────────

describe('SwitchHeroCard — safety-gesture rule', () => {
  it('does NOT render a SlideToggle (slide-thumb) — on/off is plain tap', () => {
    slots = switchSlots()
    render(<SwitchHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByTestId('slide-thumb')).toBeNull()
  })

  it('renders a tap toggle button for on/off', () => {
    slots = switchSlots()
    render(<SwitchHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })
})

// ── LightHeroCard: MUST NOT use SlideToggle ──────────────────────────────────

describe('LightHeroCard — safety-gesture rule', () => {
  it('does NOT render a SlideToggle (slide-thumb) — on/off is plain tap', () => {
    slots = lightSlots()
    render(<LightHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByTestId('slide-thumb')).toBeNull()
  })

  it('renders a tap toggle button for on/off', () => {
    slots = lightSlots()
    render(<LightHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })
})

// ── FanHeroCard: MUST NOT use SlideToggle ────────────────────────────────────

describe('FanHeroCard — safety-gesture rule', () => {
  it('does NOT render a SlideToggle (slide-thumb) — on/off is plain tap', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByTestId('slide-thumb')).toBeNull()
  })

  it('renders a tap toggle button for on/off', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })
})
