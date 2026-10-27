// @vitest-environment jsdom
/**
 * Tests for SensorInlineControl — registry-path row atom for Sensor / Presence
 * devices. Wraps SensorValueAtom with a device-row fetch so the registry path
 * renders the same value + unit as the row's special-case SensorValueAtom path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SensorInlineControl } from '../sensor-inline-control'

// ── Slice state controlled by each test ─────────────────────────────────────

let mockSlice: unknown

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: vi.fn(() => null),
  useDeviceStateSlice: vi.fn(() => mockSlice),
}))

// ── Device row controlled by each test ──────────────────────────────────────

let mockDeviceData: unknown

vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerGetDevice: vi.fn(() => ({ data: mockDeviceData })),
  useDeviceManagerGetRoleDisplayDefaults: vi.fn(() => ({ data: undefined })),
}))

const trpc = {} as never

beforeEach(() => {
  mockSlice = undefined
  mockDeviceData = undefined
})

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

describe('SensorInlineControl', () => {
  it('renders nothing while device row is loading (data undefined)', () => {
    mockDeviceData = undefined
    const { container } = render(<SensorInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders temperature value + unit (°C) via SensorValueAtom when row + slice land', () => {
    mockSlice = { temperature: 21, lastFetchedAt: 0 }
    mockDeviceData = makeDevice({
      role: 'temperature-sensor',
      sourceInfo: { id: 'sensor.temp', system: 'ha', unit: '°C' },
    })
    const { container } = render(<SensorInlineControl trpc={trpc} deviceId={1} features={[]} />)
    const badge = container.firstChild as HTMLElement
    expect(badge.textContent).toContain('21')
    expect(badge.textContent).toContain('°C')
  })

  it('renders binary sensor Detected label via SensorValueAtom', () => {
    mockSlice = { detected: true, lastDetectedAt: Date.now(), autoClearAfterMs: null }
    mockDeviceData = makeDevice({ role: 'motion-sensor' })
    render(<SensorInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Detected')).toBeTruthy()
  })

  it('renders presence Home label via SensorValueAtom', () => {
    mockSlice = { state: 'home', location: null, gps: null, lastChangedAt: 0 }
    mockDeviceData = makeDevice({ role: 'presence', type: 'presence' })
    render(<SensorInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Home')).toBeTruthy()
  })
})
