// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SensorValueAtom } from '../sensor-value-atom'
import { formatControlDateTime } from '../../../lib/format-control-datetime'
import type { DeviceItemDevice } from '../../device-item/helpers'

let mockSlice: unknown
/** When set, the second useDeviceStateSlice call (enum-sensor fallback) returns this. */
let mockEnumSlice: unknown

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: vi.fn(() => null),
  useDeviceStateSlice: vi.fn(() => {
    // SensorValueAtom calls useDeviceStateSlice twice for numeric descriptors:
    // first call → primary (numeric/binary/presence/string) slice
    // second call → enum-sensor fallback (only active for numeric descriptors)
    // The mock tracks call count per render via a closure reset in beforeEach.
    callCount++
    if (callCount === 2 && mockEnumSlice !== undefined) return mockEnumSlice
    return mockSlice
  }),
}))

let callCount = 0

/** Per-role display defaults returned by the mocked generated hook. */
let mockRoleDefaults: { defaults: Record<string, unknown> } | undefined

vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerGetRoleDisplayDefaults: vi.fn(() => ({ data: mockRoleDefaults })),
}))

const trpc = {} as never

const baseDevice: DeviceItemDevice = {
  id: 1,
  stableId: 'test-1',
  addonId: 'test-addon',
  type: 'sensor',
  name: 'Test Sensor',
  online: true,
  disabled: false,
  parentDeviceId: null,
}

beforeEach(() => {
  mockSlice = undefined
  mockEnumSlice = undefined
  mockRoleDefaults = undefined
  callCount = 0
})

