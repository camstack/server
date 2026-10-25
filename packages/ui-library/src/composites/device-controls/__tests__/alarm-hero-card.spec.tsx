// @vitest-environment jsdom
/**
 * Tests for AlarmHeroCard / AlarmInlineControl — a rejected cap.arm()/
 * cap.disarm() must surface as a visible refusal, not a swallowed promise
 * (D630/Task 3), on BOTH surfaces, and a stale rejection must never roll
 * back a newer press's optimistic state.
 *
 * Strategy: mock `useDeviceCapability` so we control the cap/slice returned;
 * `useOptimisticSlice` runs for REAL, so a rollback is asserted against the
 * actual hook, not a stub (mirrors optimistic-controls.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

import { AlarmHeroCard, AlarmInlineControl } from '../alarm-hero-card'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'

// `useDeviceCapability` is mocked above, so `useDeviceProxy` (which this
// would otherwise feed) never runs — this stub only has to satisfy the
// prop's real type, never actually answer a query.
const trpc: UseDeviceProxyTrpc = {
  deviceManager: {
    getBindings: {
      query: () =>
        Promise.reject(new Error('unused — useDeviceCapability is mocked in this suite')),
    },
  },
}

const arm = vi.fn()
const disarm = vi.fn()

const baseCap = { arm, disarm }

const disarmedSlice = {
  state: 'disarmed' as const,
  availableModes: ['home', 'away'] as const,
  lastChangedAt: 1000,
}

/** A promise this test controls the settlement of. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  arm.mockReset()
  disarm.mockReset()
  mockResult = { cap: baseCap, slice: disarmedSlice, available: true }
})

describe('AlarmHeroCard — arm refusal (D630)', () => {
  it('surfaces the refusal message and rolls back the optimistic state', async () => {
    arm.mockRejectedValue(new Error('arm refused — open: Porch'))
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} optimistic={undefined} />)

    const stateGlyph = screen.getByTestId('alarm-state')
    expect(stateGlyph.getAttribute('data-state')).toBe('disarmed')

    fireEvent.click(screen.getByRole('button', { name: 'Away' }))

    // Optimistic: immediately shows "arming"
    expect(stateGlyph.getAttribute('data-state')).toBe('arming')
    expect(arm).toHaveBeenCalledWith({ mode: 'away' })

    // After the rejection settles: error surfaces, state rolls back to the slice
    await waitFor(() => {
      expect(screen.getByText('arm refused — open: Porch')).toBeTruthy()
    })
    expect(stateGlyph.getAttribute('data-state')).toBe('disarmed')
  })

  it('surfaces a disarm refusal the same way', async () => {
    mockResult = {
      cap: baseCap,
      slice: {
        state: 'armed_away' as const,
        availableModes: ['home', 'away'],
        lastChangedAt: 1000,
      },
      available: true,
    }
    disarm.mockRejectedValue(new Error('disarm refused — code required'))
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} optimistic={undefined} />)

    const stateGlyph = screen.getByTestId('alarm-state')
    fireEvent.click(screen.getByRole('button', { name: 'Disarm' }))
    expect(stateGlyph.getAttribute('data-state')).toBe('disarming')

    await waitFor(() => {
      expect(screen.getByText('disarm refused — code required')).toBeTruthy()
    })
    expect(stateGlyph.getAttribute('data-state')).toBe('armed_away')
  })

  it('clears a stale error once a new slice arrives from the server', async () => {
    arm.mockRejectedValue(new Error('arm refused — open: Porch'))
    const { rerender } = render(
      <AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} optimistic={undefined} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Away' }))
    await waitFor(() => {
      expect(screen.getByText('arm refused — open: Porch')).toBeTruthy()
    })

    // A fresh push from the server (new lastChangedAt) — the error should clear.
    await act(async () => {
      mockResult = {
        cap: baseCap,
        slice: {
          state: 'disarmed' as const,
          availableModes: ['home', 'away'],
          lastChangedAt: 2000,
        },
        available: true,
      }
      rerender(
        <AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} optimistic={undefined} />,
      )
    })

    expect(screen.queryByText('arm refused — open: Porch')).toBeNull()
  })

  it('does not render an error message before any refusal', () => {
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} optimistic={undefined} />)
    expect(screen.queryByTestId('alarm-error')).toBeNull()
  })

  it('a stale rejection does not roll back or error over a NEWER press', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    arm.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)

    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} optimistic={undefined} />)
    const stateGlyph = screen.getByTestId('alarm-state')

    // First press: Away — optimistic "arming", call #1 in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Away' }))
    expect(stateGlyph.getAttribute('data-state')).toBe('arming')
    expect(arm).toHaveBeenNthCalledWith(1, { mode: 'away' })

    // Second press, before #1 settles: Home — supersedes #1. Still "arming"
    // (same optimistic patch shape), but now call #2's business.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(stateGlyph.getAttribute('data-state')).toBe('arming')
    expect(arm).toHaveBeenNthCalledWith(2, { mode: 'home' })

    // Call #1 (stale) rejects. Must be a no-op: no rollback, no error.
    await act(async () => {
      first.reject(new Error('stale refusal — must be ignored'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stateGlyph.getAttribute('data-state')).toBe('arming')
    expect(screen.queryByTestId('alarm-error')).toBeNull()

    // Call #2 (latest) rejects. THIS one rolls back and surfaces.
    await act(async () => {
      second.reject(new Error('arm refused — open: Porch'))
    })
    await waitFor(() => {
      expect(screen.getByText('arm refused — open: Porch')).toBeTruthy()
    })
    expect(stateGlyph.getAttribute('data-state')).toBe('disarmed')
  })
})

describe('AlarmInlineControl — arm refusal (D630)', () => {
  it('surfaces a compact refusal badge that carries the message in its title', async () => {
    arm.mockRejectedValue(new Error('arm refused — open: Porch'))
    render(
      <AlarmInlineControl trpc={trpc} deviceId={1} features={undefined} optimistic={undefined} />,
    )

    expect(screen.queryByTestId('alarm-inline-error')).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: /alarm mode/i }), {
      target: { value: 'away' },
    })
    expect(arm).toHaveBeenCalledWith({ mode: 'away' })

    await waitFor(() => {
      expect(screen.getByTestId('alarm-inline-error')).toBeTruthy()
    })
    expect(screen.getByTestId('alarm-inline-error').getAttribute('title')).toBe(
      'arm refused — open: Porch',
    )
  })
})
