/**
 * Flow control in the automation's step list (#500): the stop and set steps
 * and "continue if this fails" exist where the list is an automation's, and
 * nowhere else.
 */
import type { AutomationAction } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return { ...actual, FieldPicker: () => null, useFieldDescriptor: () => undefined }
})
vi.mock('../../flow/CommandStep', () => ({ CommandStep: () => null }))
vi.mock('../RunActionFields', () => ({ RunActionFields: () => null }))
vi.mock('../WhenTree', () => ({ WhenTree: () => null }))

import { ActionList } from '../ActionList'

let latest: readonly AutomationAction[] = []

function Harness(props: { readonly initial: readonly AutomationAction[]; readonly flow: boolean }) {
  const [actions, setActions] = useState(props.initial)
  latest = actions
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ActionList
        actions={actions}
        devices={[]}
        flowControl={props.flow}
        onChange={(next) => {
          latest = next
          setActions(next)
        }}
      />
    </QueryClientProvider>
  )
}

const CAP: AutomationAction = {
  kind: 'cap',
  target: { kind: 'devices', ids: [1] },
  cap: 'switch',
  method: 'on',
}

describe('ActionList flow control', () => {
  it('a stop step edits its reason and how the run ends', () => {
    render(<Harness flow initial={[{ kind: 'stop', reason: '', outcome: 'ok' }]} />)
    fireEvent.change(screen.getByTestId('stop-reason-0'), { target: { value: 'nobody home' } })
    fireEvent.click(screen.getByTestId('stop-outcome-0'))
    fireEvent.click(screen.getByRole('option', { name: 'A failure' }))
    expect(latest).toEqual([{ kind: 'stop', reason: 'nobody home', outcome: 'failed' }])
  })

  it('a set step adds, names and fills a variable', () => {
    render(<Harness flow initial={[{ kind: 'set', vars: {} }]} />)
    fireEvent.click(screen.getByTestId('set-add-0'))
    fireEvent.change(screen.getByTestId('set-name-0-0'), { target: { value: 'room' } })
    fireEvent.change(screen.getByTestId('set-value-0-0'), { target: { value: 'kitchen' } })
    expect(latest).toEqual([{ kind: 'set', vars: { room: 'kitchen' } }])
  })

  it('"continue if this fails" is written as the literal flag and removed when switched off', () => {
    render(<Harness flow initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('continue-on-error-0'))
    expect(latest).toEqual([{ ...CAP, continueOnError: true }])
    fireEvent.click(screen.getByTestId('continue-on-error-0'))
    expect(latest).toEqual([CAP])
  })

  it('an automation list offers the stop and set steps', () => {
    render(<Harness flow initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    const kinds = screen.getAllByRole('option').map((o) => o.textContent)
    expect(kinds).toEqual(expect.arrayContaining(['Stop the run', 'Set variables']))
  })

  it('a list that is not an automation offers neither the steps nor the switch', () => {
    render(<Harness flow={false} initial={[CAP]} />)
    expect(screen.queryByTestId('continue-on-error-0')).toBeNull()
    fireEvent.click(screen.getByTestId('step-kind-0'))
    const kinds = screen.getAllByRole('option').map((o) => o.textContent)
    expect(kinds.length).toBeGreaterThan(1)
    expect(kinds).not.toContain('Stop the run')
    expect(kinds).not.toContain('Set variables')
  })
})

describe('ActionList choose (#500)', () => {
  const CHOOSE: AutomationAction = {
    kind: 'choose',
    branches: [{ if: { kind: 'all', children: [] }, steps: [] }],
  }

  it('an automation list offers the choose step, a branch list does not', () => {
    render(<Harness flow initial={[CHOOSE]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Choose')
    fireEvent.click(screen.getByRole('option', { name: 'Choose' }))
    const branch = within(screen.getByTestId('choose-branch-0-0'))
    fireEvent.click(branch.getByRole('button', { name: 'Step' }))
    fireEvent.click(branch.getByTestId('step-kind-0'))
    const inner = screen.getAllByRole('option').map((o) => o.textContent)
    expect(inner).toEqual(expect.arrayContaining(['Wait', 'Stop the run', 'Set variables']))
    expect(inner).not.toContain('Choose')
    expect(inner).not.toContain('Run code')
  })

  it('a list that is not an automation does not offer it', () => {
    render(<Harness flow={false} initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain('Choose')
  })

  it('adds branches up to six, removes one, and keeps the last', () => {
    render(<Harness flow initial={[CHOOSE]} />)
    expect(screen.getByTestId('choose-remove-0-0')).toHaveProperty('disabled', true)
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByTestId('choose-add-0'))
    expect(latest[0]).toMatchObject({ kind: 'choose' })
    expect(screen.getAllByTestId(/^choose-branch-0-/)).toHaveLength(6)
    expect(screen.getByTestId('choose-add-0')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('choose-remove-0-5'))
    expect(screen.getAllByTestId(/^choose-branch-0-/)).toHaveLength(5)
  })

  it('the otherwise list is written when switched on and removed when switched off', () => {
    render(<Harness flow initial={[CHOOSE]} />)
    fireEvent.click(screen.getByTestId('choose-else-0'))
    expect(latest).toEqual([{ ...CHOOSE, else: [] }])
    fireEvent.click(screen.getByTestId('choose-else-0'))
    expect(latest).toEqual([CHOOSE])
  })

  it('a step inside a branch can be told to continue if it fails', () => {
    render(
      <Harness
        flow
        initial={[
          { kind: 'choose', branches: [{ if: { kind: 'all', children: [] }, steps: [CAP] }] },
        ]}
      />,
    )
    fireEvent.click(
      within(screen.getByTestId('choose-branch-0-0')).getByTestId('continue-on-error-0'),
    )
    expect(latest).toEqual([
      {
        kind: 'choose',
        branches: [
          { if: { kind: 'all', children: [] }, steps: [{ ...CAP, continueOnError: true }] },
        ],
      },
    ])
  })
})

describe('ActionList wait-until (#500)', () => {
  const WAIT_UNTIL: AutomationAction = {
    kind: 'wait-until',
    when: { kind: 'all', children: [] },
    timeoutS: 600,
    onTimeout: 'continue',
  }

  it('is offered in an automation list', () => {
    render(<Harness flow initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Wait until')
  })

  it('is not offered where the list is not an automation', () => {
    render(<Harness flow={false} initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain('Wait until')
  })

  it('edits the timeout in its unit and what happens when it runs out', () => {
    render(<Harness flow initial={[WAIT_UNTIL]} />)
    const value = screen.getByTestId('wait-until-timeout-0')
    expect(value).toHaveProperty('value', '10')
    fireEvent.change(value, { target: { value: '30' } })
    expect(latest).toEqual([{ ...WAIT_UNTIL, timeoutS: 1800 }])
    fireEvent.click(screen.getByTestId('wait-until-unit-0'))
    fireEvent.click(screen.getByRole('option', { name: 'hours' }))
    expect(latest).toEqual([{ ...WAIT_UNTIL, timeoutS: 21600 }])
    fireEvent.click(screen.getByTestId('wait-until-on-timeout-0'))
    fireEvent.click(screen.getByRole('option', { name: 'Stop the run as a failure' }))
    expect(latest).toEqual([{ ...WAIT_UNTIL, timeoutS: 21600, onTimeout: 'stop' }])
  })
})
