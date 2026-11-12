// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { VacuumControlStatus } from '@camstack/types'
import { VacuumInlineControl } from '../vacuum-control'

/** Full default slice; spread overrides on top — no `as` casts in tests. */
function makeSlice(overrides: Partial<VacuumControlStatus> = {}): VacuumControlStatus {
  return {
    state: 'cleaning',
    batteryLevel: 77,
    fanSpeed: 'standard',
    availableFanSpeeds: ['standard', 'turbo'],
    progress: null,
    errorCode: null,
    errorLabel: null,
    lastChangedAt: 0,
    ...overrides,
  }
}

const start = vi.fn()
const pause = vi.fn()
const stop = vi.fn()
const returnToBase = vi.fn()
const locate = vi.fn()
const setFanSpeed = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

beforeEach(() => {
  start.mockReset()
  pause.mockReset()
  stop.mockReset()
  returnToBase.mockReset()
  locate.mockReset()
  setFanSpeed.mockReset()
  mockResult = {
    cap: { start, pause, stop, returnToBase, locate, setFanSpeed },
    slice: makeSlice(),
    available: true,
  }
})

describe('VacuumInlineControl', () => {
  it('renders start/pause/return buttons + battery', () => {
    render(<VacuumInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Start')).toBeTruthy()
    expect(screen.getByLabelText('Pause')).toBeTruthy()
    expect(screen.getByLabelText('Return to base')).toBeTruthy()
    expect(screen.getByText('77%')).toBeTruthy()
  })

  it('wires buttons to cap methods', () => {
    render(<VacuumInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Start'))
    fireEvent.click(screen.getByLabelText('Pause'))
    fireEvent.click(screen.getByLabelText('Return to base'))
    expect(start).toHaveBeenCalledWith({})
    expect(pause).toHaveBeenCalledWith({})
    expect(returnToBase).toHaveBeenCalledWith({})
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<VacuumInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('disables buttons when not available', () => {
    mockResult = { ...mockResult, available: false }
    render(<VacuumInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect((screen.getByLabelText('Start') as HTMLButtonElement).disabled).toBe(true)
  })
})
