// @vitest-environment jsdom
/**
 * Tests for LightHeroCard + FanHeroCard — radial dimmer/dial heroes.
 *
 * LOCKED design rule (Spec §3): slide-to-confirm is ONLY for safety actions
 * (lock). Light and Fan on/off use a plain TAP TOGGLE, never a SlideToggle.
 * Continuous values (brightness, speed) use the radial ArcKnob.
 *
 * Strategy: each hero reads MULTIPLE caps (switch + brightness + color for
 * light; switch + fan-control for fan). We mock `useDeviceCapability` so it
 * dispatches on the `cap` accessor — invoking it against a fake DeviceProxy
 * whose cap handles are tagged, then returning the matching mocked result.
 *
 * Light asserts:
 *  (a) renders an ArcKnob at the brightness fraction
 *  (b) on/off is a TAP TOGGLE — `queryByTestId('slide-thumb')` is null
 *  (c) a color-temp GripTrack ONLY when DeviceFeature.LightColorMired present
 *  (d) returns null when the light (switch) cap is absent (cap-gate)
 *
 * Fan asserts:
 *  (a) renders a speed ArcKnob at the speed fraction
 *  (b) on/off is a TAP TOGGLE — `queryByTestId('slide-thumb')` is null
 *  (c) an oscillate control ONLY when DeviceFeature.FanOscillating present
 *  (d) returns null when the fan (switch) cap is absent (cap-gate)
 *  (e) the legacy horizontal "Fan speed" range slider is GONE — the gauge is
 *      the sole speed control (draggable, step-snapped)
 *  (f) a preset selector renders ONLY when DeviceFeature.FanPreset present and
 *      availablePresets is non-empty, and calls setPreset on change
 *  (g) dragging the gauge snaps to percentageStep and calls setPercentage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeviceFeature } from '@camstack/types'

// ── Cap dispatch harness ────────────────────────────────────────────────────
// Each cap slot holds { cap, slice, available }. The mocked hook resolves which
// slot a call wants by invoking the caller's `cap` accessor against a fake proxy
// whose cap handles are sentinel-tagged.

interface CapSlot {
  cap: unknown
  slice: unknown
  available: boolean
}

type CapName = 'switch' | 'brightness' | 'color' | 'fanControl'

let slots: Record<CapName, CapSlot>

// Sentinel cap handles on the fake proxy — the accessor picks one of these.
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

import { LightHeroCard } from '../light-hero-card'
import { FanHeroCard } from '../fan-hero-card'

const trpc = {} as never

// ── Light fixtures ──────────────────────────────────────────────────────────

const switchCap = { setState: vi.fn() }
const brightnessCap = { setBrightness: vi.fn() }
const colorCap = { setColor: vi.fn() }
const fanCap = {
  setPercentage: vi.fn(),
  setPreset: vi.fn(),
  setDirection: vi.fn(),
  setOscillating: vi.fn(),
}

function lightSlots(over?: Partial<Record<CapName, CapSlot>>): Record<CapName, CapSlot> {
  return {
    switch: { cap: switchCap, slice: { on: true, lastChangedAt: 0 }, available: true },
    brightness: {
      cap: brightnessCap,
      slice: { level: 80, lastChangedAt: 0 },
      available: true,
    },
    color: {
      cap: colorCap,
      slice: { mode: 'mired', colorTemperature: 325, lastChangedAt: 0 },
      available: true,
    },
    fanControl: { cap: undefined, slice: undefined, available: false },
    ...over,
  }
}

function fanSlots(over?: Partial<Record<CapName, CapSlot>>): Record<CapName, CapSlot> {
  return {
    switch: { cap: switchCap, slice: { on: true, lastChangedAt: 0 }, available: true },
    brightness: { cap: undefined, slice: undefined, available: false },
    color: { cap: undefined, slice: undefined, available: false },
    fanControl: {
      cap: fanCap,
      slice: {
        speed: 60,
        preset: '',
        availablePresets: [],
        direction: null,
        oscillating: false,
        lastChangedAt: 0,
      },
      available: true,
    },
    ...over,
  }
}

beforeEach(() => {
  Object.values(switchCap).forEach((fn) => fn.mockReset())
  Object.values(brightnessCap).forEach((fn) => fn.mockReset())
  Object.values(colorCap).forEach((fn) => fn.mockReset())
  Object.values(fanCap).forEach((fn) => fn.mockReset())
})

// ── LightHeroCard ───────────────────────────────────────────────────────────

describe('LightHeroCard', () => {
  it('returns null when the light (switch) cap is absent (cap-gate)', () => {
    slots = lightSlots({ switch: { cap: undefined, slice: undefined, available: false } })
    const { container } = render(<LightHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an ArcKnob at the brightness fraction (80% → fraction 0.8)', () => {
    slots = lightSlots()
    render(<LightHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.LightColorMired]} />)
    const knob = document.querySelector('[data-testid="arc-knob"]')
    expect(knob).not.toBeNull()
    // ArcKnob root: transform rotate(deg) where deg = -135 + fraction * 270.
    const arcRoot = knob?.querySelector<HTMLElement>('.absolute.inset-0[style]')
    const transform = arcRoot?.style.transform ?? ''
    const match = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(transform)
    expect(match).not.toBeNull()
    const deg = parseFloat(match?.[1] ?? '0')
    const expected = -135 + 0.8 * 270 // = 81
    expect(deg).toBeGreaterThan(expected - 1)
    expect(deg).toBeLessThan(expected + 1)
  })

  it('uses a TAP TOGGLE for on/off — no slide-thumb present', () => {
    slots = lightSlots()
    render(<LightHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByTestId('slide-thumb')).toBeNull()
    // A tap toggle exposes an aria-pressed control.
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })

  it('renders a color-temp GripTrack when LightColorMired is supported', () => {
    slots = lightSlots()
    render(<LightHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.LightColorMired]} />)
    expect(screen.getByTestId('color-temp-strip')).toBeTruthy()
  })

  it('does NOT render a color-temp GripTrack when LightColorMired is unsupported', () => {
    slots = lightSlots({ color: { cap: undefined, slice: undefined, available: false } })
    render(<LightHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByTestId('color-temp-strip')).toBeNull()
  })

  it('does NOT render the brightness slider when the brightness cap is absent (switch only)', () => {
    slots = lightSlots({ brightness: { cap: undefined, slice: undefined, available: false } })
    render(<LightHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    // The interactive slider must be gone, but the switch tap toggle stays.
    expect(screen.queryByLabelText('Brightness')).toBeNull()
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })

  it('maps colour-temp GripTrack fraction cool(150)→0, warm(500)→1 — same direction as the native thumb', () => {
    // 425 mireds (warm half) → fraction (425-150)/(500-150) = 0.7857 → ~78.57%.
    // Cool (150) would be 0% (left); warm (500) would be 100% (right) — matching
    // the native range thumb which runs cold(left)→warm(right).
    slots = lightSlots({
      color: {
        cap: colorCap,
        slice: { mode: 'mired', colorTemperature: 425, lastChangedAt: 0 },
        available: true,
      },
    })
    render(<LightHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.LightColorMired]} />)
    const strip = screen.getByTestId('color-temp-strip')
    // GripTrack's fill bar width encodes the fraction as a clean percentage.
    const fill = strip.querySelector<HTMLElement>('[style*="width"]')
    expect(fill).not.toBeNull()
    const pct = parseFloat(fill?.style.width ?? '')
    expect(pct).toBeGreaterThan(78)
    expect(pct).toBeLessThan(79)
  })
})

// ── FanHeroCard ─────────────────────────────────────────────────────────────

describe('FanHeroCard', () => {
  it('returns null when the fan (switch) cap is absent (cap-gate)', () => {
    slots = fanSlots({ switch: { cap: undefined, slice: undefined, available: false } })
    const { container } = render(<FanHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a speed ArcKnob at the speed fraction (60% → fraction 0.6)', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.FanSpeed]} />)
    const knob = document.querySelector('[data-testid="arc-knob"]')
    expect(knob).not.toBeNull()
    const arcRoot = knob?.querySelector<HTMLElement>('.absolute.inset-0[style]')
    const transform = arcRoot?.style.transform ?? ''
    const match = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(transform)
    expect(match).not.toBeNull()
    const deg = parseFloat(match?.[1] ?? '0')
    const expected = -135 + 0.6 * 270 // = 27
    expect(deg).toBeGreaterThan(expected - 1)
    expect(deg).toBeLessThan(expected + 1)
  })

  it('uses a TAP TOGGLE for on/off — no slide-thumb present', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByTestId('slide-thumb')).toBeNull()
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })

  it('renders an oscillate control when FanOscillating is supported', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.FanOscillating]} />)
    expect(screen.getByRole('button', { name: /oscillate/i })).toBeTruthy()
  })

  it('does NOT render an oscillate control when FanOscillating is unsupported', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByRole('button', { name: /oscillate/i })).toBeNull()
  })

  it('renders the speed % readout/gauge when FanSpeed is supported', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.FanSpeed]} />)
    expect(screen.getByTestId('speed-readout')).toBeTruthy()
    expect(screen.queryByTestId('fan-onoff-icon')).toBeNull()
  })

  it('renders an icon-only on/off treatment (no % readout) for a single-speed fan (FanSpeed absent)', () => {
    // Single-speed fan: percentage is null in the slice and FanSpeed is absent.
    slots = fanSlots({
      fanControl: {
        cap: fanCap,
        slice: {
          speed: null,
          preset: '',
          availablePresets: [],
          direction: null,
          oscillating: false,
          lastChangedAt: 0,
        },
        available: true,
      },
    })
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[]} />)
    // No misleading 0% gauge/readout; the tap toggle still controls on/off.
    expect(screen.queryByTestId('speed-readout')).toBeNull()
    expect(screen.getByTestId('fan-onoff-icon')).toBeTruthy()
    expect(screen.getByRole('button', { name: /turn/i })).toBeTruthy()
  })

  // ── (e) legacy horizontal speed slider removed ──────────────────────────────

  it('does NOT render the legacy horizontal "Fan speed" range slider — gauge is the sole speed control', () => {
    slots = fanSlots()
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.FanSpeed]} />)
    // The old <input type="range" aria-label="Fan speed"> must be gone.
    expect(screen.queryByLabelText('Fan speed')).toBeNull()
    // The draggable gauge ArcKnob remains.
    expect(document.querySelector('[data-testid="arc-knob"]')).not.toBeNull()
  })

  // ── (f) preset selector ─────────────────────────────────────────────────────

  it('renders a preset selector and calls setPreset on change when FanPreset is supported with presets', () => {
    slots = fanSlots({
      fanControl: {
        cap: fanCap,
        slice: {
          speed: 60,
          preset: 'auto',
          availablePresets: ['auto', 'turbo'],
          direction: null,
          oscillating: false,
          lastChangedAt: 0,
        },
        available: true,
      },
    })
    render(
      <FanHeroCard
        trpc={trpc}
        deviceId={1}
        features={[DeviceFeature.FanSpeed, DeviceFeature.FanPreset]}
      />,
    )
    const select = screen.getByLabelText('Fan preset')
    expect(select).toBeTruthy()
    fireEvent.change(select, { target: { value: 'turbo' } })
    expect(fanCap.setPreset).toHaveBeenCalledWith({ preset: 'turbo' })
  })

  it('does NOT render a preset selector when FanPreset is unsupported', () => {
    slots = fanSlots({
      fanControl: {
        cap: fanCap,
        slice: {
          speed: 60,
          preset: 'auto',
          availablePresets: ['auto', 'turbo'],
          direction: null,
          oscillating: false,
          lastChangedAt: 0,
        },
        available: true,
      },
    })
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.FanSpeed]} />)
    expect(screen.queryByLabelText('Fan preset')).toBeNull()
  })

  it('does NOT render a preset selector when availablePresets is empty even if FanPreset is supported', () => {
    slots = fanSlots() // availablePresets: []
    render(
      <FanHeroCard
        trpc={trpc}
        deviceId={1}
        features={[DeviceFeature.FanSpeed, DeviceFeature.FanPreset]}
      />,
    )
    expect(screen.queryByLabelText('Fan preset')).toBeNull()
  })

  // ── (g) draggable gauge snaps to percentageStep ─────────────────────────────

  it('dragging the speed gauge snaps to percentageStep and calls setPercentage', () => {
    slots = fanSlots({
      fanControl: {
        cap: fanCap,
        slice: {
          speed: 60,
          percentageStep: 25,
          preset: '',
          availablePresets: [],
          direction: null,
          oscillating: false,
          lastChangedAt: 0,
        },
        available: true,
      },
    })
    render(<FanHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.FanSpeed]} />)

    const knobRoot = document
      .querySelector('[data-testid="arc-knob"]')
      ?.querySelector<HTMLElement>('.absolute.inset-0')
    expect(knobRoot).not.toBeNull()
    if (knobRoot === null || knobRoot === undefined) return

    // RadialGauge is 150px centred at (75, 75); a straight-up pointer → fraction 0.5.
    knobRoot.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 150,
      height: 150,
      right: 150,
      bottom: 150,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const knob = knobRoot.firstElementChild
    expect(knob).not.toBeNull()
    if (knob === null) return

    fireEvent.pointerDown(knob, { pointerId: 1, clientX: 75, clientY: 75 })
    fireEvent.pointerMove(knob, { pointerId: 1, clientX: 75, clientY: 0 })

    // fraction 0.5 → round((0.5*100)/25)*25 = round(2)*25 = 50
    expect(fanCap.setPercentage).toHaveBeenCalledWith({ speed: 50 })
  })
})
