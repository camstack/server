// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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
})
