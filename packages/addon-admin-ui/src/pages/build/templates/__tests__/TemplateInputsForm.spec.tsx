/**
 * The inputs form of the shipped "Buttons → devices" template: one card per
 * button, titled by what the button reads; inside it the events and the
 * actions are lists of one-line entries that grow and shrink on their own.
 * Every device is picked with the one device picker; an action only chooses
 * what the already-picked devices do.
 */

import {
  BUILTIN_AUTOMATION_TEMPLATES,
  type TemplateInputValues,
  type TemplateInstanceProblem,
} from '@camstack/types'
import type { PickedDeviceAction, PickedDeviceEvent } from '@camstack/ui-library'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { TemplateInputsForm } from '../TemplateInputsForm'
import { initialValues } from '../template-values'

vi.mock('../../automation/automation-data', () => ({
  useAutomationDevices: () => [],
}))

vi.mock('../../automation/FiredFields', () => ({
  FiredFields: () => <div data-testid="fired-fields" />,
}))

interface FakeEventsProps {
  readonly testId?: string
  readonly value: readonly PickedDeviceEvent[]
  readonly onChange: (next: readonly PickedDeviceEvent[]) => void
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    DeviceValuePicker: (props: { readonly testId?: string }) => (
      <div data-testid={props.testId ?? 'device-picker'} data-picker="shared" />
    ),
    DeviceEventPicker: (props: FakeEventsProps) => (
      <button
        type="button"
        data-testid={props.testId}
        data-picks={JSON.stringify(props.value)}
        onClick={() =>
          props.onChange([...props.value, { deviceId: 9, sourceId: '2', eventId: 'press_long' }])
        }
      />
    ),
    useDeviceLabelById: (id: number) => `Device ${String(id)}`,
    useDeviceStateGetCapSlice: () => ({ status: 'pending', data: undefined }),
  }
})

interface FakeActionsProps {
  readonly testId?: string
  readonly value: readonly PickedDeviceAction[]
  readonly onChange: (next: readonly PickedDeviceAction[]) => void
}

vi.mock('../TemplateActionPicker', () => ({
  TemplateActionPicker: (props: FakeActionsProps) => (
    <div data-testid={props.testId} data-picks={JSON.stringify(props.value)}>
      <button
        type="button"
        data-testid="fake-add-action"
        onClick={() =>
          props.onChange([
            ...props.value,
            { deviceIds: [304], action: { actionId: 'light.turn_on' } },
          ])
        }
      />
      <button
        type="button"
        data-testid="fake-remove-action"
        onClick={() => props.onChange(props.value.slice(1))}
      />
    </div>
  ),
  ActionEditor: () => <div data-testid="action-editor" />,
}))

const BUTTONS = BUILTIN_AUTOMATION_TEMPLATES.find((t) => t.id === 'builtin:buttons-to-devices')
if (BUTTONS === undefined) throw new Error('the buttons template is not built in')
const PAYLOAD = BUTTONS.payload

interface HarnessProps {
  readonly start: TemplateInputValues
  readonly problems?: readonly TemplateInstanceProblem[]
  readonly onValues: (next: TemplateInputValues) => void
}

function Harness({ start, problems = [], onValues }: HarnessProps): ReactNode {
  const [values, setValues] = useState(start)
  return (
    <TemplateInputsForm
      payload={PAYLOAD}
      values={values}
      problems={problems}
      onChange={(next) => {
        setValues(next)
        onValues(next)
      }}
    />
  )
}

const FILLED_COMMANDS = [
  { targets: [302], action: { actionId: 'switch.toggle' } },
  { targets: [303], action: { actionId: 'switch.turn_off' } },
]

const FILLED: TemplateInputValues = {
  buttons: [
    {
      events: [{ button: 301, event: { eventIds: ['press_short'] } }],
      commands: [
        { targets: [302], action: { actionId: 'switch.toggle' } },
        { targets: [303], action: { actionId: 'switch.turn_off' } },
      ],
    },
  ],
}

