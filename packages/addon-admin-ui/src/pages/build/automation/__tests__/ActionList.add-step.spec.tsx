/**
 * "+ Step" asks for the KIND first: it adds nothing, and so opens no device
 * modal, until a kind is chosen. A step can be switched off without deleting it.
 */
import type { AutomationAction } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return { ...actual, FieldPicker: () => null, useFieldDescriptor: () => undefined }
})
vi.mock('../../flow/CommandStep', () => ({
  CommandStep: () => <span data-testid="fake-command" />,
}))
vi.mock('../RunActionFields', () => ({ RunActionFields: () => null }))
vi.mock('../NotifyFields', () => ({ NotifyFields: () => <span data-testid="fake-notify" /> }))
vi.mock('../WhenTree', () => ({ WhenTree: () => null }))

import { ActionList } from '../ActionList'

// jsdom has no <dialog> modal API.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

let latest: readonly AutomationAction[] = []

function Harness(props: { readonly initial: readonly AutomationAction[]; readonly max?: number }) {
  const [actions, setActions] = useState(props.initial)
  latest = actions
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ActionList
        actions={actions}
        devices={[]}
        flowControl
        {...(props.max === undefined ? {} : { maxSteps: props.max })}
        onChange={(next) => {
          latest = next
          setActions(next)
        }}
      />
    </QueryClientProvider>
  )
}

describe('"+ Step"', () => {
  it('opens the kind picker and creates no step until a kind is chosen', () => {
    render(<Harness initial={[]} />)
    expect(screen.queryByTestId('step-kind-picker')).toBeNull()
    fireEvent.click(screen.getByTestId('add-step'))
    expect(screen.getByTestId('step-kind-picker')).toBeTruthy()
    expect(latest).toEqual([])
    expect(screen.queryByTestId('fake-command')).toBeNull()
  })

  it('offers the device command, wait, wait until, set, choose, parallel, repeat, code, run action and send notification', () => {
    render(<Harness initial={[]} />)
    fireEvent.click(screen.getByTestId('add-step'))
    for (const kind of [
      'command',
      'wait',
      'wait-until',
      'set',
      'choose',
      'parallel',
      'repeat',
      'code',
      'action',
      'notify',
    ]) {
      expect(screen.getByTestId(`step-kind-option-${kind}`)).toBeTruthy()
    }
  })

  it('the chosen kind is the step that is created', () => {
    render(<Harness initial={[]} />)
    fireEvent.click(screen.getByTestId('add-step'))
    fireEvent.click(screen.getByTestId('step-kind-option-wait'))
    expect(latest).toEqual([{ kind: 'wait', seconds: 5 }])
    fireEvent.click(screen.getByTestId('add-step'))
    fireEvent.click(screen.getByTestId('step-kind-option-notify'))
    expect(latest[1]).toEqual({ kind: 'notify', targetId: '', body: '' })
  })

  it('keeps maxSteps: at the bound the button is disabled and no picker opens', () => {
    render(<Harness initial={[{ kind: 'wait', seconds: 1 }]} max={1} />)
    fireEvent.click(screen.getByTestId('add-step'))
    expect(screen.queryByTestId('step-kind-picker')).toBeNull()
  })
})

describe('the per-step enable switch', () => {
  const WAIT: AutomationAction = { kind: 'wait', seconds: 5 }

  it('writes enabled: false, mutes the card, and removes the flag when switched back on', () => {
    render(<Harness initial={[WAIT]} />)
    expect(screen.getByTestId('step-card-0').getAttribute('data-disabled')).toBe('false')
    fireEvent.click(screen.getByTestId('step-enabled-0'))
    expect(latest).toEqual([{ ...WAIT, enabled: false }])
    expect(screen.getByTestId('step-card-0').getAttribute('data-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('step-enabled-0'))
    expect(latest).toEqual([WAIT])
  })
})
