// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ControlPanel } from '../control-panel'

const setValue = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const getDeviceInfo = vi.fn()

vi.mock('../../../contexts/system-context', () => ({
  useOptionalSystem: () => ({ getDeviceInfo }),
}))

const trpc = {} as never

beforeEach(() => {
  setValue.mockReset()
  getDeviceInfo.mockReset()
  getDeviceInfo.mockReturnValue(null)
  mockResult = {
    cap: { setValue },
    slice: undefined,
    available: false,
  }
})

describe('ControlPanel', () => {
  it('renders nothing when the slice has not landed (unbound)', () => {
    const { container } = render(
      <ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
    )
    expect(container.firstChild).toBeNull()
  })

  describe('select kind', () => {
    beforeEach(() => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'select', value: 'eco', options: ['eco', 'boost', 'off'], lastChangedAt: 0 },
        available: true,
      }
    })

    it('renders a dropdown with the options', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select).toBeTruthy()
      expect(screen.getByRole('option', { name: 'eco' })).toBeTruthy()
      expect(screen.getByRole('option', { name: 'boost' })).toBeTruthy()
      expect(screen.getByRole('option', { name: 'off' })).toBeTruthy()
    })

    it('shows the current value as selected', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select.value).toBe('eco')
    })

    it('calls setValue with select kind when option is changed', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'boost' } })
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'select', value: 'boost' } })
    })

    it('disables the dropdown when not available', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'select', value: 'eco', options: ['eco', 'boost', 'off'], lastChangedAt: 0 },
        available: false,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select.disabled).toBe(true)
    })

    it('constrains the select width so it cannot overflow its control column', () => {
      mockResult = {
        cap: { setValue },
        slice: {
          kind: 'select',
          value: 'A very long operating mode label that would overflow',
          options: ['A very long operating mode label that would overflow', 'off'],
          lastChangedAt: 0,
        },
        available: true,
      }
      const { container } = render(
        <ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      const select = screen.getByRole('combobox') as HTMLSelectElement
      // Must be allowed to shrink (min-w-0), capped to its column (w-full/max-w-full)
      // and truncate its value rather than expand past the column onto the status dot.
      expect(select.className).toContain('w-full')
      expect(select.className).toContain('max-w-full')
      expect(select.className).toContain('min-w-0')
      expect(select.className).toContain('truncate')
      // The wrapping panel must also permit its flex children to shrink.
      const panel = container.querySelector('[data-kind="select"]') as HTMLElement
      expect(panel.className).toContain('min-w-0')
    })

    it('is borderless inside the panel chrome (no double border)', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select.className).not.toContain('border border-border')
      expect(select.className).not.toContain('bg-surface')
      expect(select.className).toContain('bg-transparent')
      const panel = select.closest('[data-kind="select"]') as HTMLElement
      expect(panel.className).toContain('border border-border')
    })
  })

  describe('numeric kind', () => {
    beforeEach(() => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 21, options: [], lastChangedAt: 0 },
        available: true,
      }
    })

    it('renders a number input showing the current value', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const input = screen.getByRole('spinbutton') as HTMLInputElement
      expect(input).toBeTruthy()
      expect(input.value).toBe('21')
    })

    it('calls setValue with numeric kind when input changes', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '22' } })
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 22 } })
    })

    it('calls setValue with numeric kind when stepper increment is clicked', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 22 } })
    })

    it('calls setValue with numeric kind when stepper decrement is clicked', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Decrement' }))
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 20 } })
    })

    it('disables the input and steppers when not available', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 21, options: [], lastChangedAt: 0 },
        available: false,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const input = screen.getByRole('spinbutton') as HTMLInputElement
      expect(input.disabled).toBe(true)
      const incBtn = screen.getByRole('button', { name: 'Increment' }) as HTMLButtonElement
      expect(incBtn.disabled).toBe(true)
    })
  })

  describe('text kind', () => {
    beforeEach(() => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'text', value: '', options: [], lastChangedAt: 0 },
        available: true,
      }
    })

    it('renders a text input', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      expect(screen.getByRole('textbox')).toBeTruthy()
    })

    it('calls setValue with text kind on blur after typing', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const input = screen.getByRole('textbox') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'hello' } })
      fireEvent.blur(input)
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'text', value: 'hello' } })
    })

    it('calls setValue with text kind on Enter keypress', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const input = screen.getByRole('textbox') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'hello' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'text', value: 'hello' } })
    })

    it('disables the text input when not available', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'text', value: '', options: [], lastChangedAt: 0 },
        available: false,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const input = screen.getByRole('textbox') as HTMLInputElement
      expect(input.disabled).toBe(true)
    })
  })

  describe('datetime kind — full (editable) layout', () => {
    beforeEach(() => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'datetime', value: '2024-01-15T10:30', options: [], lastChangedAt: 0 },
        available: true,
      }
    })

    it('renders a datetime-local input', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement
      expect(input).toBeTruthy()
      expect(input.value).toBe('2024-01-15T10:30')
    })

    it('calls setValue with datetime kind when input changes', () => {
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2024-02-20T14:00' } })
      expect(setValue).toHaveBeenCalledWith({
        control: { kind: 'datetime', value: '2024-02-20T14:00' },
      })
    })

    it('disables the datetime input when not available', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'datetime', value: '2024-01-15T10:30', options: [], lastChangedAt: 0 },
        available: false,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement
      expect(input.disabled).toBe(true)
    })

    it('picks a date input from SourceInfo.dateTimeShape, ignoring a slice format sibling', () => {
      // D944 §4 removed unit siblings. A datetime shape is not a unit: it lives
      // on SourceInfo.dateTimeShape, and that is what the panel must render.
      getDeviceInfo.mockReturnValue({ sourceInfo: { dateTimeShape: 'date' } })
      mockResult = {
        cap: { setValue },
        slice: {
          kind: 'datetime',
          value: '2026-06-07',
          options: [],
          lastChangedAt: 0,
          format: 'time',
        },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      const input = document.querySelector('input[type="date"]') as HTMLInputElement
      expect(input).toBeTruthy()
      expect(input.value).toBe('2026-06-07')
      expect(document.querySelector('input[type="time"]')).toBeNull()
    })

    it('picks a time input from SourceInfo.dateTimeShape', () => {
      getDeviceInfo.mockReturnValue({ sourceInfo: { dateTimeShape: 'time' } })
      mockResult = {
        cap: { setValue },
        slice: { kind: 'datetime', value: '07:30:00', options: [], lastChangedAt: 0 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      const input = document.querySelector('input[type="time"]') as HTMLInputElement
      expect(input).toBeTruthy()
      expect(input.value).toBe('07:30')
    })
  })

  describe('datetime kind — compact (read-only) layout', () => {
    it('renders a read-only locale-formatted span, not an editable input (datetime)', () => {
      mockResult = {
        cap: { setValue },
        slice: {
          kind: 'datetime',
          value: '2024-01-15T10:30',
          options: [],
          lastChangedAt: 0,
          format: 'datetime',
        },
        available: true,
      }
      const { container } = render(
        <ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      // No editable input in the compact (row) readout.
      expect(container.querySelector('input')).toBeNull()
      // The value renders as text (locale-formatted). Assert locale-independently:
      // it WAS formatted (non-empty, not the raw ISO input) and carries the year.
      const readout = screen.getByLabelText('Control value')
      expect(readout.tagName).toBe('SPAN')
      const text = readout.textContent ?? ''
      expect(text).not.toBe('')
      expect(text).not.toBe('2024-01-15T10:30')
      expect(text).toContain('2024')
    })

    it('renders a date value as a read-only span in compact layout', () => {
      mockResult = {
        cap: { setValue },
        slice: {
          kind: 'datetime',
          value: '2026-06-07',
          options: [],
          lastChangedAt: 0,
          format: 'date',
        },
        available: true,
      }
      const { container } = render(
        <ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      expect(container.querySelector('input')).toBeNull()
      const readout = screen.getByLabelText('Control value')
      // Locale-independent: the value WAS formatted (not the raw input) and carries the year.
      const text = readout.textContent ?? ''
      expect(text).not.toBe('')
      expect(text).not.toBe('2026-06-07')
      expect(text).toContain('2026')
    })

    it('renders a muted placeholder when the value is empty', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'datetime', value: '', options: [], lastChangedAt: 0, format: 'date' },
        available: true,
      }
      const { container } = render(
        <ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      expect(container.querySelector('input')).toBeNull()
      expect(screen.getByText('—')).toBeTruthy()
    })
  })

  describe('numeric kind — unit/min/max/step', () => {
    it('shows the unit label from the device quantity', () => {
      getDeviceInfo.mockReturnValue({ sourceInfo: { quantity: 'temperature' } })
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 21, options: [], lastChangedAt: 0 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      expect(screen.getByText('°C')).toBeTruthy()
    })

    it('does not render a unit element when unit is absent', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 21, options: [], lastChangedAt: 0 },
        available: true,
      }
      const { container } = render(
        <ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      // No span with °C or any unit text — verify no <span> with class text-foreground-subtle outside input context
      const spans = container.querySelectorAll('span')
      expect(spans).toHaveLength(0)
    })

    it('uses step from slice for the increment button', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 20, options: [], lastChangedAt: 0, step: 0.5 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 20.5 } })
    })

    it('uses step from slice for the decrement button', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 20, options: [], lastChangedAt: 0, step: 0.5 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Decrement' }))
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 19.5 } })
    })

    it('clamps the value to max when incrementing past the maximum', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 30, options: [], lastChangedAt: 0, max: 30 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
      // value + step(1) = 31 clamped to max(30)
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 30 } })
    })

    it('clamps a typed value above max to max on change', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 25, options: [], lastChangedAt: 0, max: 30 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } })
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 30 } })
    })

    it('clamps the value to min when decrementing past the minimum', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 5, options: [], lastChangedAt: 0, min: 5 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Decrement' }))
      // value - step(1) = 4 clamped to min(5)
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 5 } })
    })

    it('falls back to step=1 when step is absent in the slice', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 10, options: [], lastChangedAt: 0 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 11 } })
    })
  })

  describe('numeric kind — precision display', () => {
    it('formats the initial value with toFixed(precision) when precision is set', () => {
      getDeviceInfo.mockReturnValue({
        sourceInfo: { quantity: 'temperature' },
        display: { precision: 1 },
      })
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 24.567, options: [], lastChangedAt: 0 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const input = screen.getByRole('spinbutton') as HTMLInputElement
      // 24.567 with precision=1 → "24.6"
      expect(input.value).toBe('24.6')
    })

    it('formats the stepper increment result with precision', () => {
      getDeviceInfo.mockReturnValue({
        sourceInfo: { quantity: 'temperature' },
        display: { precision: 1 },
      })
      mockResult = {
        cap: { setValue },
        slice: {
          kind: 'numeric',
          value: 24.5,
          options: [],
          lastChangedAt: 0,
          step: 0.5,
        },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
      // commit value = 24.5 + 0.5 = 25.0
      expect(setValue).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 25 } })
      // draft shown in input should be "25.0" (precision=1)
      const input = screen.getByRole('spinbutton') as HTMLInputElement
      expect(input.value).toBe('25.0')
    })

    it('uses raw String(value) display when precision is absent', () => {
      mockResult = {
        cap: { setValue },
        slice: { kind: 'numeric', value: 21, options: [], lastChangedAt: 0 },
        available: true,
      }
      render(<ControlPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const input = screen.getByRole('spinbutton') as HTMLInputElement
      // Integer 21 without precision → auto-format → "21"
      expect(input.value).toBe('21')
    })
  })
})
