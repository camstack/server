import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormSaveBar } from '../form-save-bar'

describe('FormSaveBar', () => {
  it('renders nothing when no change is pending', () => {
    const { container } = render(
      <FormSaveBar pendingCount={0} onSave={() => undefined} onDiscard={() => undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('says how many changes are pending and fires Save and Discard', () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(<FormSaveBar pendingCount={2} onSave={onSave} onDiscard={onDiscard} />)
    expect(screen.getByText('2 unsaved changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('disables both buttons while saving', () => {
    render(
      <FormSaveBar pendingCount={1} saving onSave={() => undefined} onDiscard={() => undefined} />,
    )
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('sits on an opaque surface, never a tinted see-through fill', () => {
    render(<FormSaveBar pendingCount={1} onSave={() => undefined} onDiscard={() => undefined} />)
    const bar = screen.getByText('1 unsaved change').parentElement
    expect(bar?.className).toContain('bg-surface')
    expect(bar?.className).not.toMatch(/bg-primary\/\d+/)
  })
})
