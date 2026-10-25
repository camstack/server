// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Trash2, RefreshCw } from 'lucide-react'
import { IconAction } from '../icon-action'

describe('IconAction (absorbed condensation helper)', () => {
  it('renders an icon-only button with an accessible label (aria-label + title)', () => {
    render(<IconAction icon={RefreshCw} label="Reboot" onClick={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Reboot' })
    expect(btn.getAttribute('title')).toBe('Reboot')
    // Label is NOT visible text — only the svg icon renders inside.
    expect(btn.textContent).toBe('')
    expect(btn.querySelector('svg')).not.toBeNull()
  })

  it('invokes onClick', () => {
    const onClick = vi.fn()
    render(<IconAction icon={RefreshCw} label="Reboot" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('danger keeps the red (text-danger) treatment', () => {
    render(<IconAction icon={Trash2} label="Delete" onClick={() => {}} danger />)
    const btn = screen.getByRole('button', { name: 'Delete' })
    expect(btn.className).toContain('text-danger')
  })

  it('non-danger uses the subtle (non-red) treatment', () => {
    render(<IconAction icon={RefreshCw} label="Reboot" onClick={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Reboot' })
    expect(btn.className).toContain('text-foreground-subtle')
    expect(btn.className).not.toContain('text-danger')
  })
})
