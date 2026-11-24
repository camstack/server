// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DeviceRole, DeviceType } from '@camstack/types'
import { TimedRunRowControl } from '../timed-run-row-control'
import { QUICK_RUN_SAVE_DEBOUNCE_MS } from '../timed-run-quick-model'

const runFor = vi.fn()
const cancel = vi.fn()
const setSettings = vi.fn()

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
    cap: { runFor, cancel, setSettings },
    slice: { activeUntil: NOW + msLeft, requestedBy: null, quickRun },
    available: true,
    online: true,
  }
}

beforeEach(() => {
  runFor.mockReset()
  cancel.mockReset()
  setSettings.mockReset()
  setSettings.mockResolvedValue(undefined)
  runFor.mockResolvedValue({ ok: true, activeUntil: NOW + 60_000 })
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// D1033 — a plug-in heater is a switch with the heater role.
const HEATER_SWITCH = { deviceType: DeviceType.Switch, deviceRole: DeviceRole.SwitchHeater }

describe('TimedRunRowControl', () => {
  it('runs for the duration the hub reports for THIS device, and says it', () => {
    timer = {
      cap: { runFor, cancel, setSettings },
      slice: { activeUntil: null, requestedBy: null, quickRun: { duration: 45, unit: 'min' } },
      available: true,
      online: true,
    }
    render(<TimedRunRowControl trpc={trpc} deviceId={5} {...HEATER_SWITCH} />)
    fireEvent.click(screen.getByRole('button', { name: /45/ }))
    expect(runFor).toHaveBeenCalledWith({ duration: 45, unit: 'min' })
  })

  it('falls back to the type default when the hub has not said', () => {
    timer = {
      cap: { runFor, cancel, setSettings },
      slice: { activeUntil: null, requestedBy: null, quickRun: null },
      available: true,
      online: true,
    }
    render(<TimedRunRowControl trpc={trpc} deviceId={5} {...HEATER_SWITCH} />)
    fireEvent.click(screen.getByRole('button', { name: /30/ }))
    expect(runFor).toHaveBeenCalledWith({ duration: 30, unit: 'min' })
  })

  it('an armed heater offers Stop and the minutes left', () => {
    timer = armed(23 * 60_000, { duration: 30, unit: 'min' })
    render(<TimedRunRowControl trpc={trpc} deviceId={5} {...HEATER_SWITCH} />)
    expect(screen.getByText(/23 min/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    expect(cancel).toHaveBeenCalledWith({})
    expect(runFor).not.toHaveBeenCalled()
  })

  it('draws nothing when the cap is not bound', () => {
    timer = { cap: undefined, slice: undefined, available: true, online: true }
    const { container } = render(
      <TimedRunRowControl
        trpc={trpc}
        deviceId={5}
        deviceType={DeviceType.Switch}
        deviceRole={null}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('a bound cap on a plain switch draws the default run (D1097)', () => {
    timer = {
      cap: { runFor, cancel, setSettings },
      slice: { activeUntil: null, requestedBy: null, quickRun: null },
      available: true,
      online: true,
    }
    render(
      <TimedRunRowControl
        trpc={trpc}
        deviceId={5}
        deviceType={DeviceType.Switch}
        deviceRole={null}
      />,
    )
    expect(screen.getByTestId('timed-run-duration-minutes')).toHaveProperty('value', '15')
  })

  describe('the one-tap duration is edited on the control itself', () => {
    const idle = (): void => {
      timer = {
        cap: { runFor, cancel, setSettings },
        slice: { activeUntil: null, requestedBy: null, quickRun: { duration: 30, unit: 'min' } },
        available: true,
        online: true,
      }
      render(<TimedRunRowControl trpc={trpc} deviceId={5} {...HEATER_SWITCH} />)
    }
    const field = (): HTMLElement => screen.getByTestId('timed-run-duration-minutes')

    it('saves an edit once, after the debounce, through setSettings', () => {
      idle()
      fireEvent.change(field(), { target: { value: '2' } })
      fireEvent.change(field(), { target: { value: '20' } })
      act(() => vi.advanceTimersByTime(QUICK_RUN_SAVE_DEBOUNCE_MS - 1))
      expect(setSettings).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(setSettings).toHaveBeenCalledTimes(1)
      expect(setSettings).toHaveBeenCalledWith({ settings: { quickRunDuration: 20 } })
    })

    it('runs with the edited value, saving it first', () => {
      idle()
      fireEvent.change(field(), { target: { value: '20' } })
      fireEvent.click(screen.getByTestId('timed-run-run'))
      expect(setSettings).toHaveBeenCalledWith({ settings: { quickRunDuration: 20 } })
      expect(runFor).toHaveBeenCalledWith({ duration: 20, unit: 'min' })
    })

    it('shows a value above the maximum instead of saving or running it', () => {
      idle()
      fireEvent.change(field(), { target: { value: '99999' } })
      act(() => vi.advanceTimersByTime(QUICK_RUN_SAVE_DEBOUNCE_MS * 2))
      expect(setSettings).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toMatch(/Enter 1 to/)
      fireEvent.click(screen.getByTestId('timed-run-run'))
      expect(runFor).not.toHaveBeenCalled()
    })

    it('shows a refused save', async () => {
      setSettings.mockRejectedValue(new Error('not allowed'))
      idle()
      fireEvent.change(field(), { target: { value: '20' } })
      await act(async () => {
        vi.advanceTimersByTime(QUICK_RUN_SAVE_DEBOUNCE_MS)
      })
      expect(screen.getByRole('alert').textContent).toContain('not allowed')
    })

    it('shows a run the hub refused', async () => {
      runFor.mockResolvedValue({ ok: false, reason: 'over-max', maxSeconds: 600 })
      idle()
      await act(async () => {
        fireEvent.click(screen.getByTestId('timed-run-run'))
      })
      expect(screen.getByRole('alert').textContent?.length).toBeGreaterThan(0)
    })
  })
})
