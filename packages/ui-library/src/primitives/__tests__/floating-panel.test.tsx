// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Bell } from 'lucide-react'

import { FloatingPanel } from '../floating-panel'

function panelOf(container: HTMLElement): HTMLElement {
  const panel = container.firstElementChild
  if (!(panel instanceof HTMLElement)) throw new Error('panel root not rendered')
  return panel
}

describe('FloatingPanel', () => {
  it('renders the title and content', () => {
    render(
      <FloatingPanel title="Logs" onClose={() => {}}>
        <p>body</p>
      </FloatingPanel>,
    )
    expect(screen.getByText('Logs')).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('renders the optional icon in the title bar', () => {
    const { container } = render(
      <FloatingPanel title="Events" icon={Bell} onClose={() => {}}>
        x
      </FloatingPanel>,
    )
    expect(container.querySelector('svg.lucide-bell')).not.toBeNull()
  })

  it('places itself at the controlled position and reports drag steps', () => {
    const onPositionChange = vi.fn()
    const { container } = render(
      <FloatingPanel
        title="Logs"
        position={{ x: 120, y: 140 }}
        onPositionChange={onPositionChange}
        onClose={() => {}}
      >
        x
      </FloatingPanel>,
    )
    const panel = panelOf(container)
    expect(panel.style.left).toBe('120px')
    expect(panel.style.top).toBe('140px')

    const titleBar = screen.getByText('Logs').closest('div[class*="cursor-move"]')
    if (titleBar === null) throw new Error('title bar not rendered')
    fireEvent.mouseDown(titleBar, { clientX: 130, clientY: 150 })
    fireEvent.mouseMove(window, { clientX: 180, clientY: 200 })
    expect(onPositionChange).toHaveBeenLastCalledWith({ x: 170, y: 190 })
  })

  it('applies the controlled size', () => {
    const { container } = render(
      <FloatingPanel title="Logs" size={{ w: 400, h: 480 }} onClose={() => {}}>
        x
      </FloatingPanel>,
    )
    const panel = panelOf(container)
    expect(panel.style.width).toBe('400px')
    expect(panel.style.height).toBe('480px')
  })
})
