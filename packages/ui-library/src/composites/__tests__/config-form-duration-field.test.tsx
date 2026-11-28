// @vitest-environment jsdom
/**
 * `type: 'duration'` settings field — the schema-driven form renders the
 * shared `<DurationInput>` and stores ONE number in the declared unit.
 */
import type { ConfigField } from '@dominevo/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormField } from '../config-form-field'

const MS_FIELD: ConfigField = {
  type: 'duration',
  key: 'debounce',
  label: 'Debounce',
  storageUnit: 'ms',
  units: ['seconds', 'millis'],
  min: 100,
  max: 60_000,
  default: 1_500,
}

const S_FIELD: ConfigField = {
  type: 'duration',
  key: 'timeout',
  label: 'Timeout',
  storageUnit: 's',
}

const field = (name: string): HTMLInputElement => screen.getByRole('spinbutton', { name })

describe('FormField — type: duration', () => {
  it('shows the stored milliseconds as seconds and milliseconds', () => {
    render(<FormField field={MS_FIELD} values={{ debounce: 2_250 }} onChange={vi.fn()} />)
    expect(field('Seconds').value).toBe('2')
    expect(field('Milliseconds').value).toBe('250')
    expect(screen.queryByRole('spinbutton', { name: 'Hours' })).toBeNull()
  })

  it('writes one number in the declared unit', () => {
    const onChange = vi.fn()
    render(<FormField field={MS_FIELD} values={{ debounce: 2_250 }} onChange={onChange} />)
    fireEvent.change(field('Seconds'), { target: { value: '4' } })
    expect(onChange).toHaveBeenLastCalledWith('debounce', 4_250)
  })

  it('writes seconds for a field stored in seconds', () => {
    const onChange = vi.fn()
    render(<FormField field={S_FIELD} values={{ timeout: 30 }} onChange={onChange} />)
    fireEvent.change(field('Minutes'), { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith('timeout', 150)
  })

  it('reads a missing value as the default', () => {
    render(<FormField field={MS_FIELD} values={{}} onChange={vi.fn()} />)
    expect(field('Seconds').value).toBe('1')
    expect(field('Milliseconds').value).toBe('500')
  })

  it('marks a value outside the bounds', () => {
    render(<FormField field={MS_FIELD} values={{ debounce: 50 }} onChange={vi.fn()} />)
    expect(field('Milliseconds').getAttribute('aria-invalid')).toBe('true')
  })
})