describe('the Buttons → devices form', () => {
  it('starts as one card named "New button" with one events field and one actions field', () => {
    render(<Harness start={initialValues(PAYLOAD)} onValues={vi.fn()} />)
    expect(screen.getAllByTestId('template-group-buttons-row')).toHaveLength(1)
    expect(screen.getByTestId('template-group-buttons-summary').textContent).toBe('New button')
    expect(screen.getByTestId('template-input-buttons.0.events').getAttribute('data-picks')).toBe(
      '[]',
    )
    expect(screen.getByTestId('template-input-buttons.0.commands').getAttribute('data-picks')).toBe(
      '[]',
    )
    expect(screen.getByTestId('template-group-buttons-add').textContent).toContain('Add button')
  })

  it('titles a card by the device its events read, then what fires', () => {
    render(<Harness start={FILLED} onValues={vi.fn()} />)
    expect(screen.getByTestId('template-group-buttons-summary').textContent).toBe(
      'Device 301 · press_short',
    )
  })

  it('draws the actions of a button as one field: an entry is a {targets, action} row', () => {
    const onValues = vi.fn()
    render(<Harness start={FILLED} onValues={onValues} />)
    const field = screen.getByTestId('template-input-buttons.0.commands')
    expect(JSON.parse(field.getAttribute('data-picks') ?? '')).toEqual([
      { deviceIds: [302], action: { actionId: 'switch.toggle' } },
      { deviceIds: [303], action: { actionId: 'switch.turn_off' } },
    ])
    expect(screen.queryByTestId('template-nested-buttons.0.commands-add')).toBeNull()
    fireEvent.click(screen.getByTestId('fake-add-action'))
    expect(onValues).toHaveBeenLastCalledWith({
      buttons: [
        {
          events: [{ button: 301, event: { eventIds: ['press_short'] } }],
          commands: [
            ...FILLED_COMMANDS,
            { targets: [304], action: { actionId: 'light.turn_on' } },
          ],
        },
      ],
    })
  })

  it('removes the entry asked for', () => {
    const onValues = vi.fn()
    render(<Harness start={FILLED} onValues={onValues} />)
    fireEvent.click(screen.getByTestId('fake-remove-action'))
    expect(onValues).toHaveBeenLastCalledWith({
      buttons: [
        {
          events: [{ button: 301, event: { eventIds: ['press_short'] } }],
          commands: [{ targets: [303], action: { actionId: 'switch.turn_off' } }],
        },
      ],
    })
  })

  it('draws the events of a button as one field: a pick is a row of that device and event', () => {
    const onValues = vi.fn()
    render(<Harness start={FILLED} onValues={onValues} />)
    const field = screen.getByTestId('template-input-buttons.0.events')
    expect(JSON.parse(field.getAttribute('data-picks') ?? '')).toEqual([
      { deviceId: 301, eventId: 'press_short' },
    ])
    expect(screen.queryByTestId('template-nested-buttons.0.events-add')).toBeNull()
    fireEvent.click(field)
    expect(onValues).toHaveBeenLastCalledWith({
      buttons: [
        {
          events: [
            { button: 301, event: { eventIds: ['press_short'] } },
            { button: 9, event: { eventIds: ['press_long'], sourceIds: ['2'] } },
          ],
          commands: FILLED_COMMANDS,
        },
      ],
    })
  })

  it('shows a problem under the field its address names', () => {
    const problems: readonly TemplateInstanceProblem[] = [
      {
        code: 'missing-input',
        input: 'buttons.0.commands.1.targets',
        detail: 'Devices is required',
      },
    ]
    render(<Harness start={FILLED} problems={problems} onValues={vi.fn()} />)
    const nested = screen.getByTestId('template-nested-buttons.0.commands')
    expect(within(nested).getByRole('alert').textContent).toBe('Devices is required')
  })
})

describe('the optional "Only when" window', () => {
  it('starts without a value and without fields: no limit', () => {
    render(<Harness start={FILLED} onValues={vi.fn()} />)
    expect(screen.getByTestId('template-input-active-limit').getAttribute('aria-checked')).toBe(
      'false',
    )
    expect(screen.queryByTestId('time-is-fields')).toBeNull()
  })

  it('opens the automation editor time fields and stores {between, days}, then clears on off', () => {
    const onValues = vi.fn()
    render(<Harness start={FILLED} onValues={onValues} />)
    fireEvent.click(screen.getByTestId('template-input-active-limit'))
    expect(screen.getByTestId('time-is-fields')).toBeTruthy()
    expect(onValues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: {
          between: { from: { kind: 'clock', hh: 22, mm: 0 }, to: { kind: 'clock', hh: 6, mm: 0 } },
        },
      }),
    )
    const firstDay = within(screen.getByRole('group', { name: 'Days' })).getAllByRole('button')[0]
    if (firstDay === undefined) throw new Error('no day buttons')
    fireEvent.click(firstDay)
    expect(onValues.mock.lastCall?.[0].active).toMatchObject({
      days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    })
    fireEvent.click(screen.getByTestId('template-input-active-limit'))
    expect('active' in onValues.mock.lastCall?.[0]).toBe(false)
    expect(screen.queryByTestId('time-is-fields')).toBeNull()
  })
})
