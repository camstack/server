// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MobileDrawer } from '../mobile-drawer'

describe('MobileDrawer', () => {
  it('renders no viewport-sized backdrop while closed', () => {
    // A closed, `opacity-0` full-screen layer still dims and (on iOS WebKit)
    // blurs the non-scrolling chrome beneath it — the mobile top bar.
    const { container } = render(
      <MobileDrawer open={false} onClose={vi.fn()}>
        <span>nav</span>
      </MobileDrawer>,
    )
    expect(container.querySelector('.inset-0')).toBeNull()
  })

  it('renders a backdrop that closes the drawer while open, without a backdrop filter', () => {
    const onClose = vi.fn()
    const { container } = render(
      <MobileDrawer open onClose={onClose}>
        <span>nav</span>
      </MobileDrawer>,
    )
    const backdrop = container.querySelector<HTMLElement>('.inset-0')
    expect(backdrop).not.toBeNull()
    expect(backdrop?.className).not.toMatch(/backdrop-blur/)
    backdrop?.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
