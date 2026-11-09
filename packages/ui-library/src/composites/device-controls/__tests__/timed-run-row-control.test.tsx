// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DeviceType } from '@camstack/types'
import { TimedRunRowControl } from '../timed-run-row-control'

const runFor = vi.fn()
const cancel = vi.fn()

interface CapResult {
  readonly cap: unknown
  readonly slice: unknown
  readonly available: boolean
  readonly online: boolean
}

let timer: CapResult = { cap: undefined, slice: undefined, available: true, online: true }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => timer,
}))

const trpc = {} as never
const NOW = 1_700_000_000_000

function armed(msLeft: number, quickRun: unknown): CapResult {
  return {
    cap: { runFor, cancel },
    slice: { activeUntil: NOW + msLeft, requestedBy: null, quickRun },
    available: true,
    online: true,
  }
}

beforeEach(() => {
  runFor.mockReset()
  cancel.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('TimedRunRowControl', () => {
  it('runs for the duration the hub reports for THIS device, and says it', () => {
    timer = {
      cap: { runFor, cancel },
      slice: { activeUntil: null, requestedBy: null, quickRun: { duration: 45, unit: 'min' } },
      available: true,
      online: true,
    }
    render(<TimedRunRowControl trpc={trpc} deviceId={5} deviceType={DeviceType.Heater} />)
    fireEvent.click(screen.getByRole('button', { name: /45/ }))
    expect(runFor).toHaveBeenCalledWith({ duration: 45, unit: 'min' })
  })

  it('falls back to the type default when the hub has not said', () => {
    timer = {
      cap: { runFor, cancel },
      slice: { activeUntil: null, requestedBy: null, quickRun: null },
      available: true,
      online: true,
    }
    render(<TimedRunRowControl trpc={trpc} deviceId={5} deviceType={DeviceType.Heater} />)
    fireEvent.click(screen.getByRole('button', { name: /30/ }))
    expect(runFor).toHaveBeenCalledWith({ duration: 30, unit: 'min' })
  })

  it('an armed heater offers Stop and the minutes left', () => {
    timer = armed(23 * 60_000, { duration: 30, unit: 'min' })
    render(<TimedRunRowControl trpc={trpc} deviceId={5} deviceType={DeviceType.Heater} />)
    expect(screen.getByText(/23 min/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    expect(cancel).toHaveBeenCalledWith({})
    expect(runFor).not.toHaveBeenCalled()
  })

  it('draws nothing when the cap is not bound', () => {
    timer = { cap: undefined, slice: undefined, available: true, online: true }
    const { container } = render(
      <TimedRunRowControl trpc={trpc} deviceId={5} deviceType={DeviceType.Switch} />,
    )
    expect(container.textContent).toBe('')
  })
})
