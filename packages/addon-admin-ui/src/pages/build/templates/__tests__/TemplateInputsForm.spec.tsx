/**
 * The inputs form of the shipped "Buttons → devices" template: one card per
 * button, titled by what the button reads; inside it the events and the
 * actions are lists of one-line entries that grow and shrink on their own.
 * Every device is picked with the one device picker; an action only chooses
 * what the already-picked devices do.
 */

import {
  type AutomationCommandStep,
  BUILTIN_AUTOMATION_TEMPLATES,
  type DeviceFiredLeaf,
  DeviceType,
  type TemplateInputValues,
  type TemplateInstanceProblem,
} from '@camstack/types'
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
  readonly value: readonly DeviceFiredLeaf[]
  readonly onChange: (next: readonly DeviceFiredLeaf[]) => void
}

const FIRED: DeviceFiredLeaf = {
  kind: 'device-fired',
  id: 'ev-1',
  deviceId: 301,
  sourceIds: ['1'],
  eventIds: ['press_short'],
}
const LONG: DeviceFiredLeaf = {
  kind: 'device-fired',
  id: 'ev-2',
  deviceId: 9,
  sourceIds: ['2'],
  eventIds: ['press_long'],
}
const TOGGLE: AutomationCommandStep = {
  kind: 'command',
  target: { kind: 'devices', ids: [302] },
  actionId: 'switch.toggle',
}
const ROOM_OFF: AutomationCommandStep = {
  kind: 'command',
  target: { kind: 'domain', deviceType: DeviceType.Light, roomId: 'Kitchen' },
  actionId: 'switch.off',
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
        onClick={() => props.onChange([...props.value, LONG])}
      />
    ),
    useDeviceLabelById: (id: number) => `Device ${String(id)}`,
    useDeviceStateGetCapSlice: () => ({ status: 'pending', data: undefined }),
  }
})

interface FakeActionsProps {
  readonly testId?: string
  readonly value: readonly AutomationCommandStep[]
  readonly onChange: (next: readonly AutomationCommandStep[]) => void
}

vi.mock('../TemplateActionPicker', () => ({
  TemplateActionPicker: (props: FakeActionsProps) => (
    <div data-testid={props.testId} data-picks={JSON.stringify(props.value)}>
      <button
        type="button"
        data-testid="fake-add-action"
        onClick={() => props.onChange([...props.value, ROOM_OFF])}
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

const FILLED: TemplateInputValues = { buttons: [{ when: [FIRED], do: [TOGGLE] }] }

describe('the Buttons → devices form', () => {
  it('starts as one card named "New button" with one trigger field and one step field', () => {
    render(<Harness start={initialValues(PAYLOAD)} onValues={vi.fn()} />)
    expect(screen.getAllByTestId('template-group-buttons-row')).toHaveLength(1)
    expect(screen.getByTestId('template-group-buttons-summary').textContent).toBe('New button')
    expect(screen.getByTestId('template-input-buttons.0.when').getAttribute('data-picks')).toBe('[]')
    expect(screen.getByTestId('template-input-buttons.0.do').getAttribute('data-picks')).toBe('[]')
    expect(screen.getByTestId('template-group-buttons-add').textContent).toContain('Add button')
  })

  it('titles a card by the device its triggers read, then what fires', () => {
    render(<Harness start={FILLED} onValues={vi.fn()} />)
    expect(screen.getByTestId('template-group-buttons-summary').textContent).toBe(
      'Device 301 · 1 · press_short',
    )
  })

  it('stores a command step verbatim, domain target included, beside the others', () => {
    const onValues = vi.fn()
    render(<Harness start={FILLED} onValues={onValues} />)
    expect(JSON.parse(screen.getByTestId('template-input-buttons.0.do').getAttribute('data-picks') ?? '')).toEqual([TOGGLE])
    fireEvent.click(screen.getByTestId('fake-add-action'))
    expect(onValues).toHaveBeenLastCalledWith({
      buttons: [{ when: [FIRED], do: [TOGGLE, ROOM_OFF] }],
    })
  })

  it('removes the entry asked for', () => {
    const onValues = vi.fn()
    render(<Harness start={{ buttons: [{ when: [FIRED], do: [TOGGLE, ROOM_OFF] }] }} onValues={onValues} />)
    fireEvent.click(screen.getByTestId('fake-remove-action'))
    expect(onValues).toHaveBeenLastCalledWith({ buttons: [{ when: [FIRED], do: [ROOM_OFF] }] })
  })

  it('stores a trigger as a whole device-fired leaf, its id kept', () => {
    const onValues = vi.fn()
    render(<Harness start={FILLED} onValues={onValues} />)
    const field = screen.getByTestId('template-input-buttons.0.when')
    expect(JSON.parse(field.getAttribute('data-picks') ?? '')).toEqual([FIRED])
    fireEvent.click(field)
    expect(onValues).toHaveBeenLastCalledWith({
      buttons: [{ when: [FIRED, LONG], do: [TOGGLE] }],
    })
  })

  it('shows a problem under the field its address names', () => {
    const problems: readonly TemplateInstanceProblem[] = [
      { code: 'missing-input', input: 'buttons.0.do', detail: 'add at least one' },
    ]
    render(<Harness start={FILLED} problems={problems} onValues={vi.fn()} />)
    expect(screen.getByText('add at least one')).toBeTruthy()
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
