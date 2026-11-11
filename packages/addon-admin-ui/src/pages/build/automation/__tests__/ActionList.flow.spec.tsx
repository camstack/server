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
vi.mock('../../flow/CommandStep', () => ({
  CommandStep: (props: { readonly roundDevices?: readonly number[] }) => (
    <span
      data-testid="fake-command"
      data-round={props.roundDevices === undefined ? 'none' : props.roundDevices.join(',')}
    />
  ),
}))
vi.mock('../RunActionFields', () => ({ RunActionFields: () => null }))
vi.mock('../WhenTree', () => ({ WhenTree: () => null }))
vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    DeviceValuePicker: (props: {
      readonly onChange: (next: readonly { deviceId: number }[]) => void
    }) => (
      <button
        type="button"
        data-testid="fake-device-picker"
        onClick={() => props.onChange([{ deviceId: 11 }, { deviceId: 12 }])}
      />
    ),
  }
})

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

  it('an automation list offers the choose step, and so does a branch list, without code', () => {
    render(<Harness flow initial={[CHOOSE]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Choose')
    fireEvent.click(screen.getByRole('option', { name: 'Choose' }))
    const branch = within(screen.getByTestId('choose-branch-0-0'))
    fireEvent.click(branch.getByRole('button', { name: 'Step' }))
    fireEvent.click(branch.getByTestId('step-kind-0'))
    const inner = screen.getAllByRole('option').map((o) => o.textContent)
    expect(inner).toEqual(
      expect.arrayContaining([
        'Wait',
        'Stop the run',
        'Set variables',
        'Choose',
        'Repeat',
        'At the same time',
        'Wait until',
      ]),
    )
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

describe('ActionList parallel (#500)', () => {
  const PARALLEL: AutomationAction = { kind: 'parallel', steps: [] }

  it('is offered in an automation list and nowhere else', () => {
    render(<Harness flow initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('At the same time')
  })

  it('is not offered where the list is not an automation', () => {
    render(<Harness flow={false} initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain(
      'At the same time',
    )
  })

  it('holds commands, actions and waits only, and stops adding at five', () => {
    render(<Harness flow initial={[PARALLEL]} />)
    const box = within(screen.getByTestId('parallel-steps-0'))
    const add = box.getByRole('button', { name: 'Step' })
    for (let i = 0; i < 5; i++) fireEvent.click(add)
    expect(latest[0]).toMatchObject({ kind: 'parallel' })
    expect(latest[0]?.kind === 'parallel' ? latest[0].steps.length : 0).toBe(5)
    expect(box.getByRole('button', { name: 'Step' })).toHaveProperty('disabled', true)
    fireEvent.click(box.getByTestId('step-kind-0'))
    const inner = screen.getAllByRole('option').map((o) => o.textContent)
    expect(inner).toEqual(expect.arrayContaining(['Wait', 'Run an action']))
    expect(inner).not.toContain('Stop the run')
    expect(inner).not.toContain('Set variables')
    expect(inner).not.toContain('At the same time')
  })
})

describe('ActionList repeat (#500)', () => {
  const REPEAT: AutomationAction = { kind: 'repeat', loop: { by: 'count', count: 2 }, steps: [] }
  const pick = (testId: string, name: string): void => {
    fireEvent.click(screen.getByTestId(testId))
    fireEvent.click(screen.getByRole('option', { name }))
  }

  it('is offered in an automation list only', () => {
    render(<Harness flow initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Repeat')
  })

  it('is not offered where the list is not an automation', () => {
    render(<Harness flow={false} initial={[CAP]} />)
    fireEvent.click(screen.getByTestId('step-kind-0'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain('Repeat')
  })

  it('keeps the count between 1 and 20', () => {
    render(<Harness flow initial={[REPEAT]} />)
    fireEvent.change(screen.getByTestId('repeat-count-0'), { target: { value: '99' } })
    expect(latest[0]).toMatchObject({ loop: { by: 'count', count: 20 } })
  })

  it('a loop on a condition always carries its maximum, kept at 50 or less', () => {
    render(<Harness flow initial={[REPEAT]} />)
    pick('repeat-by-0', 'While a condition is true')
    expect(latest[0]).toMatchObject({ loop: { by: 'while', maxIterations: 10 } })
    fireEvent.change(screen.getByTestId('repeat-max-0'), { target: { value: '400' } })
    expect(latest[0]).toMatchObject({ loop: { by: 'while', maxIterations: 50 } })
    fireEvent.change(screen.getByTestId('repeat-wait-0'), { target: { value: '30' } })
    expect(latest[0]).toMatchObject({ loop: { waitS: 30 } })
    fireEvent.change(screen.getByTestId('repeat-wait-0'), { target: { value: '' } })
    expect(latest[0]?.kind === 'repeat' ? latest[0].loop : null).not.toHaveProperty('waitS')
  })

  it('a loop over devices stores the picked device ids', () => {
    render(<Harness flow initial={[REPEAT]} />)
    pick('repeat-by-0', 'Once for each device')
    fireEvent.click(screen.getByTestId('fake-device-picker'))
    expect(latest[0]).toMatchObject({
      loop: { by: 'forEach', target: { kind: 'devices', ids: [11, 12] } },
    })
  })

  it('a command inside a loop over devices is told the devices of the loop; no other command is', () => {
    render(<Harness flow initial={[CAP, { ...REPEAT, steps: [CAP] }]} />)
    const body = within(screen.getByTestId('repeat-steps-1'))
    expect(body.getByTestId('fake-command').getAttribute('data-round')).toBe('none')
    pick('repeat-by-1', 'Once for each device')
    expect(body.getByTestId('fake-command').getAttribute('data-round')).toBe('')
    fireEvent.click(screen.getByTestId('fake-device-picker'))
    expect(body.getByTestId('fake-command').getAttribute('data-round')).toBe('11,12')
    const outside = screen
      .getAllByTestId('fake-command')
      .filter((el) => !screen.getByTestId('repeat-steps-1').contains(el))
    expect(outside.map((el) => el.getAttribute('data-round'))).toEqual(['none'])
  })

  it('its steps are ten at most and may be block steps, never code', () => {
    render(<Harness flow initial={[REPEAT]} />)
    const box = within(screen.getByTestId('repeat-steps-0'))
    const add = box.getByRole('button', { name: 'Step' })
    for (let i = 0; i < 10; i++) fireEvent.click(add)
    expect(latest[0]?.kind === 'repeat' ? latest[0].steps.length : 0).toBe(10)
    expect(box.getByRole('button', { name: 'Step' })).toHaveProperty('disabled', true)
    fireEvent.click(box.getByTestId('step-kind-0'))
    const inner = screen.getAllByRole('option').map((o) => o.textContent)
    expect(inner).toEqual(
      expect.arrayContaining(['Wait', 'Stop the run', 'Set variables', 'Repeat', 'Choose']),
    )
    expect(inner).not.toContain('Run code')
  })
})

describe('ActionList, two levels of block steps (#500)', () => {
  const pick = (box: ReturnType<typeof within>, testId: string, name: string): void => {
    fireEvent.click(box.getByTestId(testId))
    fireEvent.click(screen.getByRole('option', { name }))
  }
  const REPEAT: AutomationAction = {
    kind: 'repeat',
    loop: { by: 'count', count: 2 },
    steps: [{ kind: 'wait', seconds: 1 }],
  }

  it('a step of a repeat becomes a choose and is kept, with its own steps', () => {
    render(<Harness flow initial={[REPEAT]} />)
    const body = within(screen.getByTestId('repeat-steps-0'))
    pick(body, 'step-kind-0', 'Choose')
    expect(latest[0]).toMatchObject({ kind: 'repeat', steps: [{ kind: 'choose' }] })
    const branch = within(body.getByTestId('choose-branch-0-0'))
    fireEvent.click(branch.getByRole('button', { name: 'Step' }))
    expect(latest[0]).toMatchObject({
      kind: 'repeat',
      steps: [{ kind: 'choose', branches: [{ steps: [{ kind: 'cap' }] }] }],
    })
  })

  it('the steps of that inner choose are plain: no third level is offered', () => {
    const inner: AutomationAction = {
      kind: 'repeat',
      loop: { by: 'count', count: 2 },
      steps: [
        {
          kind: 'choose',
          branches: [{ if: { kind: 'all', children: [] }, steps: [{ kind: 'wait', seconds: 1 }] }],
        },
      ],
    }
    render(<Harness flow initial={[inner]} />)
    const branch = within(
      within(screen.getByTestId('repeat-steps-0')).getByTestId('choose-branch-0-0'),
    )
    fireEvent.click(branch.getByTestId('step-kind-0'))
    const kinds = screen.getAllByRole('option').map((o) => o.textContent)
    expect(kinds).toEqual(expect.arrayContaining(['Wait', 'Stop the run', 'Set variables']))
    for (const block of ['Choose', 'Repeat', 'At the same time', 'Wait until', 'Run code']) {
      expect(kinds).not.toContain(block)
    }
  })

  it('a repeat inside the branch of a choose is kept and edits its count', () => {
    const choose: AutomationAction = {
      kind: 'choose',
      branches: [{ if: { kind: 'all', children: [] }, steps: [{ kind: 'wait', seconds: 1 }] }],
    }
    render(<Harness flow initial={[choose]} />)
    const branch = within(screen.getByTestId('choose-branch-0-0'))
    pick(branch, 'step-kind-0', 'Repeat')
    fireEvent.change(branch.getByTestId('repeat-count-0'), { target: { value: '4' } })
    expect(latest[0]).toMatchObject({
      kind: 'choose',
      branches: [{ steps: [{ kind: 'repeat', loop: { by: 'count', count: 4 } }] }],
    })
  })

  it('a command two levels inside a loop over devices still knows the devices of the loop', () => {
    const loop: AutomationAction = {
      kind: 'repeat',
      loop: { by: 'forEach', target: { kind: 'devices', ids: [11, 12] } },
      steps: [
        {
          kind: 'choose',
          branches: [{ if: { kind: 'all', children: [] }, steps: [CAP] }],
        },
      ],
    }
    render(<Harness flow initial={[loop]} />)
    expect(screen.getByTestId('fake-command').getAttribute('data-round')).toBe('11,12')
  })
})
