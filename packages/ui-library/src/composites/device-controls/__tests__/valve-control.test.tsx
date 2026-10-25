// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeviceFeature } from '@camstack/types'
import {
  ValveInlineControl,
  ValveHeroCard,
  valveStateMeta,
  valveGraphicTint,
} from '../valve-control'

const open = vi.fn()
const close = vi.fn()
const stop = vi.fn()
const setPosition = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

// Pass the slice straight through so display === slice (no optimistic override).
vi.mock('../../../hooks/use-optimistic-slice', () => ({
  useOptimisticSlice: (slice: unknown) => ({ display: slice, applyOptimistic: vi.fn() }),
}))

const trpc = {} as never

beforeEach(() => {
  open.mockReset()
  close.mockReset()
  stop.mockReset()
  setPosition.mockReset()
  mockResult = {
    cap: { open, close, stop, setPosition },
    slice: { state: 'open', position: 40, lastChangedAt: 0 },
    available: true,
  }
})

describe('valveStateMeta', () => {
  it('maps every state to a label (exhaustive)', () => {
    expect(valveStateMeta('open').label).toBe('Open')
    expect(valveStateMeta('opening').label).toBe('Opening')
    expect(valveStateMeta('closing').label).toBe('Closing')
    expect(valveStateMeta('closed').label).toBe('Closed')
    expect(valveStateMeta('stopped').label).toBe('Stopped')
    expect(valveStateMeta(undefined).label).toBe('Unknown')
  })
})

describe('valveGraphicTint', () => {
  it('returns a tint for every state (exhaustive)', () => {
    for (const s of ['open', 'opening', 'closing', 'closed', 'stopped', undefined] as const) {
      const tint = valveGraphicTint(s)
      expect(typeof tint.glow).toBe('string')
      expect(typeof tint.accent).toBe('string')
      expect(typeof tint.flowing).toBe('boolean')
      expect(typeof tint.active).toBe('boolean')
    }
  })

  it('flags flow for open/opening only', () => {
    expect(valveGraphicTint('open').flowing).toBe(true)
    expect(valveGraphicTint('opening').flowing).toBe(true)
    expect(valveGraphicTint('closed').flowing).toBe(false)
    expect(valveGraphicTint('stopped').flowing).toBe(false)
  })
})

