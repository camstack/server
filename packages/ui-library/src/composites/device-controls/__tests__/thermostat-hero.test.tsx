// @vitest-environment jsdom
/**
 * Tests for ThermostatHeroCard — gauge hero (arc-knob setpoint, single + range).
 *
 * Strategy: mock `useDeviceCapability` so we control the cap/slice returned.
 * Asserts:
 *  (a) renders the current temperature prominently
 *  (b) renders an ArcKnob at the correct setpoint fraction for a single-setpoint status
 *  (c) renders a mode control/select
 *  (d) for a heat/cool range status, renders TWO knobs
 *  (e) returns null (renders nothing) when the climate cap is absent
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

import { ThermostatHeroCard } from '../thermostat-hero-card'

const trpc = {} as never

const baseCap = {
  setTarget: vi.fn(),
  setMode: vi.fn(),
  setFanMode: vi.fn(),
  setPreset: vi.fn(),
  setTargetRange: vi.fn(),
  setTargetHumidity: vi.fn(),
}

/** Single-setpoint heat status: current=21, setpoint=24, range ~5..35 → fraction ≈ 0.633 */
const singleSetpointSlice = {
  mode: 'heat' as const,
  availableModes: ['heat', 'cool', 'auto', 'off'] as const,
  availableFanModes: [] as string[],
  availablePresets: [] as string[],
  currentTemp: 21,
  target: 24,
  targetLow: null,
  targetHigh: null,
  targetHumidity: null,
  currentHumidity: null,
  fanMode: '',
  preset: '',
  lastFetchedAt: 0,
}

/** heat_cool dual-setpoint status: targetLow=18, targetHigh=26 */
const dualSetpointSlice = {
  mode: 'heat_cool' as const,
  availableModes: ['heat', 'cool', 'heat_cool', 'off'] as const,
  availableFanModes: [] as string[],
  availablePresets: [] as string[],
  currentTemp: 22,
  target: null,
  targetLow: 18,
  targetHigh: 26,
  targetHumidity: null,
  currentHumidity: null,
  fanMode: '',
  preset: '',
  lastFetchedAt: 0,
}

beforeEach(() => {
  Object.values(baseCap).forEach((fn) => fn.mockReset())
  mockResult = {
    cap: { ...baseCap },
    slice: { ...singleSetpointSlice },
    available: true,
  }
})

