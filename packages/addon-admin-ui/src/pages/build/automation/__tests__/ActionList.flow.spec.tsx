/**
 * Flow control in the automation's step list (#500): the stop and set steps
 * and "continue if this fails" exist where the list is an automation's, and
 * nowhere else.
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
vi.mock('../RunActionFields', () => ({ RunActionFields: () => null }))

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
