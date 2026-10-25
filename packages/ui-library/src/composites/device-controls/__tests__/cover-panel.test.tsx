import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CoverPanel } from '../cover-panel'

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
    slice: { state: 'closed', position: 0, tiltPosition: null, lastChangedAt: 0 },
    available: true,
  }
})

describe('CoverPanel', () => {
  it('renders open/close/stop and wires them to the cap', () => {
    render(<CoverPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    fireEvent.click(screen.getByLabelText('Open'))
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.click(screen.getByLabelText('Stop'))
    expect(open).toHaveBeenCalledWith({})
    expect(close).toHaveBeenCalledWith({})
    expect(stop).toHaveBeenCalledWith({})
  })

  it('shows the position slider only when cover-positionable', () => {
    const { rerender } = render(<CoverPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    expect(screen.queryByLabelText('Position')).toBeNull()
    rerender(
      <CoverPanel trpc={trpc} deviceId={1} features={['cover-positionable']} layout="full" />,
    )
    expect(screen.getByLabelText('Position')).toBeTruthy()
  })

  it('renders nothing when the cap slice has not landed (unbound)', () => {
    mockResult = { cap: { open, close, stop, setPosition }, slice: undefined, available: false }
    const { container } = render(
      <CoverPanel trpc={trpc} deviceId={1} features={[]} layout="full" />,
    )
    expect(container.firstChild).toBeNull()
  })
})
