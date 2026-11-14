/**
 * The action of a command whose devices are chosen elsewhere: it offers what
 * those devices can do, stores the picked action, and offers nothing — rather
 * than "no action" — while their bindings have not answered (D315).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { CommandActionField } from '../CommandActionField'

const caps = { data: undefined as ReadonlyMap<number, readonly string[]> | undefined }

vi.mock('../../../../components/device-do-action/use-device-bound-caps', () => ({
  useDevicesBoundCaps: () => ({ data: caps.data }),
}))

const DEVICES = [{ id: 7, name: 'Lamp', stableId: 's7', type: 'switch' }]

beforeEach(() => {
  caps.data = new Map([[7, ['switch']]])
})

describe('CommandActionField', () => {
  it('offers the actions of the chosen devices and stores the one picked', () => {
    const onChange = vi.fn()
    render(
      <CommandActionField
        deviceIds={[7]}
        devices={DEVICES}
        value={undefined}
        testId="action"
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByTestId('action'))
    fireEvent.click(screen.getByRole('option', { name: 'Toggle' }))
    expect(onChange).toHaveBeenCalledWith({ actionId: 'switch.toggle' })
  })

  it('offers nothing while the devices have not said what they can do', () => {
    caps.data = undefined
    render(
      <CommandActionField
        deviceIds={[7]}
        devices={DEVICES}
        value={{ actionId: 'switch.toggle' }}
        testId="action"
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('action')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('action').textContent).toContain('Reading what these devices can do')
  })
})
