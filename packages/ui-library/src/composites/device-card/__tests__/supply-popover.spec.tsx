// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SupplyChip } from '../shell/BottomLine'
import type { CardSupply } from '../shell/model'

function open(supply: CardSupply, readOnly = false) {
  const onAction = vi.fn()
  render(<SupplyChip supply={supply} readOnly={readOnly} onAction={onAction} />)
  fireEvent.click(screen.getByRole('button', { name: /Laundry/ }))
  return onAction
}

const button = (name: string): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement

describe('SupplyChip popover', () => {
  it('draws the three commands as one button group', () => {
    open({ name: 'Laundry', state: 'on' })
    const group = screen.getByTestId('dc-supply-actions')
    expect(group.getAttribute('role')).toBe('group')
    expect(group.querySelectorAll('button')).toHaveLength(3)
  })

  it('disables the command the supply is already in, and sends the others', () => {
    const onAction = open({ name: 'Laundry', state: 'on' })
    expect(button('Turn on').disabled).toBe(true)
    fireEvent.click(button('Turn off'))
    fireEvent.click(button('Restart'))
    expect(onAction.mock.calls).toEqual([['off'], ['restart']])
  })

  it('disables everything while it restarts', () => {
    open({ name: 'Laundry', state: 'restarting' })
    for (const n of ['Turn on', 'Turn off', 'Restart']) expect(button(n).disabled).toBe(true)
  })

  it('hides on/off but keeps restart when the switch is not settable', () => {
    open({ name: 'Laundry', state: 'on', settable: false })
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull()
    expect(button('Restart').disabled).toBe(false)
  })

  it('is read only for a viewer without permission', () => {
    open({ name: 'Laundry', state: 'off' }, true)
    for (const n of ['Turn on', 'Turn off', 'Restart']) expect(button(n).disabled).toBe(true)
  })
})
