/**
 * The `triggered-by` row: one toggle per trigger row of the automation, named
 * by its position and what it is; a chosen id no row carries is shown as
 * missing; with no trigger rows it says so instead of showing nothing.
 */
import type { AutomationWhen, TriggeredByLeaf } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import '../../../../i18n/index'
import { TriggerRowsProvider } from '../trigger-rows-context'
import { TriggeredByFields } from '../TriggeredByFields'

const WHEN: AutomationWhen = {
  kind: 'any',
  children: [
    { kind: 'device-event', category: 'motion.on-motion-changed', id: 't1' },
    { kind: 'device-event', category: 'button.pressed', deviceId: 7, id: 't2' },
  ],
}
const DEVICES = [{ id: 7, name: 'Hall remote', stableId: 'remote-7' }]

function Harness({
  when,
  initial,
  seen,
}: {
  when: AutomationWhen
  initial: TriggeredByLeaf
  seen: TriggeredByLeaf[]
}) {
  const [leaf, setLeaf] = useState(initial)
  return (
    <TriggerRowsProvider when={when}>
      <TriggeredByFields
        leaf={leaf}
        devices={DEVICES}
        onChange={(next) => {
          seen.push(next)
          setLeaf(next)
        }}
      />
    </TriggerRowsProvider>
  )
}

describe('TriggeredByFields', () => {
  it('offers one toggle per trigger row and writes the pressed ones', () => {
    const seen: TriggeredByLeaf[] = []
    render(<Harness when={WHEN} initial={{ kind: 'triggered-by', leafIds: [] }} seen={seen} />)
    expect(screen.getByTestId('triggered-by-none-picked')).toBeTruthy()
    const remote = screen.getByRole('button', { name: /2.*Hall remote/ })
    expect(remote.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(remote)
    expect(seen.at(-1)?.leafIds).toEqual(['t2'])
    expect(
      screen.getByRole('button', { name: /2.*Hall remote/ }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.queryByTestId('triggered-by-none-picked')).toBeNull()
  })

  it('shows a chosen trigger that no longer exists, and says so', () => {
    render(
      <Harness when={WHEN} initial={{ kind: 'triggered-by', leafIds: ['gone', 't1'] }} seen={[]} />,
    )
    expect(screen.getByTestId('triggered-by-missing').textContent).toContain('1')
  })

  it('says there is no trigger row to choose when the automation has none', () => {
    render(
      <Harness
        when={{ kind: 'time-is', days: ['sat'] }}
        initial={{ kind: 'triggered-by', leafIds: [] }}
        seen={[]}
      />,
    )
    expect(screen.getByTestId('triggered-by-no-rows')).toBeTruthy()
  })
})
