import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BrightnessPanel } from '../brightness-panel'
const setBrightness = vi.fn()
let mockResult: { cap: unknown; slice: unknown; available: boolean }
vi.mock('../../../hooks/use-device-capability', () => ({ useDeviceCapability: () => mockResult }))
const trpc = {} as never
beforeEach(() => {
  setBrightness.mockReset()
  mockResult = {
    cap: { setBrightness },
    slice: { level: 40, lastChangedAt: 0 },
    available: true,
  }
})
describe('BrightnessPanel', () => {
  it('renders a slider reflecting percentage and writes setBrightness on release', () => {
    render(<BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    expect(slider.value).toBe('40')
    fireEvent.change(slider, { target: { value: '75' } })
    expect(setBrightness).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider)
    expect(setBrightness).toHaveBeenCalledTimes(1)
    expect(setBrightness).toHaveBeenCalledWith({ level: 75 })
  })
  it('keeps the thumb under the hand while dragging and until the hub answers (no snap back)', () => {
    const { rerender } = render(
      <BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />,
    )
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '60' } })
    // A served update mid-drag (a poll still at the old level) does not pull the thumb back.
    mockResult = { ...mockResult, slice: { level: 41, lastChangedAt: 1 } }
    rerender(<BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    expect(slider.value).toBe('60')
    expect(screen.getByText('60%')).toBeTruthy()
    fireEvent.pointerUp(slider)
    expect(slider.value).toBe('60')
    // The hub serves the held value: the served slice takes over from there.
    mockResult = { ...mockResult, slice: { level: 60, lastChangedAt: 2 } }
    rerender(<BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    mockResult = { ...mockResult, slice: { level: 20, lastChangedAt: 3 } }
    rerender(<BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    expect(slider.value).toBe('20')
    expect(setBrightness).toHaveBeenCalledTimes(1)
  })
  it('renders nothing when unbound', () => {
    mockResult = { cap: { setBrightness }, slice: undefined, available: false }
    const { container } = render(
      <BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />,
    )
    expect(container.firstChild).toBeNull()
  })
})
