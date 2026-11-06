import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DeviceValueField, type DeviceValueFieldProps } from '../device-value-field'

vi.mock('../../device-picker/DevicePicker', () => ({
  DevicePicker: (p: {
    devices: readonly { id: number; name: string }[]
    onChange: (ids: number[]) => void
  }) => (
    <div>
      {p.devices.map((d) => (
        <button key={d.id} type="button" onClick={() => p.onChange([d.id])}>
          {d.name}
        </button>
      ))}
    </div>
  ),
}))

const GROUPS = [
  {
    cap: 'power-meter',
    title: 'Power',
    rows: [{ cap: 'power-meter', path: 'power', label: 'Power', valueText: '8.4 W' }],
  },
  { cap: 'empty', title: 'Nothing', rows: [] },
]

function props(over: Partial<DeviceValueFieldProps> = {}): DeviceValueFieldProps {
  return {
    devices: [{ id: 1, name: 'Porch meter' }],
    listState: 'answered',
    deviceId: null,
    onDeviceChange: () => undefined,
    deviceLabel: 'Porch meter',
    valuesState: 'ready',
    groups: GROUPS,
    value: null,
    onValueChange: () => undefined,
    heading: 'Source',
    backLabel: 'Back',
    noDeviceText: 'Pick a device',
    noValuesText: 'No fitting value',
    ...over,
  }
}

function Stateful({ extra }: { readonly extra: Partial<DeviceValueFieldProps> }) {
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [value, setValue] = useState<DeviceValueFieldProps['value']>(null)
  return (
    <DeviceValueField
      {...props({
        ...extra,
        deviceId,
        onDeviceChange: setDeviceId,
        value,
        onValueChange: (pick) => {
          setValue(pick)
          extra.onValueChange?.(pick)
        },
      })}
    />
  )
}

describe('DeviceValueField', () => {
  it('draws only the rows it is given and no empty group', () => {
    render(<DeviceValueField {...props({ deviceId: 1 })} />)
    expect(screen.getByTestId('device-value-power-meter.power')).toBeTruthy()
    expect(screen.queryByText('Nothing')).toBeNull()
    expect(screen.queryByText(/incompatible/i)).toBeNull()
  })

  it('walks the three phone steps and stays on values with nothing to preview', () => {
    const onValue = vi.fn()
    const { rerender } = render(
      <Stateful extra={{ onValueChange: onValue, transform: <i>t</i> }} />,
    )
    const root = screen.getByTestId('device-value-field')
    expect(root.getAttribute('data-step')).toBe('devices')
    fireEvent.click(screen.getByRole('button', { name: 'Porch meter' }))
    expect(root.getAttribute('data-step')).toBe('values')
    fireEvent.click(screen.getByTestId('device-value-power-meter.power'))
    expect(onValue).toHaveBeenCalledWith({ cap: 'power-meter', path: 'power' })
    expect(root.getAttribute('data-step')).toBe('preview')
    fireEvent.click(screen.getByTestId('device-value-field-back'))
    expect(root.getAttribute('data-step')).toBe('values')
    rerender(<Stateful key="plain" extra={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Porch meter' }))
    fireEvent.click(screen.getByTestId('device-value-power-meter.power'))
    expect(screen.getByTestId('device-value-field').getAttribute('data-step')).toBe('values')
  })

  it('does not open the preview step while the pick has not been taken as the value', () => {
    render(
      <DeviceValueField
        {...props({ deviceId: 1, transform: <i>t</i>, onValueChange: () => undefined })}
      />,
    )
    fireEvent.click(screen.getByTestId('device-value-power-meter.power'))
    expect(screen.getByTestId('device-value-field').getAttribute('data-step')).toBe('values')
  })

  it('never reads an unanswered device as empty', () => {
    render(<DeviceValueField {...props({ deviceId: 1, valuesState: 'loading', groups: [] })} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByText('No fitting value')).toBeNull()
  })
})