describe('ValveInlineControl', () => {
  it('renders open/stop/close buttons + position badge', () => {
    render(<ValveInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Open')).toBeTruthy()
    expect(screen.getByLabelText('Stop')).toBeTruthy()
    expect(screen.getByLabelText('Close')).toBeTruthy()
    expect(screen.getByText('40%')).toBeTruthy()
  })

  it('wires buttons to cap methods', () => {
    render(<ValveInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Open'))
    fireEvent.click(screen.getByLabelText('Stop'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(open).toHaveBeenCalledWith({})
    expect(stop).toHaveBeenCalledWith({})
    expect(close).toHaveBeenCalledWith({})
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<ValveInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('hides the position badge when position is null', () => {
    mockResult = { ...mockResult, slice: { state: 'closed', position: null, lastChangedAt: 0 } }
    render(<ValveInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText(/%$/)).toBeNull()
  })
})

describe('ValveHeroCard', () => {
  it('renders the % open label + open/stop/close hero buttons when positionable', () => {
    render(<ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />)
    expect(screen.getByText('40')).toBeTruthy()
    expect(screen.getByLabelText('Open')).toBeTruthy()
    expect(screen.getByLabelText('Position')).toBeTruthy()
  })

  it('renders the drag-surface slider role when positionable + has position', () => {
    render(<ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />)
    // The bespoke graphic is a vertical drag surface with slider a11y.
    const dragSurface = screen.getByLabelText('Drag to set position')
    expect(dragSurface.getAttribute('role')).toBe('slider')
    expect(dragSurface.getAttribute('aria-valuenow')).toBe('40')
  })

  it('shows the capitalized state when position is null', () => {
    mockResult = { ...mockResult, slice: { state: 'closed', position: null, lastChangedAt: 0 } }
    render(<ValveHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('Closed')).toBeTruthy()
    expect(screen.queryByLabelText('Position')).toBeNull()
  })

  it('renders a read-only position range when reported but not settable', () => {
    render(<ValveHeroCard trpc={trpc} deviceId={1} features={[]} />)
    const range = screen.getByLabelText('Position') as HTMLInputElement
    expect(range.disabled).toBe(true)
  })

  it('calls setPosition on slider change when positionable', () => {
    render(<ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />)
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '75' } })
    expect(setPosition).toHaveBeenCalledWith({ position: 75 })
  })

  it('renders nothing when cap is undefined', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<ValveHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  // ── Interactive drag (ValvePositionable + numeric position) ──────────────────

  describe('interactive drag', () => {
    /** Stub getBoundingClientRect so pointer math is deterministic. */
    const stubRect = (el: HTMLElement, top: number, height: number): void => {
      el.getBoundingClientRect = () => ({
        top,
        height,
        left: 0,
        right: 0,
        bottom: top + height,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
      })
    }

    /** jsdom lacks pointer-capture helpers — stub them out. */
    const stubPointerCapture = (el: HTMLElement): void => {
      el.setPointerCapture = vi.fn()
      el.hasPointerCapture = vi.fn(() => true)
      el.releasePointerCapture = vi.fn()
    }

    it('graphic is interactive (role=slider, ns-resize) when positionable + has position', () => {
      render(
        <ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />,
      )
      const surface = screen.getByTestId('valve-graphic')
      expect(surface.getAttribute('role')).toBe('slider')
      expect(surface.getAttribute('aria-label')).toBe('Drag to set position')
      expect(surface.className).toContain('cursor-ns-resize')
    })

    it('pointer-down emits the position mapped from clientY (top=open, bottom=closed)', () => {
      render(
        <ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />,
      )
      const surface = screen.getByTestId('valve-graphic')
      stubRect(surface, 100, 200) // spans y=100..300, 200px tall
      stubPointerCapture(surface)

      // Drag DOWN to y=250 → ratio=(250-100)/200=0.75 → position = round(100-75) = 25.
      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 250 })
      expect(setPosition).toHaveBeenCalledWith({ position: 25 })

      // Move UP to y=150 → ratio=0.25 → position = 75 (UP = more open).
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 150 })
      expect(setPosition).toHaveBeenCalledWith({ position: 75 })

      fireEvent.pointerUp(surface, { pointerId: 1, clientY: 150 })
    })

    it('pointer-move clamps clientY → 0..100 at both ends', () => {
      render(
        <ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />,
      )
      const surface = screen.getByTestId('valve-graphic')
      stubRect(surface, 100, 200)
      stubPointerCapture(surface)

      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 200 }) // mid → 50
      // Clamp: drag above the top → 100.
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 50 })
      expect(setPosition).toHaveBeenCalledWith({ position: 100 })
      // Clamp: drag below the bottom → 0.
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 400 })
      expect(setPosition).toHaveBeenCalledWith({ position: 0 })

      fireEvent.pointerUp(surface, { pointerId: 1, clientY: 400 })
    })

    it('does not emit again when the rounded % is unchanged (lastEmittedRef dedupe)', () => {
      render(
        <ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />,
      )
      const surface = screen.getByTestId('valve-graphic')
      stubRect(surface, 0, 100)
      stubPointerCapture(surface)

      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 50 }) // → 50
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 50.3 }) // still rounds to 50
      expect(setPosition).toHaveBeenCalledTimes(1)
    })

    it('pointer-cancel ends the drag (subsequent moves do not emit)', () => {
      render(
        <ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />,
      )
      const surface = screen.getByTestId('valve-graphic')
      stubRect(surface, 0, 100)
      stubPointerCapture(surface)

      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 50 }) // → 50
      fireEvent.pointerCancel(surface, { pointerId: 1, clientY: 50 })
      setPosition.mockClear()
      // After cancel, dragging has ended → a bare move must not emit.
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 10 })
      expect(setPosition).not.toHaveBeenCalled()
    })

    it('non-positionable valve renders NO interactive handlers (display-only)', () => {
      // position known but no ValvePositionable feature.
      render(<ValveHeroCard trpc={trpc} deviceId={1} features={[]} />)
      const surface = screen.getByTestId('valve-graphic')
      expect(surface.getAttribute('role')).toBeNull()
      expect(surface.getAttribute('aria-hidden')).toBe('true')
      expect(surface.className).not.toContain('cursor-ns-resize')

      stubRect(surface, 0, 100)
      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 50 })
      expect(setPosition).not.toHaveBeenCalled()
    })
  })

  // ── Positionable but no position pushed yet (MINOR-1 gating) ──────────────────

  describe('positionable with null position', () => {
    beforeEach(() => {
      mockResult = {
        cap: { open, close, stop, setPosition },
        slice: { state: 'open', position: null, lastChangedAt: 0 },
        available: true,
      }
    })

    it('renders the editable slider yet keeps the graphic display-only (not draggable)', () => {
      render(
        <ValveHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.ValvePositionable]} />,
      )

      // Slider is shown immediately (gated on `positionable` alone) and editable.
      const range = screen.getByLabelText('Position') as HTMLInputElement
      expect(range.disabled).toBe(false)

      // Drag surface is NOT interactive: dragging needs a numeric position.
      const surface = screen.getByTestId('valve-graphic')
      expect(surface.getAttribute('role')).toBeNull()
      expect(surface.getAttribute('aria-hidden')).toBe('true')
      surface.getBoundingClientRect = () => ({
        top: 0,
        height: 100,
        left: 0,
        right: 0,
        bottom: 100,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 50 })
      expect(setPosition).not.toHaveBeenCalled()
    })
  })
})
