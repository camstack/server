// @vitest-environment jsdom
/**
 * Tests for SensorHeroCard — registry-path hero for Sensor / Presence devices.
 *
 * Strategy:
 *  - Mock `useDeviceManagerGetDevice` to return a device row with role + sourceInfo.
 *  - Mock `use-device-proxy` to return a controlled slice value.
 *  - Assert that value + unit / state labels render correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SensorHeroCard } from '../sensor-hero-card'
import { UnitPreferencesProvider } from '../../../contexts/unit-preferences'
import { formatControlDateTime } from '../../../lib/format-control-datetime'

// ── Slice state controlled by each test ─────────────────────────────────────

let mockSlice: unknown

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: vi.fn(() => null),
  useDeviceStateSlice: vi.fn(() => mockSlice),
}))

// ── Device row controlled by each test ──────────────────────────────────────

let mockDeviceData: unknown
let mockRoleDefaults: { defaults: Record<string, unknown> } | undefined
let mockSnapshot: { status: 'pending' | 'error' | 'success'; data?: unknown }

vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerGetDevice: vi.fn(() => ({ data: mockDeviceData })),
  useDeviceManagerGetRoleDisplayDefaults: vi.fn(() => ({ data: mockRoleDefaults })),
  useDeviceStateGetSnapshot: vi.fn(() => mockSnapshot),
}))

const trpc = {} as never

beforeEach(() => {
  mockSlice = undefined
  mockDeviceData = undefined
  mockRoleDefaults = undefined
  mockSnapshot = { status: 'pending' }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    stableId: 'test-1',
    addonId: 'test-addon',
    type: 'sensor',
    name: 'Test Sensor',
    online: true,
    disabled: false,
    parentDeviceId: null,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SensorHeroCard', () => {
  it('renders nothing while device row is loading (data undefined)', () => {
    mockDeviceData = undefined
    const { container } = render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  describe('numeric sensor — temperature (canonical unit °C from ROLE_DESCRIPTOR)', () => {
    it('renders value and canonical unit °C (no sourceInfo needed)', () => {
      mockSlice = { temperature: 21, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'temperature-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('21')).toBeTruthy()
      expect(screen.getByText('°C')).toBeTruthy()
    })

    it('shows Fahrenheit and the converted value for a Fahrenheit user (stored value stays °C)', () => {
      mockSlice = { temperature: 21, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'temperature-sensor' })
      render(
        <UnitPreferencesProvider value={{ system: 'metric', temperature: 'fahrenheit' }}>
          <SensorHeroCard trpc={trpc} deviceId={1} features={[]} />
        </UnitPreferencesProvider>,
      )
      expect(screen.getByText('°F')).toBeTruthy()
      expect(screen.getByText('69.8')).toBeTruthy()
      expect(screen.queryByText('°C')).toBeNull()
    })

    it('renders decimal value formatted to 1dp when not integer', () => {
      mockSlice = { temperature: 21.5, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'temperature-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('21.5')).toBeTruthy()
      expect(screen.getByText('°C')).toBeTruthy()
    })

    it('renders sensor name label', () => {
      mockSlice = { temperature: 21, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({
        name: 'Living Room Temp',
        role: 'temperature-sensor',
      })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Living Room Temp')).toBeTruthy()
    })

    it('renders awaiting state label while slice has not landed', () => {
      mockSlice = undefined
      mockDeviceData = makeDevice({ role: 'temperature-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText(/Awaiting state/)).toBeTruthy()
    })

    it('draws a composed device from the snapshot when the live slice has not landed', () => {
      mockSlice = undefined
      mockSnapshot = {
        status: 'success',
        data: { 'temperature-sensor': { temperature: 21.4 } },
      }
      mockDeviceData = makeDevice({
        id: 910,
        addonId: 'composer',
        name: 'Porch',
        role: 'temperature-sensor',
      })
      render(<SensorHeroCard trpc={trpc} deviceId={910} features={[]} />)
      expect(screen.getByText('21.4')).toBeTruthy()
      expect(screen.getByText('°C')).toBeTruthy()
      expect(screen.queryByText(/Awaiting state/)).toBeNull()
    })

    it('does not claim awaiting state when a composed device has no primary reading', () => {
      mockSlice = undefined
      mockSnapshot = { status: 'success', data: { 'group-status': { included: 1, total: 2 } } }
      mockDeviceData = makeDevice({
        addonId: 'composer',
        name: 'Porch',
        role: 'temperature-sensor',
      })
      render(<SensorHeroCard trpc={trpc} deviceId={910} features={[]} />)
      expect(screen.queryByText(/Awaiting state/)).toBeNull()
      expect(screen.getByText('Porch')).toBeTruthy()
    })
  })

  describe('numeric-sensor role — unit from the device quantity', () => {
    it('renders value + unit from sourceInfo.quantity', () => {
      mockSlice = { value: -85, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({
        role: 'numeric-sensor',
        sourceInfo: { id: 'sensor.rssi', system: 'ha', quantity: 'signal-level' },
      })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('-85')).toBeTruthy()
      expect(screen.getByText('dBm')).toBeTruthy()
    })
  })

  describe('binary sensor — motion', () => {
    it('renders Detected label when motion is active', () => {
      mockSlice = { detected: true, lastDetectedAt: Date.now(), autoClearAfterMs: null }
      mockDeviceData = makeDevice({ role: 'motion-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Detected')).toBeTruthy()
    })

    it('renders Clear label when motion is inactive', () => {
      mockSlice = { detected: false, lastDetectedAt: null, autoClearAfterMs: null }
      mockDeviceData = makeDevice({ role: 'motion-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Clear')).toBeTruthy()
    })
  })

  describe('binary sensor — generic binary cap', () => {
    it('renders On label when on is true', () => {
      mockSlice = { on: true, lastChangedAt: 0 }
      mockDeviceData = makeDevice({ role: 'binary-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('On')).toBeTruthy()
    })

    it('renders Off label when on is false', () => {
      mockSlice = { on: false, lastChangedAt: 0 }
      mockDeviceData = makeDevice({ role: 'binary-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Off')).toBeTruthy()
    })
  })

  describe('presence sensor', () => {
    it('renders Home when state is home', () => {
      mockSlice = {
        state: 'home',
        location: null,
        gps: null,
        lastChangedAt: 0,
      }
      mockDeviceData = makeDevice({ role: 'presence', type: 'presence' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Home')).toBeTruthy()
    })

    it('renders Away when state is not_home', () => {
      mockSlice = {
        state: 'not_home',
        location: null,
        gps: null,
        lastChangedAt: 0,
      }
      mockDeviceData = makeDevice({ role: 'presence', type: 'presence' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Away')).toBeTruthy()
    })
  })

  describe('battery sensor — numeric percentage (sensor.* device_class=battery)', () => {
    it('renders the numeric percentage when the numeric slice is present', () => {
      mockSlice = { value: 80, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'battery-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('80')).toBeTruthy()
      expect(screen.getByText('%')).toBeTruthy()
    })

    it('renders a battery level bar tinted high when charge is 80%', () => {
      mockSlice = { value: 80, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'battery-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      const bar = screen.getByTestId('battery-bar')
      expect(bar.getAttribute('data-band')).toBe('high')
      const fill = bar.querySelector<HTMLElement>('[style*="width"]')
      expect(fill?.style.width).toBe('80%')
    })

    it('tints the battery bar danger (low) when charge is 15%', () => {
      mockSlice = { value: 15, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'battery-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      const bar = screen.getByTestId('battery-bar')
      expect(bar.getAttribute('data-band')).toBe('low')
      expect(bar.querySelector('.bg-danger')).not.toBeNull()
    })

    it('does NOT render a battery bar for a non-battery numeric sensor', () => {
      mockSlice = { temperature: 21, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'temperature-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.queryByTestId('battery-bar')).toBeNull()
    })
  })

  describe('battery sensor — binary LOW_BAT (binary_sensor.* device_class=battery)', () => {
    it('renders Normal (not Awaiting state) when binary slice on is false', () => {
      mockSlice = { on: false, lastChangedAt: 0 }
      mockDeviceData = makeDevice({ role: 'battery-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Normal')).toBeTruthy()
      expect(screen.queryByText(/Awaiting state/)).toBeNull()
    })

    it('renders Low with warning style when binary slice on is true', () => {
      mockSlice = { on: true, lastChangedAt: 0 }
      mockDeviceData = makeDevice({ role: 'battery-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      const badge = screen.getByText('Low')
      expect(badge).toBeTruthy()
      expect(badge.className).toContain('text-warning')
    })
  })

  describe('datetime sensor — timestamp (device_class=timestamp)', () => {
    it('renders a locale-formatted value, NOT the numeric 0 nor the raw ISO string', () => {
      const iso = '2025-12-02T09:36:12+00:00'
      mockSlice = { value: iso, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ name: 'First Cleaning Date', role: 'datetime-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      // Label preserved.
      expect(screen.getByText('First Cleaning Date')).toBeTruthy()
      // Not the broken numeric hero ('0') nor the raw ISO string.
      expect(screen.queryByText('0')).toBeNull()
      expect(screen.queryByText(iso)).toBeNull()
      // The rendered hero value equals the deterministic helper output (the
      // datetime-sensor descriptor default is 'datetime'), and is NOT the raw
      // ISO — the 'T' separator + offset are gone.
      const formatted = formatControlDateTime(iso, 'datetime')
      const heroValue = screen.getByText(formatted)
      expect(heroValue.textContent).toBe(formatted)
      expect(heroValue.textContent).not.toBe(iso)
      expect(heroValue.textContent).not.toContain('T09:36')
      // Determinism anchor: explicit-locale render still carries the year + a time.
      expect(formatControlDateTime(iso, 'datetime', 'en-US')).toContain('2025')
      expect(formatControlDateTime(iso, 'datetime', 'en-US')).toMatch(/\d{1,2}:\d{2}/)
    })

    it('falls back to the raw value when unparseable', () => {
      mockSlice = { value: 'not-a-date', lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'datetime-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('not-a-date')).toBeTruthy()
    })

    it('renders awaiting state while the slice is at cold-start (empty string)', () => {
      mockSlice = { value: '', lastFetchedAt: 0 }
      mockDeviceData = makeDevice({ role: 'datetime-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText(/Awaiting state/)).toBeTruthy()
    })

    it("slice format 'date' renders the date-only hero (slice-driven, no time component)", () => {
      // HA device_class=date → slice format='date'. The big value is the
      // date-only locale rendering, NOT the descriptor's 'datetime' default.
      const isoDate = '2025-12-02'
      mockSlice = { value: isoDate, format: 'date', lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ name: 'Last Service', role: 'datetime-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('Last Service')).toBeTruthy()
      expect(screen.getByText(formatControlDateTime(isoDate, 'date'))).toBeTruthy()
      // The date-only shape differs from the datetime shape — the slice format wins.
      expect(formatControlDateTime(isoDate, 'date')).not.toBe(
        formatControlDateTime(isoDate, 'datetime'),
      )
    })
  })

  describe('per-device display override', () => {
    it('converts a °C temperature slice to °F with precision 0 from display override', () => {
      mockSlice = { temperature: 20, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({
        role: 'temperature-sensor',
        display: { unit: '°F', precision: 0 },
      })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      // 20°C → 68°F, precision 0 after conversion.
      expect(screen.getByText('68')).toBeTruthy()
      expect(screen.getByText('°F')).toBeTruthy()
      expect(screen.queryByText('°C')).toBeNull()
    })

    it('applies a per-role display default under no device override', () => {
      mockSlice = { temperature: 0, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'temperature-sensor' })
      mockRoleDefaults = { defaults: { 'temperature-sensor': { unit: '°F' } } }
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('32')).toBeTruthy()
      expect(screen.getByText('°F')).toBeTruthy()
    })
  })

  describe('numeric sensor — humidity (canonical unit % from ROLE_DESCRIPTOR)', () => {
    it('renders percent value and canonical % unit (no sourceInfo needed)', () => {
      mockSlice = { humidity: 65, lastFetchedAt: 1700000000000 }
      mockDeviceData = makeDevice({ role: 'humidity-sensor' })
      render(<SensorHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByText('65')).toBeTruthy()
      expect(screen.getByText('%')).toBeTruthy()
    })
  })
})