describe('ThermostatHeroCard', () => {
  // ── (e) cap-gate: returns null when climate cap is absent ──────────────────

  it('returns null when climate cap is undefined (no thermostat on device)', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(
      <ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  // ── (a) current temperature display ───────────────────────────────────────

  it('renders the current temperature prominently', () => {
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    // Current temp "21" should appear in a large text element
    expect(screen.getByTestId('current-temp')).toBeTruthy()
    expect(screen.getByTestId('current-temp').textContent).toContain('21')
  })

  it('renders without crashing when currentTemp is null', () => {
    mockResult = {
      cap: { ...baseCap },
      slice: { ...singleSetpointSlice, currentTemp: null },
      available: true,
    }
    const { container } = render(
      <ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  // ── (b) ArcKnob at the correct setpoint fraction (single setpoint) ─────────

  it('renders exactly ONE arc-knob for a single-setpoint status', () => {
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const knobs = document.querySelectorAll('[data-testid="arc-knob"]')
    expect(knobs.length).toBe(1)
  })

  it('knob rotation reflects the setpoint fraction (target=24, range 5..35 → fraction 0.633)', () => {
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const knobWrapper = document.querySelector('[data-testid="arc-knob"]') as HTMLElement
    expect(knobWrapper).not.toBeNull()

    // ArcKnob renders its own root div with style={{ transform: `rotate(${deg}deg)` }}
    // where deg = -135 + fraction * 270.
    // fraction = (24 - 5) / (35 - 5) = 19/30 ≈ 0.6333
    // correctDeg = -135 + 0.6333 * 270 ≈ -135 + 171 ≈ 36
    // buggyDeg (doubled wrapper) = 36 + 36 = 72 — well outside the ±5 tolerance below.
    const arcKnobRoot = knobWrapper.querySelector<HTMLElement>('.absolute.inset-0[style]')
    expect(arcKnobRoot).not.toBeNull()

    const transform = arcKnobRoot?.style.transform ?? ''
    expect(transform).toMatch(/rotate\(/)

    const match = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(transform)
    expect(match).not.toBeNull()
    const deg = parseFloat(match?.[1] ?? '0')

    // Correct angle: -135 + (19/30)*270 = 35.999… ≈ 36
    const expectedDeg = -135 + (19 / 30) * 270
    expect(deg).toBeGreaterThan(expectedDeg - 1)
    expect(deg).toBeLessThan(expectedDeg + 1)
    // Sanity: the doubled (buggy) angle ~72° must be outside this window
    // so the test would FAIL against the old wrapper-rotation code path.
  })

  // ── (c) mode control ──────────────────────────────────────────────────────

  it('renders a mode select with available modes as options', () => {
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const select = screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement
    expect(select).toBeTruthy()
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toContain('heat')
    expect(options).toContain('cool')
  })

  it('reflects the active mode as the selected value in the mode select', () => {
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const select = screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement
    expect(select.value).toBe('heat')
  })

  // ── (d) heat/cool range: TWO knobs ────────────────────────────────────────

  it('renders exactly TWO arc-knobs for a heat_cool dual-setpoint status', () => {
    mockResult = {
      cap: { ...baseCap },
      slice: { ...dualSetpointSlice },
      available: true,
    }
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const knobs = document.querySelectorAll('[data-testid="arc-knob"]')
    expect(knobs.length).toBe(2)
  })

  it('renders setpoint stepper for single-setpoint mode', () => {
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    // Should have a Stepper with Decrement + Increment buttons
    expect(screen.getByRole('button', { name: 'Decrement' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Increment' })).toBeTruthy()
  })

  it('does NOT render a single-setpoint Stepper in heat_cool RANGE mode', () => {
    mockResult = {
      cap: { ...baseCap },
      slice: { ...dualSetpointSlice },
      available: true,
    }
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByRole('button', { name: 'Decrement' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Increment' })).toBeNull()
  })

  // ── drag the single-setpoint knob → setTarget with the rounded temp ───────

  it('dragging the single-setpoint knob calls setTarget with the rounded temperature', () => {
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const knobRoot = document
      .querySelector('[data-testid="arc-knob"]')
      ?.querySelector<HTMLElement>('.absolute.inset-0')
    expect(knobRoot).not.toBeNull()
    if (knobRoot === null || knobRoot === undefined) return

    // Gauge is 176px centred at (88, 88); a straight-up pointer → fraction 0.5.
    knobRoot.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 176,
      height: 176,
      right: 176,
      bottom: 176,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const knob = knobRoot.firstElementChild as HTMLElement

    fireEvent.pointerDown(knob, { pointerId: 1, clientX: 88, clientY: 88 })
    fireEvent.pointerMove(knob, { pointerId: 1, clientX: 88, clientY: 0 })

    // fraction 0.5 over range [5, 35] → round(5 + 0.5*30) = 20
    expect(baseCap.setTarget).toHaveBeenCalledWith({ target: 20 })
  })

  // ── heat_cool RANGE drag clamping (low ≤ high, high ≥ low) ─────────────────

  /** Stub the gauge rect: 176px centred at (88, 88) at the screen origin. */
  function stubKnobRect(knobRoot: HTMLElement): void {
    knobRoot.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 176,
      height: 176,
      right: 176,
      bottom: 176,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }

  it('dragging the LOW knob above targetHigh clamps targetLow to ≤ targetHigh', () => {
    mockResult = {
      cap: { ...baseCap },
      slice: { ...dualSetpointSlice }, // targetLow=18, targetHigh=26
      available: true,
    }
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    // Two knob wrappers, low first then high.
    const wrappers = document.querySelectorAll('[data-testid="arc-knob"]')
    expect(wrappers.length).toBe(2)
    const lowRoot = wrappers[0]?.querySelector<HTMLElement>('.absolute.inset-0')
    expect(lowRoot).not.toBeNull()
    if (lowRoot === null || lowRoot === undefined) return
    stubKnobRect(lowRoot)
    const lowKnob = lowRoot.firstElementChild as HTMLElement

    // Drag the LOW knob to the SE arc end (fraction 1 → temp 35, well above 26).
    fireEvent.pointerDown(lowKnob, { pointerId: 1, clientX: 88, clientY: 88 })
    // angle 45° (fromStart 270° → fraction 1). point = centre + r·(cos45°, sin45°).
    const rad = (45 * Math.PI) / 180
    fireEvent.pointerMove(lowKnob, {
      pointerId: 1,
      clientX: 88 + 80 * Math.cos(rad),
      clientY: 88 + 80 * Math.sin(rad),
    })

    expect(baseCap.setTargetRange).toHaveBeenCalled()
    const arg = baseCap.setTargetRange.mock.calls.at(-1)?.[0] as {
      targetLow: number
      targetHigh: number
    }
    expect(arg.targetLow).toBeLessThanOrEqual(26)
    expect(arg.targetLow).toBe(26) // clamped to targetHigh
    expect(arg.targetHigh).toBe(26)
  })

  it('dragging the HIGH knob below targetLow clamps targetHigh to ≥ targetLow', () => {
    mockResult = {
      cap: { ...baseCap },
      slice: { ...dualSetpointSlice }, // targetLow=18, targetHigh=26
      available: true,
    }
    render(<ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const wrappers = document.querySelectorAll('[data-testid="arc-knob"]')
    expect(wrappers.length).toBe(2)
    const highRoot = wrappers[1]?.querySelector<HTMLElement>('.absolute.inset-0')
    expect(highRoot).not.toBeNull()
    if (highRoot === null || highRoot === undefined) return
    stubKnobRect(highRoot)
    const highKnob = highRoot.firstElementChild as HTMLElement

    // Drag the HIGH knob to the SW arc start (fraction 0 → temp 5, well below 18).
    fireEvent.pointerDown(highKnob, { pointerId: 1, clientX: 88, clientY: 88 })
    // angle 135° (fromStart 0° → fraction 0). point = centre + r·(cos135°, sin135°).
    const rad = (135 * Math.PI) / 180
    fireEvent.pointerMove(highKnob, {
      pointerId: 1,
      clientX: 88 + 80 * Math.cos(rad),
      clientY: 88 + 80 * Math.sin(rad),
    })

    expect(baseCap.setTargetRange).toHaveBeenCalled()
    const arg = baseCap.setTargetRange.mock.calls.at(-1)?.[0] as {
      targetLow: number
      targetHigh: number
    }
    expect(arg.targetHigh).toBeGreaterThanOrEqual(18)
    expect(arg.targetHigh).toBe(18) // clamped to targetLow
    expect(arg.targetLow).toBe(18)
  })

  it('mounts without error when cap and slice are both present', () => {
    const { container } = render(
      <ThermostatHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).not.toBeNull()
  })
})
