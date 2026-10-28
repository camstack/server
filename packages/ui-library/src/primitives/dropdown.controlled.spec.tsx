/**
 * Dropdown: uncontrolled by default; with `open` + `onOpenChange` the owner
 * decides (a "{" typed in a field opens the list without a click on the trigger).
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from './dropdown'

function Controlled() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        outside
      </button>
      <Dropdown open={open} onOpenChange={setOpen}>
        <DropdownTrigger>menu</DropdownTrigger>
        <DropdownContent>
          <DropdownItem onClick={() => setOpen(false)}>first</DropdownItem>
        </DropdownContent>
      </Dropdown>
    </div>
  )
}

describe('Dropdown controlled open', () => {
  it('opens from outside and closes through onOpenChange', () => {
    render(<Controlled />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByText('outside'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('still opens from its own trigger when uncontrolled', () => {
    render(
      <Dropdown>
        <DropdownTrigger>menu</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>first</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    )
    act(() => {
      fireEvent.click(screen.getByText('menu'))
    })
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})
