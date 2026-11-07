// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HeaterInlineControl } from '../heater-control'

const runFor = vi.fn()
const setState = vi.fn()

interface CapResult {
  readonly cap: unknown
  readonly slice: unknown
  readonly available: boolean
  readonly online: boolean
}
const results: { switch: CapResult; running: CapResult; timer: CapResult } = {
  switch: { cap: undefined, slice: undefined, available: true, online: true },
  running: { cap: undefined, slice: undefined, available: true, online: true },
  timer: { cap: undefined, slice: undefined, available: true, online: true },
}

// The hook is asked once per cap; the accessor tells which one.
const PROBE = { switch: 'switch', runningState: 'running', timedRun: 'timer' }
vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: (options: { cap: (probe: typeof PROBE) => string }) => {
    const which = options.cap(PROBE)
    if (which === 'switch') return results.switch
    if (which === 'running') return results.running
    return results.timer
  },
}))
vi.mock('../../../hooks/use-optimistic-slice', () => ({
  useOptimisticSlice: (slice: unknown) => ({
    display: slice,
    applyOptimisticAction: (_patch: unknown, run: () => unknown) => void run(),
  }),
}))

const trpc = {} as never

function timer(quickRun: unknown): CapResult {
  return {
    cap: { runFor },
    slice: quickRun === undefined ? undefined : { activeUntil: null, requestedBy: null, quickRun },
    available: true,
    online: true,
  }
}

beforeEach(() => {
  runFor.mockReset()
  setState.mockReset()
  results.switch = {
    cap: { setState },
    slice: { on: false, lastChangedAt: 0 },
    available: true,
    online: true,
  }
})
afterEach(cleanup)

describe('HeaterInlineControl quick run', () => {
  it('runs for the duration the hub reports for THIS device, and says it', () => {
    results.timer = timer({ duration: 45, unit: 'min' })
    render(<HeaterInlineControl trpc={trpc} deviceId={5} features={undefined} />)
    const button = screen.getByRole('button', { name: /45/ })
    fireEvent.click(button)
    expect(runFor).toHaveBeenCalledWith({ duration: 45, unit: 'min' })
  })

  it('offers no run button until the hub has said what the run is', () => {
    results.timer = timer(undefined)
    render(<HeaterInlineControl trpc={trpc} deviceId={5} features={undefined} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
