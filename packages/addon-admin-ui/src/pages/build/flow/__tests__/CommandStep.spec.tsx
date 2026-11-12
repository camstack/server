/**
 * A command step reads as one sentence with a Change button; Change opens the
 * device modal in action mode, whose open args are step 3: Confirm stays off
 * until they are complete, and writes `{ kind: 'command', target, actionId, args }`.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationDevice } from '../../automation/automation-data'
import type { CommandStep as CommandStepValue } from '../command-vocab'
import type { ActionPickDraft } from '../../../../components/device/customize/source-selector/SourceSelectorAction'

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  ItemFormDialog: (props: { readonly children: ReactNode; readonly footer: ReactNode }) => (
    <div data-testid="dialog">
      {props.children}
      {props.footer}
    </div>
  ),
}))

vi.mock('../DynamicArgField', async () => {
  const { ArgField } = await import('../ArgField')
  return { DynamicArgField: ArgField }
})

const roundSeen: { value: readonly number[] | undefined } = { value: undefined }

vi.mock('../../../../components/device/customize/source-selector/SourceSelectorAction', () => ({
  SourceSelectorAction: (props: {
    readonly value: ActionPickDraft
    readonly onChange: (next: ActionPickDraft) => void
    readonly roundDevices?: readonly number[]
    readonly args?: ReactNode
  }) => {
    roundSeen.value = props.roundDevices
    return (
      <div>
        <button
          type="button"
          data-testid="pick-feeder-feed"
          onClick={() =>
            props.onChange({ target: { kind: 'devices', ids: [11] }, actionId: 'petFeeder.feed' })
          }
        />
        <button
          type="button"
          data-testid="pick-trigger-on"
          onClick={() =>
            props.onChange({ target: { kind: 'var', name: 'deviceId' }, actionId: 'switch.on' })
          }
        />
        {props.value.actionId !== null && props.value.target !== null && props.args}
      </div>
    )
  },
}))

import { CommandStep } from '../CommandStep'

const DEVICES: readonly AutomationDevice[] = [
  { id: 11, name: 'Feeder', stableId: 'feeder', type: 'pet-feeder' },
  { id: 12, name: 'Kitchen blind', stableId: 'blind', type: 'cover' },
]

function mount(step: CommandStepValue, roundDevices?: readonly number[]) {
  const onChange = vi.fn<(next: CommandStepValue) => void>()
  render(
    <CommandStep
      step={step}
      devices={DEVICES}
      variables={[]}
      onChange={onChange}
      {...(roundDevices === undefined ? {} : { roundDevices })}
    />,
  )
  return onChange
}

const FRESH: CommandStepValue = {
  kind: 'command',
  target: { kind: 'devices', ids: [] },
  actionId: '',
}

describe('CommandStep', () => {
  it('reads a stored step as its sentence, with the device and the arg filled in', () => {
    mount({
      kind: 'command',
      target: { kind: 'devices', ids: [12] },
      actionId: 'cover.position',
      args: { position: 40 },
    })
    const phrase = screen.getByTestId('command-step-phrase').textContent ?? ''
    expect(phrase).toContain('Kitchen blind')
    expect(phrase).toContain('40')
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('names the device that triggered the run in the sentence', () => {
    mount({ kind: 'command', target: { kind: 'var', name: 'deviceId' }, actionId: 'switch.on' })
    expect(screen.getByTestId('command-step-phrase').textContent).not.toContain('{device}')
  })

  it('a fresh step opens the modal; Confirm waits for complete args, then writes by action id', () => {
    const onChange = mount(FRESH)
    const confirm = () => screen.getByTestId('command-picker-confirm')
    expect(confirm().hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('pick-feeder-feed'))
    const grams = screen.getByTestId('arg-grams').querySelector('input')
    if (grams === null) throw new Error('no grams field')
    fireEvent.change(grams, { target: { value: '1000000' } })
    expect(confirm().hasAttribute('disabled')).toBe(true)
    fireEvent.change(grams, { target: { value: '30' } })
    expect(confirm().hasAttribute('disabled')).toBe(false)
    fireEvent.click(confirm())
    expect(onChange).toHaveBeenCalledWith({
      kind: 'command',
      target: { kind: 'devices', ids: [11] },
      actionId: 'petFeeder.feed',
      args: { grams: 30 },
      argUnits: { grams: 'g' },
    })
  })

  it('a command with no open args is ready at once, aimed at the trigger device', () => {
    const onChange = mount(FRESH)
    fireEvent.click(screen.getByTestId('pick-trigger-on'))
    fireEvent.click(screen.getByTestId('command-picker-confirm'))
    expect(onChange).toHaveBeenCalledWith({
      kind: 'command',
      target: { kind: 'var', name: 'deviceId' },
      actionId: 'switch.on',
    })
  })

  it('Change on a stored step opens the modal; the loop devices reach it', () => {
    mount(
      { kind: 'command', target: { kind: 'devices', ids: [12] }, actionId: 'cover.open' },
      [11, 12],
    )
    fireEvent.click(screen.getByTestId('command-step-change'))
    expect(screen.getByTestId('dialog')).toBeTruthy()
    expect(roundSeen.value).toEqual([11, 12])
  })
})
