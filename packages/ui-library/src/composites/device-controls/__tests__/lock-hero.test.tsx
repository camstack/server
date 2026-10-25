// @vitest-environment jsdom
/**
 * Tests for LockHeroCard — padlock hero (padlock glyph + safety slide + lock-open gating).
 *
 * Strategy: mock `useDeviceCapability` so we control the cap/slice returned.
 * Asserts:
 *  (a) renders a padlock glyph reflecting state: locked / unlocked / jammed (red treatment on jammed)
 *  (b) renders a SlideToggle (query `data-testid="slide-thumb"`) — NOT a plain tap toggle
 *  (c) Open button rendered ONLY when device features include DeviceFeature.LockOpen; absent otherwise
 *  (d) returns null when the lock cap is absent (cap-gate)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeviceFeature } from '@camstack/types'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

import { LockHeroCard } from '../lock-hero-card'

const trpc = {} as never

const lock = vi.fn()
const unlock = vi.fn()
const open = vi.fn()

const baseCap = { lock, unlock, open }

const lockedSlice = { state: 'locked' as const, lastChangedAt: 0 }
const unlockedSlice = { state: 'unlocked' as const, lastChangedAt: 0 }
const jammedSlice = { state: 'jammed' as const, lastChangedAt: 0 }
const lockingSlice = { state: 'locking' as const, lastChangedAt: 0 }
const unlockingSlice = { state: 'unlocking' as const, lastChangedAt: 0 }

beforeEach(() => {
  lock.mockReset()
  unlock.mockReset()
  open.mockReset()
  mockResult = { cap: baseCap, slice: lockedSlice, available: true }
})

describe('LockHeroCard', () => {
  // ── (d) cap-gate: returns null when lock cap is absent ──────────────────────

  it('returns null when lock cap is undefined (device has no lockControl cap)', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  // ── (a) padlock glyph reflecting state ─────────────────────────────────────

  it('mounts without error when cap and slice are both present', () => {
    const { container } = render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).not.toBeNull()
  })

  it('renders a padlock glyph for locked state', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const glyph = screen.getByTestId('lock-glyph')
    expect(glyph).toBeTruthy()
  })

  it('renders a padlock glyph for unlocked state', () => {
    mockResult = { cap: baseCap, slice: unlockedSlice, available: true }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const glyph = screen.getByTestId('lock-glyph')
    expect(glyph).toBeTruthy()
  })

  it('applies a red/danger treatment on the padlock glyph when state is jammed', () => {
    mockResult = { cap: baseCap, slice: jammedSlice, available: false }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const glyph = screen.getByTestId('lock-glyph')
    // jammed must have a distinct visual: either aria-label "jammed" or a danger class
    const isJammed =
      glyph.getAttribute('data-state') === 'jammed' ||
      glyph.className.includes('text-danger') ||
      glyph.className.includes('text-destructive') ||
      glyph.className.includes('text-red')
    expect(isJammed).toBe(true)
  })

  it('exposes the current lock state as data-state attribute on the glyph container', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const glyph = screen.getByTestId('lock-glyph')
    expect(glyph.getAttribute('data-state')).toBe('locked')
  })

  it('exposes data-state="unlocked" when unlocked', () => {
    mockResult = { cap: baseCap, slice: unlockedSlice, available: true }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByTestId('lock-glyph').getAttribute('data-state')).toBe('unlocked')
  })

  it('applies a warning (non-danger) treatment on the padlock glyph when state is unlocking', () => {
    mockResult = { cap: baseCap, slice: unlockingSlice, available: true }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const glyph = screen.getByTestId('lock-glyph')
    expect(glyph.getAttribute('data-state')).toBe('unlocking')
    // unlocking must use warning (amber), not danger (red)
    expect(glyph.className).toContain('text-warning')
    expect(glyph.className).not.toContain('text-danger')
  })

  // ── (b) SlideToggle must be present (safety gesture, NOT a tap toggle) ───────

  it('renders a SlideToggle thumb (data-testid="slide-thumb") for locked state', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByTestId('slide-thumb')).toBeTruthy()
  })

  it('renders a SlideToggle thumb for unlocked state', () => {
    mockResult = { cap: baseCap, slice: unlockedSlice, available: true }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.getByTestId('slide-thumb')).toBeTruthy()
  })

  it('a plain tap on the slide thumb does NOT fire lock/unlock (safety gesture)', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    fireEvent.click(screen.getByTestId('slide-thumb'))
    expect(lock).not.toHaveBeenCalled()
    expect(unlock).not.toHaveBeenCalled()
  })

  it('calls cap.unlock after a slide gesture past threshold when locked', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const thumb = screen.getByTestId('slide-thumb')
    fireEvent.pointerDown(thumb, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(thumb, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(thumb, { clientX: 60, pointerId: 1 })
    expect(unlock).toHaveBeenCalledWith({})
    expect(lock).not.toHaveBeenCalled()
  })

  it('calls cap.lock after a slide gesture past threshold when unlocked', () => {
    mockResult = { cap: baseCap, slice: unlockedSlice, available: true }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const thumb = screen.getByTestId('slide-thumb')
    fireEvent.pointerDown(thumb, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(thumb, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(thumb, { clientX: 60, pointerId: 1 })
    expect(lock).toHaveBeenCalledWith({})
    expect(unlock).not.toHaveBeenCalled()
  })

  it('does NOT fire lock/unlock when jammed (busy state)', () => {
    mockResult = { cap: baseCap, slice: jammedSlice, available: false }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const thumb = screen.getByTestId('slide-thumb')
    fireEvent.pointerDown(thumb, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(thumb, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(thumb, { clientX: 60, pointerId: 1 })
    expect(lock).not.toHaveBeenCalled()
    expect(unlock).not.toHaveBeenCalled()
  })

  it('does NOT fire lock/unlock during locking transition (busy state)', () => {
    mockResult = { cap: baseCap, slice: lockingSlice, available: false }
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    const thumb = screen.getByTestId('slide-thumb')
    fireEvent.pointerDown(thumb, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(thumb, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(thumb, { clientX: 60, pointerId: 1 })
    expect(lock).not.toHaveBeenCalled()
    expect(unlock).not.toHaveBeenCalled()
  })

  // ── (c) Open (unlatch) button — gated on DeviceFeature.LockOpen ─────────────

  it('does NOT render the Open button when features is undefined', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull()
  })

  it('does NOT render the Open button when features array is empty', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull()
  })

  it('does NOT render the Open button when features contains only unrelated features', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.LockPinRequired]} />)
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull()
  })

  it('renders the Open button when features includes DeviceFeature.LockOpen', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} />)
    expect(screen.getByRole('button', { name: /open/i })).toBeTruthy()
  })

  it('renders the Open button alongside other features when LockOpen is included', () => {
    render(
      <LockHeroCard
        trpc={trpc}
        deviceId={1}
        features={[DeviceFeature.LockPinRequired, DeviceFeature.LockOpen]}
      />,
    )
    expect(screen.getByRole('button', { name: /open/i })).toBeTruthy()
  })

  it('calls cap.open when the Open button is clicked', () => {
    render(<LockHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.LockOpen]} />)
    fireEvent.click(screen.getByRole('button', { name: /open/i }))
    expect(open).toHaveBeenCalledWith({})
  })
})
