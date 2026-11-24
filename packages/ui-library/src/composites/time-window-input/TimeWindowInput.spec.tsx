/**
 * TimeWindowInput: every emitted value is a `TimeWindow` the evaluator reads,
 * a window over midnight says so, presets and weekdays work, and sun choices
 * are refused on a site without a location.
 */
import { type TimeWindow, TimeWindowSchema } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { TimeWindowInput, type TimeWindowInputProps } from './TimeWindowInput'

const NIGHT_CLOCK: TimeWindow = {
  between: {
    from: { kind: 'clock', hh: 22, mm: 0 },
    to: { kind: 'clock', hh: 6, mm: 0 },
  },
}

function Harness({
  initial,
  seen,
  ...rest
}: {
  initial: TimeWindow
  seen: TimeWindow[]
} & Partial<TimeWindowInputProps>) {
  const [value, setValue] = useState(initial)
  return (
    <TimeWindowInput
      {...rest}
      value={value}
      onChange={(next) => {
        seen.push(next)
        setValue(next)
      }}
    />
  )
}

function pick(name: string, option: string): void {
  fireEvent.click(screen.getByRole('combobox', { name }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

describe('TimeWindowInput', () => {
  it('round-trips a window: editing one end keeps the other and every emission is valid', () => {
    const seen: TimeWindow[] = []
    render(<Harness initial={NIGHT_CLOCK} seen={seen} />)
    expect(screen.getByLabelText('From: Time')).toHaveProperty('value', '22:00')
    fireEvent.change(screen.getByLabelText('To: Time'), {
      target: { value: '05:15' },
    })
    expect(seen.at(-1)).toEqual({
      between: {
        from: { kind: 'clock', hh: 22, mm: 0 },
        to: { kind: 'clock', hh: 5, mm: 15 },
      },
    })
    for (const value of seen) expect(TimeWindowSchema.safeParse(value).success).toBe(true)
  })

  it('says a window ends the next day when the range crosses midnight', () => {
    render(<Harness initial={NIGHT_CLOCK} seen={[]} />)
    expect(screen.getByTestId('time-window-wraps')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('From: Time'), {
      target: { value: '05:00' },
    })
    expect(screen.queryByTestId('time-window-wraps')).toBeNull()
  })

  it('presets: Night replaces the range, keeps the days and says it ends the next day; Between unfolds it', () => {
    const seen: TimeWindow[] = []
    render(<Harness initial={{ ...NIGHT_CLOCK, days: ['sat', 'sun'] }} seen={seen} />)
    pick('Time of day', 'Nighttime (sunset to sunrise)')
    expect(seen.at(-1)).toEqual({ preset: 'night', days: ['sat', 'sun'] })
    expect(screen.queryByTestId('time-window-from')).toBeNull()
    expect(screen.getByTestId('time-window-wraps')).toBeTruthy()
    pick('Time of day', 'Between two times')
    expect(seen.at(-1)).toEqual({
      between: {
        from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
        to: { kind: 'sun', event: 'sunrise', offsetMin: 0 },
      },
      days: ['sat', 'sun'],
    })
    pick('Time of day', 'Daytime (sunrise to sunset)')
    expect(seen.at(-1)).toEqual({ preset: 'day', days: ['sat', 'sun'] })
  })

  it('weekdays: no list is every day; releasing one stores the rest; the last one is shown as an error', () => {
    const seen: TimeWindow[] = []
    render(<Harness initial={{ ...NIGHT_CLOCK, days: ['sat', 'sun'] }} seen={seen} />)
    const days = within(screen.getByRole('group', { name: 'Days' }))
    expect(days.getByRole('button', { name: 'Sat' }).getAttribute('aria-pressed')).toBe('true')
    expect(days.getByRole('button', { name: 'Mon' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(days.getByRole('button', { name: 'Sat' }))
    expect(seen.at(-1)?.days).toEqual(['sun'])
    fireEvent.click(days.getByRole('button', { name: 'Sun' }))
    expect(seen.at(-1)?.days).toEqual([])
    expect(screen.getByTestId('time-window-no-days')).toBeTruthy()
    expect(TimeWindowSchema.safeParse(seen.at(-1)).success).toBe(false)
  })

  it('pressing the seventh day drops the list (key omitted)', () => {
    const seen: TimeWindow[] = []
    render(
      <Harness
        initial={{
          ...NIGHT_CLOCK,
          days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        }}
        seen={seen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sun' }))
    expect(seen.at(-1)).toEqual(NIGHT_CLOCK)
    expect('days' in (seen.at(-1) ?? {})).toBe(false)
  })

  it('the whole day keeps the days explicit, so the window stays valid', () => {
    const seen: TimeWindow[] = []
    render(<Harness initial={NIGHT_CLOCK} seen={seen} />)
    pick('Time of day', 'The whole day')
    expect(seen.at(-1)?.between).toBeUndefined()
    expect(seen.at(-1)?.days).toHaveLength(7)
    expect(TimeWindowSchema.safeParse(seen.at(-1)).success).toBe(true)
  })

  it('shows the schema refusal inline (an offset past twelve hours)', () => {
    render(
      <Harness
        initial={{
          between: {
            from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
            to: { kind: 'clock', hh: 6, mm: 0 },
          },
        }}
        seen={[]}
      />,
    )
    expect(screen.queryByTestId('time-window-errors')).toBeNull()
    fireEvent.change(screen.getByLabelText(/^From: Offset/), {
      target: { value: '900' },
    })
    expect(screen.getByTestId('time-window-errors')).toBeTruthy()
  })

  it('without a location: the sun presets are disabled with the reason, a sun end says why', () => {
    render(<Harness initial={NIGHT_CLOCK} seen={[]} siteHasNoLocation />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Time of day' }))
    for (const name of ['Nighttime (sunset to sunrise)', 'Daytime (sunrise to sunset)']) {
      expect(screen.getByRole('option', { name }).getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('without a location, a window that already names the sun still says it cannot be judged', () => {
    render(<Harness initial={{ preset: 'night' }} seen={[]} siteHasNoLocation />)
    expect(screen.getByTestId('time-window-no-location')).toBeTruthy()
  })

  it('weekdays={false} hides the days and the whole-day choice; presets={false} hides Day and Night', () => {
    render(<Harness initial={NIGHT_CLOCK} seen={[]} weekdays={false} presets={false} />)
    expect(screen.queryByRole('group', { name: 'Days' })).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: 'Time of day' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Between two times'])
  })

  it('weekdays={false} still names a stored whole-day window instead of a blank select', () => {
    render(<Harness initial={{ days: ['sat'] }} seen={[]} weekdays={false} />)
    expect(screen.getByRole('combobox', { name: /Time of day/ })).toHaveProperty(
      'textContent',
      expect.stringMatching(/whole day/i),
    )
  })
})
