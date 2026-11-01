// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DeviceType, TIMED_RUN_LIMITS, type TimedRunLimit } from '@camstack/types'
import { TimedRunControl, formatCountdown, maxInUnit } from '../timed-run-control'

const runFor = vi.fn()
const cancel = vi.fn()

let mockResult: { cap: unknown; slice: unknown; online: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const HEATER: TimedRunLimit = requireLimit(DeviceType.Heater)
const FOUNTAIN: TimedRunLimit = requireLimit(DeviceType.PetFountain)

function requireLimit(type: DeviceType): TimedRunLimit {
  const limit = TIMED_RUN_LIMITS[type]
  if (limit === undefined) throw new Error(`no timed-run limit for ${type}`)
  return limit
}

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

  it('shows a countdown and a cancel while a deadline is armed, none otherwise', () => {
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    expect(screen.queryByTestId('timed-run-countdown')).toBeNull()
    cleanup()
    mockResult = {
      cap: { runFor, cancel },
      slice: { activeUntil: Date.now() + 90_000, requestedBy: null, lastFetchedAt: 1 },
      online: true,
    }
    render(<TimedRunControl trpc={trpc} deviceId={5} limit={HEATER} />)
    expect(screen.getByTestId('timed-run-countdown')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(cancel).toHaveBeenCalledWith({})
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
})
