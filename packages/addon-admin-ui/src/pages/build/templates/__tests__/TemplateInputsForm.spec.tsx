/**
 * A template action that names a sibling device input is one Command field:
 * the dialog picks the command and its devices together, and one change
 * writes both stored keys. The payload shape does not change.
 */

import {
  type AutomationTemplatePayload,
  AutomationTemplatePayloadSchema,
  type TemplateInputValues,
  type TemplateInstanceProblem,
} from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import type { CommandStepProps } from '../../flow/CommandStep'
import { TemplateInputsForm } from '../TemplateInputsForm'

vi.mock('../../automation/automation-data', () => ({
  useAutomationDevices: () => [],
}))

vi.mock('../../automation/FiredFields', () => ({
  FiredFields: () => <div data-testid="fired-fields" />,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    DeviceValuePicker: (props: { readonly testId?: string }) => (
      <div data-testid={props.testId ?? 'device-picker'} />
    ),
  }
})

vi.mock('../../flow/CommandStep', () => ({
  CommandStep: (props: CommandStepProps) => {
    const ids = props.step.target.kind === 'devices' ? props.step.target.ids.join(',') : ''
    return (
      <div data-testid="command-step">
        <span data-testid="command-step-action">{props.step.actionId}</span>
        <span data-testid="command-step-targets">{ids}</span>
        <span data-testid="command-step-single">{String(props.singleTarget === true)}</span>
        <button
          type="button"
          data-testid="command-step-pick"
          onClick={() =>
            props.onChange({
              kind: 'command',
              target: { kind: 'devices', ids: [10, 11] },
              actionId: 'light.turn_on',
            })
          }
        />
      </div>
    )
  },
}))

const STORED: TemplateInputValues = {
  buttons: [
    {
      button: 42,
      event: { kinds: ['press'] },
      targets: [5767],
      action: { actionId: 'switch.toggle' },
    },
  ],
}

function payload(raw: unknown): AutomationTemplatePayload {
  return AutomationTemplatePayloadSchema.parse(raw)
}

const BUTTONS = payload({
  version: 1,
  body: { when: { kind: 'any', children: [] }, actions: [] },
  inputs: [
    {
      kind: 'group',
      key: 'buttons',
      label: 'Buttons',
      inputs: [
        { kind: 'device', key: 'button', label: 'Button', filter: { capability: 'event-emitter' } },
        { kind: 'event', key: 'event', label: 'Event', deviceInput: 'button' },
        { kind: 'device', key: 'targets', label: 'Devices', multiple: true },
        { kind: 'action', key: 'action', label: 'Action', deviceInput: 'targets' },
      ],
    },
  ],
  bindings: [],
})

interface HarnessProps {
  readonly formPayload: AutomationTemplatePayload
  readonly initial: TemplateInputValues
  readonly problems?: readonly TemplateInstanceProblem[]
}

function Harness({ formPayload, initial, problems = [] }: HarnessProps): ReactNode {
  const [values, setValues] = useState(initial)
  return (
    <>
      <pre data-testid="values">{JSON.stringify(values)}</pre>
      <TemplateInputsForm
        payload={formPayload}
        values={values}
        problems={problems}
        onChange={setValues}
      />
    </>
  )
}

describe('TemplateInputsForm command pair', () => {
  it('renders one Command field for a devices + action pair and keeps a stored row', () => {
    render(<Harness formPayload={BUTTONS} initial={STORED} />)
    expect(screen.getAllByTestId('command-step')).toHaveLength(1)
    expect(screen.getByText('Command')).toBeTruthy()
    expect(screen.queryByTestId('template-input-buttons.0.targets')).toBeNull()
    expect(screen.getByTestId('template-input-buttons.0.button')).toBeTruthy()
    expect(screen.getByTestId('command-step-action').textContent).toBe('switch.toggle')
    expect(screen.getByTestId('command-step-targets').textContent).toBe('5767')
    expect(screen.getByTestId('command-step-single').textContent).toBe('false')
  })

  it('writes the device ids and the action from one pick, and keeps the other row keys', () => {
    render(<Harness formPayload={BUTTONS} initial={STORED} />)
    fireEvent.click(screen.getByTestId('command-step-pick'))
    expect(JSON.parse(screen.getByTestId('values').textContent ?? '')).toEqual({
      buttons: [
        {
          button: 42,
          event: { kinds: ['press'] },
          targets: [10, 11],
          action: { actionId: 'light.turn_on' },
        },
      ],
    })
  })

  it('shows problems of either key on the combined field', () => {
    render(
      <Harness
        formPayload={BUTTONS}
        initial={STORED}
        problems={[
          { code: 'missing-input', input: 'buttons.0.targets', detail: 'Devices are required.' },
          { code: 'invalid-input', input: 'buttons.0.action', detail: 'The action is unknown.' },
        ]}
      />,
    )
    expect(screen.getByText('Devices are required. The action is unknown.')).toBeTruthy()
  })

  it('leaves a lone action input, and a filtered device, as their own fields', () => {
    const lone = payload({
      version: 1,
      body: { when: { kind: 'any', children: [] }, actions: [] },
      inputs: [{ kind: 'action', key: 'action', label: 'Do something' }],
      bindings: [],
    })
    const { unmount } = render(<Harness formPayload={lone} initial={{}} />)
    expect(screen.getByText('Do something')).toBeTruthy()
    expect(screen.queryByText('Command')).toBeNull()
    expect(screen.getAllByTestId('command-step')).toHaveLength(1)
    unmount()

    const filtered = payload({
      version: 1,
      body: { when: { kind: 'any', children: [] }, actions: [] },
      inputs: [
        {
          kind: 'device',
          key: 'lights',
          label: 'Lights',
          multiple: true,
          filter: { capability: 'switch' },
        },
        { kind: 'action', key: 'action', label: 'Action', deviceInput: 'lights' },
      ],
      bindings: [],
    })
    render(
      <Harness
        formPayload={filtered}
        initial={{ lights: [3], action: { actionId: 'switch.on' } }}
      />,
    )
    expect(screen.getByTestId('template-input-lights')).toBeTruthy()
    expect(screen.getByText('Action')).toBeTruthy()
    expect(screen.queryByText('Command')).toBeNull()
    expect(screen.getByTestId('command-step-targets').textContent).toBe('3')
  })

  it('passes singleTarget when the device input takes one device', () => {
    const single = payload({
      version: 1,
      body: { when: { kind: 'any', children: [] }, actions: [] },
      inputs: [
        { kind: 'device', key: 'light', label: 'Light' },
        { kind: 'action', key: 'action', label: 'Action', deviceInput: 'light' },
      ],
      bindings: [],
    })
    render(
      <Harness formPayload={single} initial={{ light: 9, action: { actionId: 'switch.on' } }} />,
    )
    expect(screen.queryByTestId('template-input-light')).toBeNull()
    expect(screen.getByTestId('command-step-single').textContent).toBe('true')
    expect(screen.getByTestId('command-step-targets').textContent).toBe('9')
    fireEvent.click(screen.getByTestId('command-step-pick'))
    expect(JSON.parse(screen.getByTestId('values').textContent ?? '')).toEqual({
      light: 10,
      action: { actionId: 'light.turn_on' },
    })
  })
})
