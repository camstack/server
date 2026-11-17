// @vitest-environment jsdom
/**
 * Tests for AlarmHeroCard / AlarmInlineControl — a rejected cap.arm()/
 * cap.disarm() must surface as a visible refusal, not a swallowed promise
 * (D630/Task 3), on BOTH surfaces, and a stale rejection must never put an
 * error over a newer press. The card shows the served slice only (D1061).
 *
 * Strategy: mock `useDeviceCapability` so we control the cap/slice returned.
 */
import { selectOption } from '../../../testing/select-option'
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
  it('surfaces the refusal message and keeps showing the served state', async () => {
    arm.mockRejectedValue(new Error('arm refused — open: Porch'))
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)

    const stateGlyph = screen.getByTestId('alarm-state')
    expect(stateGlyph.getAttribute('data-state')).toBe('disarmed')

    fireEvent.click(screen.getByRole('button', { name: 'Away' }))

    // The served slice decides the state (D1061): no client-side "arming".
    expect(stateGlyph.getAttribute('data-state')).toBe('disarmed')
    expect(arm).toHaveBeenCalledWith({ mode: 'away' })

    // After the rejection settles: the error surfaces over the same slice
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
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)

    const stateGlyph = screen.getByTestId('alarm-state')
    fireEvent.click(screen.getByRole('button', { name: 'Disarm' }))
    expect(stateGlyph.getAttribute('data-state')).toBe('armed_away')

    await waitFor(() => {
      expect(screen.getByText('disarm refused — code required')).toBeTruthy()
    })
    expect(stateGlyph.getAttribute('data-state')).toBe('armed_away')
  })

  it('clears a stale error once a new slice arrives from the server', async () => {
    arm.mockRejectedValue(new Error('arm refused — open: Porch'))
    const { rerender } = render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)

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
      rerender(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    })

    expect(screen.queryByText('arm refused — open: Porch')).toBeNull()
  })

  it('does not render an error message before any refusal', () => {
    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByTestId('alarm-error')).toBeNull()
  })

  it('a stale rejection does not put an error over a NEWER press', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    arm.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)

    render(<AlarmHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const stateGlyph = screen.getByTestId('alarm-state')

    // First press: Away — call #1 in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Away' }))
    expect(arm).toHaveBeenNthCalledWith(1, { mode: 'away' })

    // Second press, before #1 settles: Home — supersedes #1.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(arm).toHaveBeenNthCalledWith(2, { mode: 'home' })

    // Call #1 (stale) rejects. Must be a no-op: no error.
    await act(async () => {
      first.reject(new Error('stale refusal — must be ignored'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stateGlyph.getAttribute('data-state')).toBe('disarmed')
    expect(screen.queryByTestId('alarm-error')).toBeNull()

    // Call #2 (latest) rejects. THIS one surfaces.
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
    render(<AlarmInlineControl trpc={trpc} deviceId={1} features={undefined} />)

    expect(screen.queryByTestId('alarm-inline-error')).toBeNull()

    selectOption(screen.getByRole('combobox', { name: /alarm mode/i }), 'away')
    expect(arm).toHaveBeenCalledWith({ mode: 'away' })

    await waitFor(() => {
      expect(screen.getByTestId('alarm-inline-error')).toBeTruthy()
    })
    expect(screen.getByTestId('alarm-inline-error').getAttribute('title')).toBe(
      'arm refused — open: Porch',
    )
  })
})
