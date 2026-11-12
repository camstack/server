/**
 * A command step inside a repeat over devices can be aimed at "the device of
 * this round" (#500): it is stored as the `item` variable, and it offers only
 * the commands every device of the loop has.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationDevice } from '../../automation/automation-data'
import type { CapStep } from '../command-vocab'

const BOUND = new Map<number, readonly string[]>([
  [11, ['pet-feeder', 'switch']],
  [12, ['switch']],
])

vi.mock('../../../../components/device-do-action/use-device-bound-caps', () => ({
  useDeviceBoundCaps: () => ({ data: undefined, isError: false }),
  useDevicesBoundCaps: (ids: readonly number[]) => ({
    data: ids.length === 0 ? undefined : BOUND,
    isError: false,
  }),
}))
vi.mock('../../../../components/device-do-action/DeviceDoActionFields', () => ({
  DeviceDoActionFields: () => <span data-testid="generic-fields" />,
}))
vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    DeviceValuePicker: () => <span data-testid="single-device-picker" />,
    OptionSelect: (props: {
      readonly options: readonly { readonly value: string; readonly label: string }[]
      readonly onChange: (value: string) => void
    }) => (
      <div data-testid="command-options">
        {props.options.map((o) => (
          <button key={o.value} type="button" onClick={() => props.onChange(o.value)}>
            {o.value}
          </button>
        ))}
      </div>
    ),
  }
})

import { CommandStep } from '../CommandStep'

const DEVICES: readonly AutomationDevice[] = [
  { id: 11, name: 'Feeder', stableId: 'feeder' },
  { id: 12, name: 'Lamp', stableId: 'lamp' },
]
const FRESH: CapStep = { kind: 'cap', deviceId: 0, cap: '', method: '' }
const ROUND: CapStep = { kind: 'cap', deviceId: { $var: 'item' }, cap: '', method: '' }

function mount(step: CapStep, roundDevices?: readonly number[]) {
  const onChange = vi.fn<(next: CapStep) => void>()
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

describe('CommandStep, the device of this round (#500)', () => {
  it('is not offered outside a repeat over devices', () => {
    mount(FRESH)
    expect(screen.queryByTestId('command-step-round')).toBeNull()
  })

  it('switching it on aims the step at the item variable', () => {
    const onChange = mount(FRESH, [11, 12])
    fireEvent.click(screen.getByTestId('command-step-round'))
    expect(onChange).toHaveBeenCalledWith(ROUND)
  })

  it('offers only the commands every device of the loop has, and writes the pick on the variable', () => {
    const onChange = mount(ROUND, [11, 12])
    expect(screen.queryByTestId('single-device-picker')).toBeNull()
    const offered = screen.getByTestId('command-options').querySelectorAll('button')
    const ids = [...offered].map((b) => b.textContent ?? '')
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => id.startsWith('switch:'))).toBe(true)
    const first = offered[0]
    if (first === undefined) throw new Error('no command offered')
    fireEvent.click(first)
    const written = onChange.mock.calls[0]?.[0]
    expect(written?.deviceId).toEqual({ $var: 'item' })
    expect(written?.cap).toBe('switch')
  })

  it('switching it off gives the step back to a single device', () => {
    const onChange = mount(ROUND, [11, 12])
    fireEvent.click(screen.getByTestId('command-step-round'))
    expect(onChange).toHaveBeenCalledWith(FRESH)
  })

  it('says to pick the devices of the loop first when the list is empty', () => {
    mount(ROUND, [])
    expect(screen.getByTestId('command-step-round-empty')).toBeTruthy()
    expect(screen.getByTestId('command-options').querySelectorAll('button').length).toBe(0)
  })

  it('a step on the item variable outside a loop keeps the generic row', () => {
    mount(ROUND)
    expect(screen.getByTestId('generic-fields')).toBeTruthy()
  })
})
