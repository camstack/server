// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  TIMED_RUN_HEATER_LIMIT,
  TIMED_RUN_PET_FOUNTAIN_LIMIT,
  type TimedRunLimit,
} from '@camstack/types'
import { TimedRunControl, formatCountdown, maxInUnit } from '../timed-run-control'

const runFor = vi.fn()
const cancel = vi.fn()

let mockResult: { cap: unknown; slice: unknown; online: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const HEATER: TimedRunLimit = TIMED_RUN_HEATER_LIMIT
const FOUNTAIN: TimedRunLimit = TIMED_RUN_PET_FOUNTAIN_LIMIT

const trpc = {} as never

beforeEach(() => {
  cleanup()
  runFor.mockReset()
  cancel.mockReset()
  runFor.mockResolvedValue({ ok: true, activeUntil: 1 })
  mockResult = { cap: { runFor, cancel }, slice: undefined, online: true }
})

describe('TimedRunControl', () => {
  it('runs for the typed duration in the type unit', () => {
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(runFor).toHaveBeenCalledWith({ duration: 45, unit: 'min' })
  })

  it('a pet fountain runs in seconds', () => {
    render(<TimedRunControl trpc={trpc} deviceId={6} limit={FOUNTAIN} />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(runFor).toHaveBeenCalledWith({ duration: 90, unit: 's' })
  })

  it('refuses a value above the maximum without calling the device', () => {
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '181' } })
    expect(screen.getByRole('button', { name: /run/i }).hasAttribute('disabled')).toBe(true)
    expect(runFor).not.toHaveBeenCalled()
  })

  function armedSlice(quickRun = { duration: 45, unit: 'min' }): void {
    mockResult = {
      cap: { runFor, cancel },
      slice: { activeUntil: Date.now() + 90_000, requestedBy: null, quickRun, lastFetchedAt: 1 },
      online: true,
    }
  }

  it('idle: no countdown, no Stop, no Restart', () => {
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    expect(screen.queryByTestId('timed-run-countdown')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(screen.getByRole('spinbutton')).toBeTruthy()
  })

  it('armed: Stop, the time left and Restart replace the start control', () => {
    armedSlice()
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
    expect(screen.getByTestId('timed-run-countdown').textContent).toContain('1:')
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('armed: Stop cancels the run', () => {
    armedSlice()
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(cancel).toHaveBeenCalledWith({})
  })

  it("armed: Restart runs again for this device's duration", () => {
    armedSlice({ duration: 45, unit: 'min' })
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(runFor).toHaveBeenCalledWith({ duration: 45, unit: 'min' })
  })

  it('armed: a refused Restart says why', async () => {
    armedSlice()
    runFor.mockResolvedValue({ ok: false, reason: 'command-failed', maxSeconds: null })
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('says a typed refusal in words', async () => {
    runFor.mockResolvedValue({ ok: false, reason: 'over-max', maxSeconds: 10 })
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('renders nothing when the device has no timed-run cap', () => {
    mockResult = { cap: undefined, slice: undefined, online: true }
    const { container } = render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    expect(container.textContent).toBe('')
  })
})

describe('helpers', () => {
  it('formats a countdown and the field maximum per unit', () => {
    expect(formatCountdown(65_000)).toBe('1:05')
    expect(maxInUnit(HEATER)).toBe(180)
    expect(maxInUnit(FOUNTAIN)).toBe(300)
  })

  it("starts from this device's own one-tap run, not a constant", () => {
    mockResult = {
      cap: { runFor, cancel },
      slice: {
        activeUntil: null,
        requestedBy: null,
        quickRun: { duration: 45, unit: 'min' },
        lastFetchedAt: 1,
      },
      online: true,
    }
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(runFor).toHaveBeenCalledWith({ duration: 45, unit: 'min' })
  })
})
