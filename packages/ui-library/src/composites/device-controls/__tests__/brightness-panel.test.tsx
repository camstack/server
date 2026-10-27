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
  it('renders a slider reflecting percentage and writes setBrightness', () => {
    render(<BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    expect(slider.value).toBe('40')
    fireEvent.change(slider, { target: { value: '75' } })
    expect(setBrightness).toHaveBeenCalledWith({ level: 75 })
  })
  it('renders nothing when unbound', () => {
    mockResult = { cap: { setBrightness }, slice: undefined, available: false }
    const { container } = render(
      <BrightnessPanel trpc={trpc} deviceId={1} features={undefined} layout="full" />,
    )
    expect(container.firstChild).toBeNull()
  })
})
