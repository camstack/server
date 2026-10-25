// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ClimatePanel } from '../climate-panel'

const setMode = vi.fn()
const setTarget = vi.fn()
const setFanMode = vi.fn()
const setPreset = vi.fn()
const setTargetHumidity = vi.fn()
const setTargetRange = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

const baseSlice = {
  mode: 'heat' as const,
  availableModes: ['off', 'heat', 'cool', 'auto'] as const,
  fanMode: '',
  availableFanModes: [] as string[],
  preset: '',
  availablePresets: [] as string[],
  target: 5,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: 24.6,
  currentHumidity: null,
  lastFetchedAt: 0,
}

beforeEach(() => {
  setMode.mockReset()
  setTarget.mockReset()
  setFanMode.mockReset()
  setPreset.mockReset()
  setTargetHumidity.mockReset()
  setTargetRange.mockReset()
  mockResult = {
    cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
    slice: { ...baseSlice },
    available: true,
  }
})

describe('ClimatePanel', () => {
  describe('compact layout', () => {
    it('renders the target temperature prominently', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      // target is shown as "5°" — it is rendered as text node adjacent to (24.6°)
      expect(screen.getByText(/^5°/)).toBeTruthy()
    })

    it('renders the current temperature in parentheses after the target', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      expect(screen.getByText('(24.6°)')).toBeTruthy()
    })

    it('renders only current temp when target is null', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, target: null },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      expect(screen.getByText('24.6°')).toBeTruthy()
    })

    it('renders a mode select with all available modes as options', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement
      expect(select).toBeTruthy()
      const options = Array.from(select.options).map((o) => o.value)
      expect(options).toEqual(['off', 'heat', 'cool', 'auto'])
    })

    it('reflects the active mode as the selected value', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement
      expect(select.value).toBe('heat')
    })

    it('does NOT render Previous/Next mode arrow buttons', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      expect(screen.queryByRole('button', { name: 'Previous mode' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Next mode' })).toBeNull()
    })

    it('calls setMode when the mode select changes', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), {
        target: { value: 'cool' },
      })
      expect(setMode).toHaveBeenCalledWith({ mode: 'cool' })
    })

    it('puts data-mode on the root element reflecting the active mode', () => {
      const { container } = render(
        <ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      const root = container.firstChild as HTMLElement
      expect(root.dataset['mode']).toBe('heat')
    })

    it('uses a borderless minimal wrapper (no bordered-box classes)', () => {
      const { container } = render(
        <ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      const root = container.firstChild as HTMLElement
      // matches the cover-inline minimal style
      expect(root.className).toContain('inline-flex')
      expect(root.className).toContain('items-center')
      expect(root.className).toContain('gap-1')
      // NO bordered-box wrapper classes
      expect(root.className).not.toContain('rounded border')
      expect(root.className).not.toContain('px-2 py-1')
      // NO mode-colored filled/bordered box on the wrapper
      expect(root.className).not.toContain('bg-amber')
      expect(root.className).not.toContain('border-amber')
    })

    it('applies the heat mode color as a TEXT accent (not a box) when mode is heat', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      // mode cue is a text accent on the temperature value
      const temp = screen.getByText(/^5°/)
      expect(temp.className).toContain('amber')
      expect(temp.className).not.toContain('bg-amber')
      expect(temp.className).not.toContain('border')
    })

    it('renders the −/+ stepper buttons at h-5 w-5 to match the cover inline', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const dec = screen.getByRole('button', { name: 'Decrease target' }) as HTMLButtonElement
      const inc = screen.getByRole('button', { name: 'Increase target' }) as HTMLButtonElement
      expect(dec.className).toContain('h-5')
      expect(dec.className).toContain('w-5')
      expect(inc.className).toContain('h-5')
      expect(inc.className).toContain('w-5')
      // borderless, hover-only bg (cover language)
      expect(dec.className).not.toContain('border')
      expect(dec.className).toContain('hover:bg-surface-hover')
    })

    it('renders a borderless minimal mode select (no bordered field classes)', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement
      expect(select.className).not.toContain('border border-border')
      expect(select.className).not.toContain('bg-surface')
      expect(select.className).toContain('bg-transparent')
    })

    it('calls setTarget when the increment button is clicked', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increase target' }))
      expect(setTarget).toHaveBeenCalledWith({ target: 6 })
    })

    it('steps by tempStep when set (0.5 °C)', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, target: 20, tempStep: 0.5 },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increase target' }))
      expect(setTarget).toHaveBeenCalledWith({ target: 20.5 })
    })

    it('steps by 1 when tempStep is absent', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, target: 20 },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increase target' }))
      expect(setTarget).toHaveBeenCalledWith({ target: 21 })
    })

    it('calls setTarget when the decrement button is clicked', () => {
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Decrease target' }))
      expect(setTarget).toHaveBeenCalledWith({ target: 4 })
    })

    it('renders nothing when cap is undefined (unbound)', () => {
      mockResult = { cap: undefined, slice: undefined, available: false }
      const { container } = render(
        <ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      expect(container.firstChild).toBeNull()
    })

    it('disables stepper controls when not available', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice },
        available: false,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const decBtn = screen.getByRole('button', { name: 'Decrease target' }) as HTMLButtonElement
      expect(decBtn.disabled).toBe(true)
      const incBtn = screen.getByRole('button', { name: 'Increase target' }) as HTMLButtonElement
      expect(incBtn.disabled).toBe(true)
    })

    it('disables mode select when not available', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice },
        available: false,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement
      expect(select.disabled).toBe(true)
    })

    it('applies the cool mode color as a TEXT accent when mode is cool', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, mode: 'cool' as const },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const temp = screen.getByText(/^5°/)
      expect(temp.className).toContain('blue')
      expect(temp.className).not.toContain('bg-blue')
    })
  })

  describe('full layout', () => {
    it('renders a fan mode selector when availableFanModes are present', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, availableFanModes: ['auto', 'low', 'high'], fanMode: 'auto' },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByLabelText('Fan mode')).toBeTruthy()
    })

    it('calls setFanMode when fan mode selector changes', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, availableFanModes: ['auto', 'low', 'high'], fanMode: 'auto' },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.change(screen.getByLabelText('Fan mode'), { target: { value: 'low' } })
      expect(setFanMode).toHaveBeenCalledWith({ fanMode: 'low' })
    })

    it('renders a preset selector when availablePresets are present', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, availablePresets: ['eco', 'away'], preset: 'eco' },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByLabelText('Preset')).toBeTruthy()
    })

    it('calls setPreset when preset selector changes', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, availablePresets: ['eco', 'away'], preset: 'eco' },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'away' } })
      expect(setPreset).toHaveBeenCalledWith({ preset: 'away' })
    })

    it('renders humidity setpoint when targetHumidity is non-null', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, targetHumidity: 50 },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByLabelText('Target humidity')).toBeTruthy()
    })

    it('calls setTargetHumidity when the humidity input changes', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: { ...baseSlice, targetHumidity: 50 },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.change(screen.getByLabelText('Target humidity'), { target: { value: '60' } })
      expect(setTargetHumidity).toHaveBeenCalledWith({ targetHumidity: 60 })
    })

    it('renders dual setpoint when mode is heat_cool', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: {
          ...baseSlice,
          mode: 'heat_cool' as const,
          target: null,
          targetLow: 18,
          targetHigh: 24,
        },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByLabelText('Target low')).toBeTruthy()
      expect(screen.getByLabelText('Target high')).toBeTruthy()
    })

    it('calls setTargetRange when dual setpoint inputs change', () => {
      mockResult = {
        cap: { setMode, setTarget, setFanMode, setPreset, setTargetHumidity, setTargetRange },
        slice: {
          ...baseSlice,
          mode: 'heat_cool' as const,
          target: null,
          targetLow: 18,
          targetHigh: 24,
        },
        available: true,
      }
      render(<ClimatePanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.change(screen.getByLabelText('Target low'), { target: { value: '17' } })
      expect(setTargetRange).toHaveBeenCalledWith({ targetLow: 17, targetHigh: 24 })
    })
  })
})
