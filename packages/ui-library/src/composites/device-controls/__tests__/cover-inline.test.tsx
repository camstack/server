// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CoverInlineControl } from '../cover-inline'

const open = vi.fn()
const close = vi.fn()
const stop = vi.fn()
const setPosition = vi.fn()

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
  mockResult = {
    cap: { open, close, stop, setPosition },
    slice: { state: 'opening', position: 42, tiltPosition: null, lastChangedAt: 0 },
    available: true,
  }
})

describe('CoverInlineControl', () => {
  it('renders open/stop/close buttons', () => {
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Open')).toBeTruthy()
    expect(screen.getByLabelText('Stop')).toBeTruthy()
    expect(screen.getByLabelText('Close')).toBeTruthy()
  })

  it('wires buttons to cap methods', () => {
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(screen.getByLabelText('Open'))
    fireEvent.click(screen.getByLabelText('Stop'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(open).toHaveBeenCalledWith({})
    expect(stop).toHaveBeenCalledWith({})
    expect(close).toHaveBeenCalledWith({})
  })

  it('shows "42%" when state is opening and position is 42', () => {
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByText('42%')).toBeTruthy()
  })

  // Fix A: real design-token class assertions — the control now uses
  // bg-primary text-primary-foreground for accent and bg-primary/15 text-primary
  // for filled.  Tests assert the real class strings.
  it('up button has bg-primary class (accent) when state is opening', () => {
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    const upBtn = screen.getByLabelText('Open')
    expect(upBtn.className).toContain('bg-primary')
    expect(upBtn.className).toContain('text-primary-foreground')
  })

  it('down button has bg-primary class (accent) when state is closing', () => {
    mockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'closing', position: 60, tiltPosition: null, lastChangedAt: 0 },
      available: true,
    }
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    const downBtn = screen.getByLabelText('Close')
    expect(downBtn.className).toContain('bg-primary')
    expect(downBtn.className).toContain('text-primary-foreground')
  })

  it('up button has bg-primary/15 class (filled) when state is open', () => {
    mockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'open', position: 100, tiltPosition: null, lastChangedAt: 0 },
      available: true,
    }
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    const upBtn = screen.getByLabelText('Open')
    // bg-primary/15 is the filled token — subtler active state
    expect(upBtn.className).toContain('bg-primary/15')
    expect(upBtn.className).toContain('text-primary')
  })

  it('down button has bg-primary/15 class (filled) when state is closed', () => {
    mockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'closed', position: 0, tiltPosition: null, lastChangedAt: 0 },
      available: true,
    }
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    const downBtn = screen.getByLabelText('Close')
    expect(downBtn.className).toContain('bg-primary/15')
    expect(downBtn.className).toContain('text-primary')
  })

  it('does not show % when position is null', () => {
    mockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'closed', position: null, tiltPosition: null, lastChangedAt: 0 },
      available: true,
    }
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.queryByText(/%$/)).toBeNull()
  })

  // Fix A (disappear bug): when slice is undefined but cap IS present, buttons
  // must still render — the control must NOT vanish during a transient refetch.
  it('still renders 3 buttons when slice is undefined but cap is present (no disappear)', () => {
    mockResult = { cap: { open, close, stop, setPosition }, slice: undefined, available: false }
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByLabelText('Open')).toBeTruthy()
    expect(screen.getByLabelText('Stop')).toBeTruthy()
    expect(screen.getByLabelText('Close')).toBeTruthy()
  })

  // When cap is truly undefined (device has no cover cap) the control renders nothing.
  it('renders nothing when cap is undefined (device has no cover cap)', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('disables buttons when not available', () => {
    mockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'opening', position: 42, tiltPosition: null, lastChangedAt: 0 },
      available: false,
    }
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    const upBtn = screen.getByLabelText('Open') as HTMLButtonElement
    expect(upBtn.disabled).toBe(true)
  })

  // Buttons remain on screen even when busy (available=false) and active state
  // highlight is still applied — they must not disappear during an in-flight operation.
  it('active highlight persists on Open button even when busy (available=false)', () => {
    mockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'opening', position: 30, tiltPosition: null, lastChangedAt: 0 },
      available: false,
    }
    render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    const upBtn = screen.getByLabelText('Open') as HTMLButtonElement
    // Button is disabled (busy) but still rendered and still carries the accent class
    expect(upBtn.disabled).toBe(true)
    expect(upBtn.className).toContain('bg-primary')
  })
})
