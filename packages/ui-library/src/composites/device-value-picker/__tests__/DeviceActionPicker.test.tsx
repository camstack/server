// @vitest-environment jsdom
/**
 * The device picker's action mode: devices first, then the action they share;
 * confirming stores one entry, an entry reopens on itself, and × removes it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationCommandStep } from '@camstack/types'

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

const OFF: AutomationCommandStep = {
  kind: 'command',
  target: { kind: 'devices', ids: [7] },
  actionId: 'switch.off',
}

function Harness({
  start,
  onValue,
}: {
  readonly start: readonly AutomationCommandStep[]
  readonly onValue: (next: readonly AutomationCommandStep[]) => void
}): ReactNode {
  const [value, setValue] = useState(start)
  return (
    <DeviceActionPicker
      testId="actions"
      value={value}
      useEntryLabel={(step) => ({ label: `${step.actionId} · ${JSON.stringify(step.target)}` })}
      renderEditor={(editor) => (
        <button
          type="button"
          data-testid="choose-action"
          onClick={() =>
            editor.onChange({ kind: 'command', target: editor.target, actionId: 'switch.toggle' })
          }
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
      { kind: 'command', target: { kind: 'devices', ids: [7] }, actionId: 'switch.toggle' },
    ])
    expect(screen.getByText('switch.toggle · {"kind":"devices","ids":[7]}')).toBeTruthy()
  })

  it('adds a domain step from "By room/type": no device list, a domain target', () => {
    const onValue = vi.fn()
    render(<Harness start={[]} onValue={onValue} />)
    fireEvent.click(screen.getByRole('button', { name: /add action/i }))
    fireEvent.click(screen.getByRole('tab', { name: 'By room/type' }))
    expect(screen.queryByTestId('pick-device')).toBeNull()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByTestId('choose-action'))
    fireEvent.click(screen.getByTestId('dap-confirm'))
    expect(onValue).toHaveBeenLastCalledWith([
      { kind: 'command', target: { kind: 'domain' }, actionId: 'switch.toggle' },
    ])
  })

  it('reopens an entry on its action and replaces it', () => {
    const onValue = vi.fn()
    render(
      <Harness
        start={[OFF]}
        onValue={onValue}
      />,
    )
    fireEvent.click(screen.getByText('switch.off · {"kind":"devices","ids":[7]}'))
    fireEvent.click(screen.getByTestId('choose-action'))
    fireEvent.click(screen.getByTestId('dap-confirm'))
    expect(onValue).toHaveBeenLastCalledWith([
      { kind: 'command', target: { kind: 'devices', ids: [7] }, actionId: 'switch.toggle' },
    ])
  })

  it('removes an entry', () => {
    const onValue = vi.fn()
    render(
      <Harness
        start={[OFF]}
        onValue={onValue}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onValue).toHaveBeenLastCalledWith([])
  })
})
