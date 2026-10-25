// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CoverHeroCard } from '../cover-hero-card'
import { DeviceFeature } from '@camstack/types'

const open = vi.fn()
const close = vi.fn()
const stop = vi.fn()
const setPosition = vi.fn()
const setTiltPosition = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

beforeEach(() => {
  open.mockReset()
  close.mockReset()
  stop.mockReset()
  setPosition.mockReset()
  setTiltPosition.mockReset()
  mockResult = {
    cap: { open, close, stop, setPosition, setTiltPosition },
    slice: { state: 'open', position: 75, tiltPosition: null, lastChangedAt: 0 },
    available: true,
  }
})

describe('CoverHeroCard', () => {
  it('renders Open/Stop/Close buttons', () => {
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Open')).toBeTruthy()
    expect(screen.getByLabelText('Stop')).toBeTruthy()
    expect(screen.getByLabelText('Close')).toBeTruthy()
  })

  it('renders the % open label', () => {
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('75')).toBeTruthy()
    expect(screen.getByText('%')).toBeTruthy()
  })

  it('renders the cover state text (no %) when position is null (no positioning support)', () => {
    mockResult = {
      cap: { open, close, stop, setPosition, setTiltPosition },
      slice: { state: 'open', position: null, tiltPosition: null, lastChangedAt: 0 },
      available: true,
    }
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('open')).toBeTruthy()
    // Spec: open/close-only covers must NOT show a % unit anywhere.
    expect(screen.queryByText('%')).toBeNull()
  })

  it('renders "—" fallback when position is null and state is unknown', () => {
    mockResult = {
      cap: { open, close, stop, setPosition, setTiltPosition },
      slice: undefined,
      available: false,
    }
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('renders an interactive position range input when CoverPositionable', () => {
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.CoverPositionable]} />)
    const posInput = screen.getByLabelText('Position') as HTMLInputElement
    expect(posInput).toBeTruthy()
    expect(posInput.disabled).toBe(false)
  })

  it('position range input is absent when CoverPositionable not in features', () => {
    // No CoverPositionable → no interactive range (position null to avoid read-only fallback)
    mockResult = {
      cap: { open, close, stop, setPosition, setTiltPosition },
      slice: { state: 'open', position: null, tiltPosition: null, lastChangedAt: 0 },
      available: true,
    }
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByLabelText('Position')).toBeNull()
  })

  it('position range is read-only (disabled) when CoverPositionable absent but position known', () => {
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    const posInput = screen.getByLabelText('Position') as HTMLInputElement
    expect(posInput.disabled).toBe(true)
  })

  it('renders tilt slider only when CoverTilt feature present', () => {
    const { rerender } = render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByLabelText('Tilt position')).toBeNull()
    rerender(<CoverHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.CoverTilt]} />)
    expect(screen.getByLabelText('Tilt position')).toBeTruthy()
  })

  it('renders nothing when cap is undefined (no cover on device)', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('still renders buttons when slice is undefined (transient refetch, cap present)', () => {
    mockResult = {
      cap: { open, close, stop, setPosition, setTiltPosition },
      slice: undefined,
      available: false,
    }
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Open')).toBeTruthy()
    expect(screen.getByLabelText('Stop')).toBeTruthy()
    expect(screen.getByLabelText('Close')).toBeTruthy()
  })

  it('Open button carries bg-primary class (accent) when state is opening', () => {
    mockResult = {
      cap: { open, close, stop, setPosition, setTiltPosition },
      slice: { state: 'opening', position: 30, tiltPosition: null, lastChangedAt: 0 },
      available: true,
    }
    render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
    const upBtn = screen.getByLabelText('Open')
    expect(upBtn.className).toContain('bg-primary')
    expect(upBtn.className).toContain('text-primary-foreground')
  })

  // ── Variant A: cover with position % ────────────────────────────────────────

  describe('with-position variant (position !== null)', () => {
    it('renders the window graphic (data-testid="cover-window")', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByTestId('cover-window')).toBeTruthy()
    })

    it('renders the lever element (data-testid="cover-lever") when position is known', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByTestId('cover-lever')).toBeTruthy()
    })

    it('renders the % value label alongside the lever', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      // position is 75; the % badge should be present
      expect(screen.getByTestId('cover-position-pct')).toBeTruthy()
      expect(screen.getByTestId('cover-position-pct').textContent).toContain('75')
    })

    it('lever is positioned at the open/closed boundary (exact slat math)', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      const lever = screen.getByTestId('cover-lever')
      // position=75 → slatPct = (100 - 75) = 25 → lever top = calc(25% - 8px)
      expect((lever as HTMLElement).style.top).toBe('calc(25% - 8px)')
    })
  })

  // ── Interactive drag (CoverPositionable) ─────────────────────────────────────

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

    it('window is interactive (role=slider, ns-resize) when CoverPositionable', () => {
      render(
        <CoverHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.CoverPositionable]} />,
      )
      const win = screen.getByTestId('cover-window')
      expect(win.getAttribute('role')).toBe('slider')
      expect(win.getAttribute('aria-label')).toBe('Drag to set position')
      expect(win.className).toContain('cursor-ns-resize')
    })

    it('a pointer-drag on the window calls setPosition with the mapped %', () => {
      render(
        <CoverHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.CoverPositionable]} />,
      )
      const win = screen.getByTestId('cover-window')
      stubRect(win, 100, 200) // window spans y=100..300, 200px tall
      // jsdom lacks pointer-capture helpers — stub them out.
      win.setPointerCapture = vi.fn()
      win.hasPointerCapture = vi.fn(() => true)
      win.releasePointerCapture = vi.fn()

      // Drag DOWN to y=250 → ratio=(250-100)/200=0.75 → position = round(100-75) = 25.
      fireEvent.pointerDown(win, { pointerId: 1, clientY: 250 })
      expect(setPosition).toHaveBeenCalledWith({ position: 25 })

      // Move UP to y=150 → ratio=0.25 → position = 75.
      fireEvent.pointerMove(win, { pointerId: 1, clientY: 150 })
      expect(setPosition).toHaveBeenCalledWith({ position: 75 })

      // Clamp: drag above the top → 100.
      fireEvent.pointerMove(win, { pointerId: 1, clientY: 50 })
      expect(setPosition).toHaveBeenCalledWith({ position: 100 })

      // Clamp: drag below the bottom → 0.
      fireEvent.pointerMove(win, { pointerId: 1, clientY: 400 })
      expect(setPosition).toHaveBeenCalledWith({ position: 0 })

      fireEvent.pointerUp(win, { pointerId: 1, clientY: 400 })
    })

    it('does not emit again when the rounded % is unchanged', () => {
      render(
        <CoverHeroCard trpc={trpc} deviceId={1} features={[DeviceFeature.CoverPositionable]} />,
      )
      const win = screen.getByTestId('cover-window')
      stubRect(win, 0, 100)
      win.setPointerCapture = vi.fn()
      win.hasPointerCapture = vi.fn(() => true)
      win.releasePointerCapture = vi.fn()

      fireEvent.pointerDown(win, { pointerId: 1, clientY: 50 }) // → 50
      fireEvent.pointerMove(win, { pointerId: 1, clientY: 50.3 }) // still rounds to 50
      expect(setPosition).toHaveBeenCalledTimes(1)
    })

    it('non-positionable cover renders NO interactive handlers (display-only)', () => {
      // position known but no CoverPositionable feature.
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      const win = screen.getByTestId('cover-window')
      expect(win.getAttribute('role')).toBeNull()
      expect(win.getAttribute('aria-hidden')).toBe('true')
      expect(win.className).not.toContain('cursor-ns-resize')

      stubRect(win, 0, 100)
      fireEvent.pointerDown(win, { pointerId: 1, clientY: 50 })
      expect(setPosition).not.toHaveBeenCalled()
    })
  })

  // ── Variant B: open/close-only (position === null) ───────────────────────────

  describe('without-position variant (position === null)', () => {
    beforeEach(() => {
      mockResult = {
        cap: { open, close, stop, setPosition, setTiltPosition },
        slice: { state: 'open', position: null, tiltPosition: null, lastChangedAt: 0 },
        available: true,
      }
    })

    it('renders the window graphic (data-testid="cover-window")', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByTestId('cover-window')).toBeTruthy()
    })

    it('does NOT render the lever (data-testid="cover-lever") when position is null', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.queryByTestId('cover-lever')).toBeNull()
    })

    it('does NOT render the % position badge when position is null', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.queryByTestId('cover-position-pct')).toBeNull()
    })

    it('still renders the Open/Stop/Close triad when position is null', () => {
      render(<CoverHeroCard trpc={trpc} deviceId={1} features={[]} />)
      expect(screen.getByLabelText('Open')).toBeTruthy()
      expect(screen.getByLabelText('Stop')).toBeTruthy()
      expect(screen.getByLabelText('Close')).toBeTruthy()
    })
  })
})
