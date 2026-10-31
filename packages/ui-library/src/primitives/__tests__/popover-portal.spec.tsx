// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Popover, PopoverTrigger, PopoverContent } from '../popover'

describe('PopoverContent portal', () => {
  it('mounts content on document.body outside an overflow ancestor', () => {
    render(
      <div style={{ overflow: 'hidden', height: 20 }}>
        <Popover>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Menu body</PopoverContent>
        </Popover>
      </div>,
    )
    fireEvent.click(screen.getByText('Open'))
    const body = screen.getByText('Menu body')
    expect(document.body.contains(body)).toBe(true)
    expect(body.closest('[style*="overflow"]')).toBeNull()
  })

  it('mounts inside the enclosing <dialog> so a modal dialog does not hide or disable it', () => {
    const showPopover = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value: showPopover,
    })
    render(
      <dialog open>
        <Popover>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Menu body</PopoverContent>
        </Popover>
      </dialog>,
    )
    fireEvent.click(screen.getByText('Open'))
    const body = screen.getByText('Menu body')
    expect(body.closest('dialog')).not.toBeNull()
    expect(body.closest('[popover="manual"]')).not.toBeNull()
    expect(showPopover).toHaveBeenCalled()
    Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
  })

  it('Escape closes the popover and is marked handled so a dialog around it stays open', () => {
    render(
      <dialog open>
        <Popover>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Menu body</PopoverContent>
        </Popover>
      </dialog>,
    )
    fireEvent.click(screen.getByText('Open'))
    const notPrevented = fireEvent.keyDown(document, { key: 'Escape' })
    expect(notPrevented).toBe(false)
    expect(screen.queryByText('Menu body')).toBeNull()
  })
})
