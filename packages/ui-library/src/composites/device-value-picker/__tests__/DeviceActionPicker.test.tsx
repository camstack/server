// @vitest-environment jsdom
/**
 * The device picker's action mode: devices first, then the action they share;
 * confirming stores one entry, an entry reopens on itself, and × removes it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PickedDeviceAction } from '../DeviceActionPicker'

vi.mock('../device-value-panel', () => ({
  DeviceValuePanel: (props: { readonly onSelect: (v: { deviceId: number }) => void }) => (
    <button
      type="button"
      data-testid="pick-device"
      onClick={() => props.onSelect({ deviceId: 7 })}
    />
  ),
}))

const { DeviceActionPicker } = await import('../DeviceActionPicker')

function Harness({
  start,
  onValue,
}: {
  readonly start: readonly PickedDeviceAction[]
  readonly onValue: (next: readonly PickedDeviceAction[]) => void
}): ReactNode {
  const [value, setValue] = useState(start)
  return (
    <DeviceActionPicker
      testId="actions"
      value={value}
      useEntryLabel={(pick) => ({ label: `${pick.action.actionId} · ${pick.deviceIds.join(',')}` })}
      renderEditor={(editor) => (
        <button
          type="button"
          data-testid="choose-action"
          onClick={() => editor.onChange({ actionId: 'switch.toggle' })}
        />
      )}
      onChange={(next) => {
        setValue(next)
        onValue(next)
      }}
    />
  )
}

afterEach(cleanup)

describe('DeviceActionPicker', () => {
  it('adds one entry: the devices, then the action, then confirm', () => {
    const onValue = vi.fn()
    render(<Harness start={[]} onValue={onValue} />)
    fireEvent.click(screen.getByRole('button', { name: /add action/i }))
    fireEvent.click(screen.getByTestId('pick-device'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('dap-confirm')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('choose-action'))
    fireEvent.click(screen.getByTestId('dap-confirm'))
    expect(onValue).toHaveBeenLastCalledWith([
      { deviceIds: [7], action: { actionId: 'switch.toggle' } },
    ])
    expect(screen.getByText('switch.toggle · 7')).toBeTruthy()
  })

  it('reopens an entry on its action and replaces it', () => {
    const onValue = vi.fn()
    render(
      <Harness
        start={[{ deviceIds: [7], action: { actionId: 'switch.turn_off' } }]}
        onValue={onValue}
      />,
    )
    fireEvent.click(screen.getByText('switch.turn_off · 7'))
    fireEvent.click(screen.getByTestId('choose-action'))
    fireEvent.click(screen.getByTestId('dap-confirm'))
    expect(onValue).toHaveBeenLastCalledWith([
      { deviceIds: [7], action: { actionId: 'switch.toggle' } },
    ])
  })

  it('removes an entry', () => {
    const onValue = vi.fn()
    render(
      <Harness
        start={[{ deviceIds: [7], action: { actionId: 'switch.turn_off' } }]}
        onValue={onValue}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onValue).toHaveBeenLastCalledWith([])
  })
})
