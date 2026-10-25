import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FanPanel } from '../fan-panel'
const setPercentage = vi.fn()
const setPreset = vi.fn()
let mockResult: { cap: unknown; slice: unknown; available: boolean }
vi.mock('../../../hooks/use-device-capability', () => ({ useDeviceCapability: () => mockResult }))
const trpc = {} as never
beforeEach(() => {
  setPercentage.mockReset()
  setPreset.mockReset()
  mockResult = {
    cap: { setPercentage, setPreset },
    slice: {
      percentage: 50,
      preset: '',
      availablePresets: ['auto', 'turbo'],
      direction: null,
      oscillating: null,
      lastChangedAt: 0,
    },
    available: true,
  }
})
describe('FanPanel', () => {
  it('shows the speed slider only with fan-speed feature and writes setPercentage', () => {
    const { rerender } = render(<FanPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
    expect(screen.queryByLabelText('Fan speed')).toBeNull()
    rerender(<FanPanel trpc={trpc} deviceId={1} features={['fan-speed']} layout="full" />)
    const slider = screen.getByLabelText('Fan speed') as HTMLInputElement
    expect(slider.value).toBe('50')
    fireEvent.change(slider, { target: { value: '80' } })
    expect(setPercentage).toHaveBeenCalledWith({ percentage: 80 })
  })
  it('shows preset picker only with fan-preset feature', () => {
    render(<FanPanel trpc={trpc} deviceId={1} features={['fan-preset']} layout="full" />)
    fireEvent.change(screen.getByLabelText('Fan preset'), { target: { value: 'turbo' } })
    expect(setPreset).toHaveBeenCalledWith({ preset: 'turbo' })
  })
  it('renders nothing when unbound', () => {
    mockResult = { cap: { setPercentage, setPreset }, slice: undefined, available: false }
    const { container } = render(
      <FanPanel trpc={trpc} deviceId={1} features={['fan-speed']} layout="full" />,
    )
    expect(container.firstChild).toBeNull()
  })
  it('does not render "Fan speed" or "Preset" text labels', () => {
    render(
      <FanPanel trpc={trpc} deviceId={1} features={['fan-speed', 'fan-preset']} layout="full" />,
    )
    expect(screen.queryByText('Fan speed')).toBeNull()
    expect(screen.queryByText('Preset')).toBeNull()
  })
  it('still renders the speed slider and preset select after label removal', () => {
    render(
      <FanPanel trpc={trpc} deviceId={1} features={['fan-speed', 'fan-preset']} layout="full" />,
    )
    expect(screen.getByLabelText('Fan speed')).toBeTruthy()
    expect(screen.getByLabelText('Fan preset')).toBeTruthy()
  })
  it('uses percentageStep on the range input when provided', () => {
    mockResult = {
      cap: { setPercentage, setPreset },
      slice: {
        percentage: 50,
        preset: '',
        availablePresets: ['auto', 'turbo'],
        direction: null,
        oscillating: null,
        lastChangedAt: 0,
        percentageStep: 25,
      },
      available: true,
    }
    render(<FanPanel trpc={trpc} deviceId={1} features={['fan-speed']} layout="full" />)
    const slider = screen.getByLabelText('Fan speed') as HTMLInputElement
    expect(slider.step).toBe('25')
  })
  it('snaps raw value to nearest step before calling setPercentage', () => {
    mockResult = {
      cap: { setPercentage, setPreset },
      slice: {
        percentage: 50,
        preset: '',
        availablePresets: [],
        direction: null,
        oscillating: null,
        lastChangedAt: 0,
        percentageStep: 25,
      },
      available: true,
    }
    render(<FanPanel trpc={trpc} deviceId={1} features={['fan-speed']} layout="full" />)
    const slider = screen.getByLabelText('Fan speed') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '60' } })
    // Math.round(60 / 25) * 25 = Math.round(2.4) * 25 = 2 * 25 = 50
    expect(setPercentage).toHaveBeenCalledWith({ percentage: 50 })
  })
  it('falls back to step=1 when percentageStep is absent', () => {
    render(<FanPanel trpc={trpc} deviceId={1} features={['fan-speed']} layout="full" />)
    const slider = screen.getByLabelText('Fan speed') as HTMLInputElement
    expect(slider.step).toBe('1')
  })
})
