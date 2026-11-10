/**
 * The "Only if…" of an action step (#472): the toggle puts the SAME condition
 * tree on the step, the Else list carries steps without an `if` of their own,
 * and switching it off leaves a plain step.
 */
import type { AutomationAction } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return { ...actual, FieldPicker: () => null, useFieldDescriptor: () => undefined }
})
vi.mock('../../flow/CommandStep', () => ({ CommandStep: () => null }))

import { ActionList } from '../ActionList'

let latest: readonly AutomationAction[] = []

function Harness({ initial }: { readonly initial: readonly AutomationAction[] }) {
  const [actions, setActions] = useState(initial)
  latest = actions
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ActionList
        actions={actions}
        devices={[]}
        onChange={(next) => {
          latest = next
          setActions(next)
        }}
      />
    </QueryClientProvider>
  )
}

describe('a step guard in the action list', () => {
  it('the toggle puts an empty condition tree on the step, and off removes it with its else', () => {
    render(<Harness initial={[{ kind: 'wait', seconds: 3 }]} />)
    const toggle = screen.getByRole('switch', { name: 'Only if…' })
    fireEvent.click(toggle)
    expect(latest[0]).toMatchObject({ kind: 'wait', seconds: 3, if: { kind: 'all', children: [] } })

    fireEvent.click(screen.getByRole('switch', { name: 'Otherwise, run…' }))
    expect(latest[0]).toMatchObject({ else: [] })

    fireEvent.click(screen.getByRole('switch', { name: 'Only if…' }))
    expect(latest[0]).toEqual({ kind: 'wait', seconds: 3 })
  })

  it('editing the seconds keeps the guard, and an else step offers no guard of its own', () => {
    render(
      <Harness
        initial={[
          {
            kind: 'wait',
            seconds: 3,
            if: { kind: 'all', children: [] },
            else: [{ kind: 'wait', seconds: 1 }],
          },
        ]}
      />,
    )
    expect(screen.getAllByRole('switch', { name: 'Only if…' })).toHaveLength(1)
    fireEvent.change(screen.getAllByRole('spinbutton')[0]!, { target: { value: '9' } })
    expect(latest[0]).toMatchObject({ seconds: 9, if: { kind: 'all' }, else: [{ seconds: 1 }] })
  })

  it('the condition editor does not claim to say what starts a run', () => {
    render(<Harness initial={[{ kind: 'wait', seconds: 3, if: { kind: 'all', children: [] } }]} />)
    expect(screen.getByTestId('when-tree')).toBeTruthy()
    expect(screen.queryByText(/starts a run/)).toBeNull()
  })

  it('an IF that can never be true says why, under the tree, without blocking anything', () => {
    render(
      <Harness
        initial={[
          {
            kind: 'wait',
            seconds: 3,
            if: { kind: 'all', children: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }] },
          },
        ]}
      />,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/both have to happen at the same instant/)
  })

  it('a freshly switched-on, still empty IF shows no note', () => {
    render(<Harness initial={[{ kind: 'wait', seconds: 3, if: { kind: 'all', children: [] } }]} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