describe('SensorValueAtom', () => {
  describe('numeric sensor — temperature (canonical unit from ROLE_DESCRIPTOR)', () => {
    it('renders value + canonical unit °C (no sourceInfo needed)', () => {
      mockSlice = { celsius: 21.5, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'temperature-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('21.5')
      expect(badge.textContent).toContain('°C')
    })

    it('renders nothing when slice has not landed', () => {
      mockSlice = undefined
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'temperature-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(container.firstChild).toBeNull()
    })

    it('converts to °F with precision 0 from a per-device display override', () => {
      mockSlice = { celsius: 20, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'temperature-sensor',
        display: { unit: '°F', precision: 0 },
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('68')
      expect(badge.textContent).toContain('°F')
      expect(badge.textContent).not.toContain('°C')
    })

    it('ignores a cross-dimension override (keeps source unit + identity value)', () => {
      mockSlice = { celsius: 20, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'temperature-sensor',
        display: { unit: 'hPa' },
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('20')
      expect(badge.textContent).toContain('°C')
      expect(badge.textContent).not.toContain('hPa')
    })
  })

  describe('binary sensor — motion', () => {
    it('renders Detected label when motion is active', () => {
      mockSlice = { detected: true, lastDetectedAt: Date.now(), autoClearAfterMs: null }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'motion-sensor',
      }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('Detected')).toBeTruthy()
    })

    it('renders Clear label when motion is inactive', () => {
      mockSlice = { detected: false, lastDetectedAt: null, autoClearAfterMs: null }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'motion-sensor',
      }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('Clear')).toBeTruthy()
    })
  })

  describe('presence sensor', () => {
    it('renders Home when state is home', () => {
      mockSlice = {
        state: 'home',
        location: null,
        gps: null,
        batteryPercent: null,
        lastChangedAt: 0,
      }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'presence',
        type: 'presence',
      }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('Home')).toBeTruthy()
    })

    it('renders Away when state is not_home', () => {
      mockSlice = {
        state: 'not_home',
        location: null,
        gps: null,
        batteryPercent: null,
        lastChangedAt: 0,
      }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'presence',
        type: 'presence',
      }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('Away')).toBeTruthy()
    })
  })

  describe('binary sensor — binary-sensor role (generic binary cap)', () => {
    it('renders On label when on is true', () => {
      mockSlice = { on: true, lastChangedAt: 0 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'binary-sensor',
      }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('On')).toBeTruthy()
    })

    it('renders Off label when on is false', () => {
      mockSlice = { on: false, lastChangedAt: 0 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'binary-sensor',
      }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('Off')).toBeTruthy()
    })
  })

  describe('power sensor — power-meter cap (canonical unit W from ROLE_DESCRIPTOR)', () => {
    it('renders watts value and canonical unit W (no sourceInfo needed)', () => {
      mockSlice = { watts: 1200, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'power-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('1200')
      expect(badge.textContent).toContain('W')
    })

    it('renders nothing when watts field is absent (numericSensor slice shape)', () => {
      // A numericSensor slice has { value: 1200 } — watts would be absent,
      // so if the descriptor wrongly pointed to numericSensor the render would
      // see undefined and return null. With the correct fix pointing to
      // powerMeter, { watts: undefined } also renders null — but the key test
      // is that when the correct powerMeter slice is present it DOES render.
      mockSlice = { watts: undefined, lastFetchedAt: 0 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'power-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('typed numeric sensor — temperature with precision from slice', () => {
    it('renders precision-formatted value when slice carries precision field', () => {
      // temperature-sensor slice now carries precision populated by the HA provider.
      // SensorValueAtom reads slice['precision'] and passes it to formatNumeric.
      mockSlice = { celsius: 24.567, precision: 1, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'temperature-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      // 24.567 formatted to 1 decimal → "24.6"
      expect(badge.textContent).toContain('24.6')
      expect(badge.textContent).toContain('°C')
    })

    it('renders auto-formatted value when precision is absent from the slice', () => {
      // No precision → auto-formatting: non-integer uses toFixed(1).
      mockSlice = { celsius: 21.5, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'temperature-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('21.5')
      expect(badge.textContent).toContain('°C')
    })
  })

  describe('unknown role', () => {
    it('renders nothing for an unrecognised role', () => {
      mockSlice = { someField: 123 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'unrecognised-role',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('numeric-sensor role — unit from the device quantity', () => {
    it('renders value + unit from the device quantity', () => {
      mockSlice = { value: 2941713, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'numeric-sensor',
        sourceInfo: { id: 'sensor.rssi', system: 'ha', quantity: 'signal-level' },
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('2941713')
      expect(badge.textContent).toContain('dBm')
    })

    it('renders a duration from the device quantity', () => {
      mockSlice = { value: 30, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'numeric-sensor',
        sourceInfo: { id: 'sensor.runtime', system: 'ha', quantity: 'duration' },
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('30')
      expect(badge.textContent).toContain('s')
    })

    it('renders nothing when numeric slice is at cold-start and no enum-sensor fallback', () => {
      // Cold-start sentinel: value=0, lastFetchedAt=0 — sensor not yet received
      // a push. Should suppress "0" display to avoid misleading UI.
      mockSlice = { value: 0, lastFetchedAt: 0 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'numeric-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(container.firstChild).toBeNull()
    })

    it('renders string from enum-sensor fallback when numeric slice is at cold-start', () => {
      // Part 2: already-adopted free-text sensor with role='numeric-sensor' but
      // HaNumericSensorDevice also registered enum-sensor cap with the string.
      // When numeric slice is cold-start, SensorValueAtom falls back to enum-sensor.
      mockSlice = { value: 0, lastFetchedAt: 0 }
      mockEnumSlice = { value: '192.168.10.42', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'numeric-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(container.firstChild).not.toBeNull()
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toBe('192.168.10.42')
    })
  })

  describe('weather roles — value + unit from the device quantity', () => {
    it.each([
      ['wind-sensor', 'speed', 5.2, 'm/s'],
      ['rain-sensor', 'precipitation', 12.4, 'mm'],
      ['uv-sensor', 'index', 7, ''],
      ['solar-radiation-sensor', 'irradiance', 845, 'W/m²'],
      ['soil-moisture-sensor', 'percentage', 38, '%'],
    ] as const)('renders %s from the device quantity', (role, quantity, value, unit) => {
      mockSlice = { value, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role,
        sourceInfo: { id: 'sensor.weather', system: 'ha', quantity },
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge).not.toBeNull()
      expect(badge.textContent).toContain(String(value))
      if (unit.length > 0) expect(badge.textContent).toContain(unit)
    })
  })

  describe('enum-sensor role — string sensor renders value', () => {
    it('renders the string value from enum-sensor slice', () => {
      // Part 2: new adoptions with device_class=null are mapped to enum-sensor.
      // Verifies the ROLE_DESCRIPTOR has an enum-sensor entry and renders text.
      mockSlice = { value: '192.168.10.42', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'enum-sensor',
      }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('192.168.10.42')).toBeTruthy()
    })

    it('renders nothing when enum-sensor slice is at cold-start (empty string)', () => {
      mockSlice = { value: '', lastFetchedAt: 0 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'enum-sensor',
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('datetime-sensor role — timestamp rendered locale-formatted', () => {
    it('renders a locale-formatted date/time, NOT the raw ISO string', () => {
      // HA device_class=timestamp → enum-sensor slice carries the raw ISO string.
      // The datetime descriptor renders it via formatControlDateTime.
      mockSlice = { value: '2025-12-02T09:36:12+00:00', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'datetime-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      // Should not echo the raw ISO string verbatim.
      expect(badge.textContent).not.toBe('2025-12-02T09:36:12+00:00')
      // Should reference the year (locale-formatted output still contains it).
      expect(badge.textContent).toContain('2025')
      expect(badge.textContent).not.toBe('0')
    })

    it('falls back to the raw value when the string is unparseable', () => {
      mockSlice = { value: 'not-a-date', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'datetime-sensor' }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('not-a-date')).toBeTruthy()
    })

    it('renders nothing when the slice is at cold-start (empty string)', () => {
      mockSlice = { value: '', lastFetchedAt: 0 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'datetime-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(container.firstChild).toBeNull()
    })

    it("slice format 'datetime' renders the full locale date+time (slice-driven)", () => {
      // The slice carries format='datetime' (HA device_class=timestamp). The
      // render output must equal the helper's own 'datetime' output, deterministic
      // against the test runner's locale (explicit en-US comparison below).
      const iso = '2025-12-02T09:36:12+00:00'
      mockSlice = { value: iso, format: 'datetime', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'datetime-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toBe(formatControlDateTime(iso, 'datetime'))
      // Determinism anchor: full datetime in en-US contains the year AND a time.
      expect(formatControlDateTime(iso, 'datetime', 'en-US')).toContain('2025')
      expect(formatControlDateTime(iso, 'datetime', 'en-US')).toMatch(/\d{1,2}:\d{2}/)
    })

    it("slice format 'date' renders a date with NO time component (slice-driven)", () => {
      // HA device_class=date → slice format='date'. The output must be the
      // date-only locale rendering — distinct from the 'datetime' shape.
      const isoDate = '2025-12-02'
      mockSlice = { value: isoDate, format: 'date', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'datetime-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toBe(formatControlDateTime(isoDate, 'date'))
      // en-US date-only output is e.g. '12/2/2025' — no ':' time separator.
      expect(formatControlDateTime(isoDate, 'date', 'en-US')).not.toMatch(/:/)
    })

    it("slice format overrides the descriptor default ('date' slice ≠ 'datetime' default)", () => {
      // The descriptor default is 'datetime'; a slice carrying format='date'
      // must win, so the same ISO date does NOT render with a time component.
      const isoDate = '2025-12-02'
      mockSlice = { value: isoDate, format: 'date', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'datetime-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toBe(formatControlDateTime(isoDate, 'date'))
      expect(badge.textContent).not.toBe(formatControlDateTime(isoDate, 'datetime'))
    })
  })

  describe('power-meter sub-roles — voltage / current (distinct fields + canonical units)', () => {
    it('voltage-sensor renders volts field + canonical unit V', () => {
      // HaPowerMeterDevice writes the voltage metric to the `volts` field.
      mockSlice = { volts: 231, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'voltage-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('231')
      expect(badge.textContent).toContain('V')
    })

    it('current-sensor renders amps field + canonical unit A', () => {
      mockSlice = { amps: 2.5, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'current-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('2.5')
      expect(badge.textContent).toContain('A')
    })
  })

  describe('battery-sensor — numeric % via numeric-sensor cap', () => {
    it('renders value + % (canonical fallback when slice has no unit)', () => {
      mockSlice = { value: 87, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'battery-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('87')
      expect(badge.textContent).toContain('%')
    })

    it('renders the LIVE slice unit % when present', () => {
      mockSlice = { value: 16, unit: '%', lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'battery-sensor' }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('16')
      expect(badge.textContent).toContain('%')
    })
  })

  describe('battery-sensor — binary LOW_BAT via binary cap (binary_sensor.*)', () => {
    it('renders Normal (not blank) when binary slice on is false', () => {
      // binary_sensor.* device_class=battery → binary slice { on: false } = OK.
      mockSlice = { on: false, lastChangedAt: 0 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'battery-sensor' }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      expect(screen.getByText('Normal')).toBeTruthy()
    })

    it('renders Low with warning style when binary slice on is true', () => {
      // on:true = LOW battery → warning treatment.
      mockSlice = { on: true, lastChangedAt: 0 }
      const device: DeviceItemDevice = { ...baseDevice, role: 'battery-sensor' }
      render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = screen.getByText('Low')
      expect(badge).toBeTruthy()
      expect(badge.className).toContain('text-warning')
    })
  })

  describe('an operator override converts from the base unit', () => {
    it('temperature-sensor renders °F when the display override says so', () => {
      mockSlice = { celsius: 0, lastFetchedAt: 1700000000000 }
      const device: DeviceItemDevice = {
        ...baseDevice,
        role: 'temperature-sensor',
        display: { unit: '°F' },
      }
      const { container } = render(<SensorValueAtom trpc={trpc} device={device} />)
      const badge = container.firstChild as HTMLElement
      expect(badge.textContent).toContain('32')
      expect(badge.textContent).toContain('°F')
      expect(badge.textContent).not.toContain('°C')
    })
  })
})
