/**
 * The `time-is` row: the days are toggles over the leaf, both ends of the
 * window are on screen, and the row says when a window ends the next day.
 */
import type { TimeIsLeaf } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import '../../../../i18n/index'
import { TimeIsFields } from '../TimeIsFields'

const NIGHT: TimeIsLeaf = {
  kind: 'time-is',
  between: {
    from: { kind: 'sun', event: 'sunset', offsetMin: -30 },
    to: { kind: 'clock', hh: 6, mm: 0 },
  },
}

function Harness({ initial, seen }: { initial: TimeIsLeaf; seen: TimeIsLeaf[] }) {
  const [leaf, setLeaf] = useState(initial)
  return (
    <TimeIsFields
      leaf={leaf}
      onChange={(next) => {
        seen.push(next)
        setLeaf(next)
      }}
    />
  )
}

describe('TimeIsFields', () => {
  it('shows a sun start with its offset and a clock end', () => {
    render(<Harness initial={NIGHT} seen={[]} />)
    const from = within(screen.getByTestId('time-is-from'))
    expect(from.getByLabelText(/^From: Offset/)).toHaveProperty('value', '-30')
    const to = within(screen.getByTestId('time-is-to'))
    expect(to.getByLabelText('To: Time')).toHaveProperty('value', '06:00')
    expect(screen.queryByTestId('time-is-wraps')).toBeNull()
  })

  it('every day is pressed with no list; releasing one stores the rest, and the last one warns', () => {
    const seen: TimeIsLeaf[] = []
    render(<Harness initial={{ ...NIGHT, days: ['sat', 'sun'] }} seen={seen} />)
    const days = within(screen.getByRole('group', { name: 'Days' }))
    expect(days.getByRole('button', { name: 'Sat' }).getAttribute('aria-pressed')).toBe('true')
    expect(days.getByRole('button', { name: 'Mon' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(days.getByRole('button', { name: 'Sat' }))
    expect(seen.at(-1)?.days).toEqual(['sun'])
    fireEvent.click(days.getByRole('button', { name: 'Sun' }))
    expect(seen.at(-1)?.days).toEqual([])
    expect(screen.getByTestId('time-is-no-days')).toBeTruthy()
  })

  it('editing the clock end keeps the sun start, and a clock window over midnight says it ends the next day', () => {
    const seen: TimeIsLeaf[] = []
    render(<Harness initial={NIGHT} seen={seen} />)
    fireEvent.change(screen.getByLabelText('To: Time'), {
      target: { value: '05:15' },
    })
    expect(seen.at(-1)?.between).toEqual({
      from: { kind: 'sun', event: 'sunset', offsetMin: -30 },
      to: { kind: 'clock', hh: 5, mm: 15 },
    })
    render(
      <Harness
        initial={{
          kind: 'time-is',
          between: {
            from: { kind: 'clock', hh: 22, mm: 0 },
            to: { kind: 'clock', hh: 6, mm: 0 },
          },
        }}
        seen={[]}
      />,
    )
    expect(screen.getByTestId('time-is-wraps')).toBeTruthy()
  })
})
