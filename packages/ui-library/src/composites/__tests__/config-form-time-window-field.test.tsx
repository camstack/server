// @vitest-environment jsdom
/**
 * `type: 'time-window'` settings field — the schema-driven form renders the
 * shared `<TimeWindowInput>` and stores ONE `TimeWindow` object.
 */
import { type ConfigField, TimeWindowSchema } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormField } from '../config-form-field'

const FIELD: ConfigField = {
  type: 'time-window',
  key: 'quiet',
  label: 'Quiet hours',
}

describe('FormField — type: time-window', () => {
  it('shows the stored window and writes the edited one back as a TimeWindow', () => {
    const onChange = vi.fn()
    const stored = {
      between: {
        from: { kind: 'clock', hh: 22, mm: 0 },
        to: { kind: 'clock', hh: 6, mm: 0 },
      },
      days: ['sat', 'sun'],
    }
    render(<FormField field={FIELD} values={{ quiet: stored }} onChange={onChange} />)
    expect(screen.getByLabelText('From: Time')).toHaveProperty('value', '22:00')
    fireEvent.change(screen.getByLabelText('To: Time'), {
      target: { value: '07:30' },
    })
    const [key, written] = onChange.mock.calls.at(-1) ?? []
    expect(key).toBe('quiet')
    expect(TimeWindowSchema.parse(written)).toEqual({
      between: {
        from: { kind: 'clock', hh: 22, mm: 0 },
        to: { kind: 'clock', hh: 7, mm: 30 },
      },
      days: ['sat', 'sun'],
    })
  })

  it('shows an invalid draft as it is, with its error, instead of snapping to a default', () => {
    render(
      <FormField
        field={FIELD}
        values={{
          quiet: {
            between: {
              from: { kind: 'clock', hh: 21, mm: 15 },
              to: { kind: 'clock', hh: 5, mm: 0 },
            },
            days: [],
          },
        }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('From: Time')).toHaveProperty('value', '21:15')
    expect(screen.getByTestId('field-quiet-no-days')).toBeTruthy()
  })

  it('shows a missing value as an empty window, not an invented range', () => {
    render(<FormField field={FIELD} values={{}} onChange={vi.fn()} />)
    expect(screen.queryByLabelText('From: Time')).toBeNull()
  })
})
